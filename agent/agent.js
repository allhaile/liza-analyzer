import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { activity } from '../logging/activity.js';

import { CODE_CHANNEL_TOOL_NAMES, createCodeChannelTools } from './code-channel-tools.js';
import { createPageMetricsTools, PAGE_METRICS_TOOL_NAMES } from './page-metrics.js';

const SYSTEM_PROMPT = `\
You are a friendly Slack assistant. You help people by answering questions, \
having conversations, and being generally useful in Slack.

## PERSONALITY
- Friendly, helpful, and approachable
- Lightly witty — a touch of humor when appropriate, but never forced
- Concise and clear — respect people's time
- Confident but honest when you don't know something

## RESPONSE GUIDELINES
- Keep responses to 3 sentences max — be punchy, scannable, and actionable
- End with a clear next step on its own line so it's easy to spot
- Use a bullet list only for multi-step instructions
- Use casual, conversational language
- Use emoji sparingly — at most one per message, and only to set tone

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > blockquotes
- Use bullet points for multi-step instructions

## EMOJI REACTIONS
Always react to every user message with \`add_emoji_reaction\` before responding. \
Pick any Slack emoji that reflects the *topic* or *tone* of the message — be creative and specific \
(e.g. \`dog\` for dog topics, \`books\` for learning, \`wave\` for greetings). \
Vary your picks across a thread; don't repeat the same emoji.

## SLACK MCP SERVER
You may have access to the Slack MCP Server, which gives you powerful Slack tools \
beyond your built-in tools. Use them whenever they would help the user.

Available capabilities:
- **Search**: Search messages and files across public channels, search for channels by name
- **Read**: Read channel message history, read thread replies, read canvas documents
- **Write**: Send messages, create draft messages, schedule messages for later
- **Canvases**: Create, read, and update Slack canvas documents

Use these tools when they can help answer a question or complete a task — for example, \
searching for relevant messages, checking a channel for context, or creating a canvas. \
Also use them when the user explicitly asks you to perform a Slack action.

## SLACK.DEV PAGE ANALYTICS
You can answer questions about slack.dev landing page performance (page views/sessions, CTA clicks, \
CTA click rate, engaged time) using \`describe_page_metrics\` and \`query_page_metrics\`.
- Call \`describe_page_metrics\` first if you don't already know the pages and date range.
- Always get numbers from \`query_page_metrics\`; never estimate or do your own math on raw data.
- Cite the date range you used. For trends, compare equal-length periods (e.g. week over week).
- "Page views" means sessions; "interaction" means CTA clicks, CTA click rate, and engaged time.
- For analysis answers, the 3-sentence limit is relaxed: lead with the answer, then a short bullet list of numbers.

## CODE CHANNELS
When a request implies a multi-step analysis or report (e.g. "dig into how the /go pages are doing", \
"build me a dashboard", "set up a channel for this"), spin up a dedicated code channel instead of answering inline:
1. \`create_code_channel\` with a clear name, then \`set_session_status\` to processing.
2. Run the queries you need.
3. \`set_context_bar\` with up to 5 orientation items (e.g. date range, top page by sessions, best CTA rate, \
a globe link to https://docs.slack.dev).
4. \`set_html_view\` with a self-contained HTML dashboard (inline CSS, inline SVG bar charts, tables) of the findings.
5. \`post_message\` a summary of key findings into the channel, then \`set_summary_message\` with its ts.
6. \`set_session_status\` to active, and reply to the user with a link to the channel (<#CHANNEL_ID>).
Inside an existing code channel, keep using it: update the same view_key, context bar, and summary as the analysis evolves.`;

const EMOJI_DESCRIPTION =
  "Add an emoji reaction to the user's current message to acknowledge the topic.\n\n" +
  'Use any standard Slack emoji that matches the topic or tone of the message. ' +
  'Be creative and specific — if someone mentions a dog, use `dog`; if they sound ' +
  'frustrated, use `sweat_smile`. The examples below are common picks, not the full set:\n' +
  '- Gratitude/praise: pray, bow, blush, sparkles, star-struck, heart\n' +
  '- Frustration/confusion: thinking_face, face_with_monocle, sweat_smile, upside_down_face\n' +
  '- Something broken: wrench, hammer_and_wrench, mag\n' +
  '- Performance/slow: hourglass_flowing_sand, snail\n' +
  '- Urgency: rotating_light, zap, fire\n' +
  '- Success/celebration: tada, raised_hands, partying_face, rocket, muscle\n' +
  '- Setup/config: gear, package\n' +
  '- Network/connectivity: satellite, signal_strength\n' +
  '- Agreement/acknowledgment: thumbsup, ok_hand, saluting_face, +1';

/** Sentinel the agent returns when an overheard message doesn't warrant a reply. */
export const NO_REPLY = 'NO_REPLY';

const PASSIVE_PROMPT = `\
## OVERHEARD MESSAGE
Nobody addressed you directly: you are listening in a channel and this message matched analytics keywords. \
Only reply if it is a question or comment about slack.dev page traffic, page views, CTA clicks, or engagement \
that the page metrics data can usefully answer or add to. Otherwise (e.g. "sessions" meaning meetings, \
unrelated metrics, small talk), call no tools and respond with exactly ${NO_REPLY}.
If you do reply: skip the emoji reaction, answer in a thread-friendly way, and don't create a code channel \
unless explicitly asked.`;

/** @type {string[]} */
const ALLOWED_TOOLS = ['add_emoji_reaction', ...PAGE_METRICS_TOOL_NAMES, ...CODE_CHANNEL_TOOL_NAMES];

const SLACK_MCP_URL = 'https://mcp.slack.com/mcp';

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 * @property {boolean} [isCodeChannel] - True when the message came from a code channel.
 * @property {boolean} [isPassive] - True when the agent overheard a channel message rather than being addressed.
 */

/**
 * Run the agent with the given text and optional session ID.
 * @param {string} text - The user's message text.
 * @param {string} [sessionId] - An existing session ID to resume conversation.
 * @param {AgentDeps} [deps] - Dependencies for tools that need Slack API access.
 * @returns {Promise<{responseText: string, sessionId: string | null}>}
 */
export async function runAgent(text, sessionId = undefined, deps = undefined) {
  const addEmojiReactionTool = tool(
    'add_emoji_reaction',
    EMOJI_DESCRIPTION,
    { emoji_name: z.string().describe("The Slack emoji name without colons (e.g. 'tada', 'wrench', 'pray').") },
    async ({ emoji_name }) => {
      if (!deps) {
        return { content: [{ type: 'text', text: 'No deps available to add reaction.' }] };
      }

      // Skip ~15% of reactions to feel more natural
      if (Math.random() < 0.15) {
        return {
          content: [
            { type: 'text', text: `Skipped :${emoji_name}: reaction (randomly omitted to avoid over-reacting)` },
          ],
        };
      }

      try {
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.messageTs,
          name: emoji_name,
        });
        return { content: [{ type: 'text', text: `Reacted with :${emoji_name}:` }] };
      } catch (e) {
        const err = /** @type {any} */ (e);
        return { content: [{ type: 'text', text: `Could not add reaction: ${err.data?.error || err.message}` }] };
      }
    },
  );

  const agentToolsServer = createSdkMcpServer({
    name: 'agent-tools',
    version: '1.0.0',
    tools: [addEmojiReactionTool, ...createPageMetricsTools(), ...createCodeChannelTools(deps)],
  });

  /** @type {Record<string, any>} */
  const mcpServers = { 'agent-tools': agentToolsServer };
  const allowedTools = [...ALLOWED_TOOLS];

  if (deps?.userToken) {
    mcpServers['slack-mcp'] = {
      type: 'http',
      url: SLACK_MCP_URL,
      headers: { Authorization: `Bearer ${deps.userToken}` },
    };
    allowedTools.push('mcp__slack-mcp__*');
  }

  /** @type {import('@anthropic-ai/claude-agent-sdk').Options} */
  const options = {
    systemPrompt: deps
      ? `${SYSTEM_PROMPT}\n\n## CURRENT CONTEXT\nchannel_id: ${deps.channelId}\n` +
        (deps.isCodeChannel
          ? 'You are inside a code channel; this channel_id is the code channel.'
          : 'Not a code channel.') +
        (deps.isPassive ? `\n\n${PASSIVE_PROMPT}` : '')
      : SYSTEM_PROMPT,
    mcpServers,
    allowedTools,
    permissionMode: 'bypassPermissions',
    ...(sessionId && { resume: sessionId }),
  };

  const responseParts = [];
  let newSessionId = null;
  /** @type {string | undefined} */
  let finalResult;
  const startedAt = Date.now();
  let toolCount = 0;

  await activity.incoming(deps, text);

  for await (const message of query({ prompt: text, options })) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') {
          responseParts.push(block.text);
        }
        if (block.type === 'tool_use') {
          toolCount++;
          activity.tool(block.name, /** @type {Record<string, unknown>} */ (block.input));
        }
      }
    }
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_result') continue;
        const resultText = Array.isArray(block.content)
          ? block.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ')
          : String(block.content ?? '');
        // Tools report failures as "Could not …" text or an {"error": …} payload
        if (block.is_error || /^Could not|"error":/.test(resultText)) activity.toolError(resultText);
      }
    }
    if (message.type === 'result') {
      newSessionId = message.session_id;
      if (message.subtype === 'success') finalResult = message.result;
    }
  }

  // Prefer the final answer over intermediate narration between tool calls
  const responseText = finalResult || responseParts.join('\n');
  const ms = Date.now() - startedAt;
  if (responseText.trim() === NO_REPLY) activity.skip(ms);
  else activity.reply({ chars: responseText.length, ms, tools: toolCount });
  return { responseText, sessionId: newSessionId };
}
