import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const CONTEXT_BAR_ICONS = /** @type {const} */ ([
  'branch',
  'folder',
  'hierarchy',
  'life-ring',
  'link',
  'globe',
  'terminal',
  'code',
  'search',
  'lock',
]);

const SESSION_STATUSES = /** @type {const} */ (['active', 'processing', 'suspended', 'closed']);

/**
 * @param {string} text
 */
const textResult = (text) => ({ content: [{ type: /** @type {const} */ ('text'), text }] });

/**
 * @param {unknown} e
 */
const slackError = (e) => {
  const err = /** @type {any} */ (e);
  return err.data?.error || err.message;
};

/**
 * Build the code channel tools as closures over the Slack deps.
 * The agents.* methods aren't typed in @slack/web-api yet, so they go through apiCall.
 * @param {import('./agent.js').AgentDeps} [deps]
 */
export function createCodeChannelTools(deps) {
  const createCodeChannel = tool(
    'create_code_channel',
    'Create a dedicated Slack code channel for an analysis session, linked back to the message that started it. ' +
      'The requesting user is invited automatically. Returns the new channel ID for use with the other code channel tools.',
    {
      name: z.string().max(200).describe('Friendly display name, e.g. "Landing page performance: Aug–Oct".'),
    },
    async ({ name }) => {
      if (!deps) return textResult('No deps available to create a code channel.');

      try {
        const res = /** @type {{channel_id?: string}} */ (
          await deps.client.apiCall('agents.conversations.create', {
            name,
            session_id: `${deps.channelId}:${deps.threadTs}`,
            origin_channel_id: deps.channelId,
            origin_message_ts: deps.messageTs,
          })
        );
        return textResult(`Created code channel <#${res.channel_id}> (id: ${res.channel_id}).`);
      } catch (e) {
        if (slackError(e) !== 'invalid_origin_link') {
          return textResult(`Could not create code channel: ${slackError(e)}`);
        }
      }

      // Origins like DMs can't be linked; create unlinked and invite the requester ourselves
      try {
        const res = /** @type {{channel_id?: string}} */ (
          await deps.client.apiCall('agents.conversations.create', {
            name,
            session_id: `${deps.channelId}:${deps.threadTs}`,
          })
        );
        const channelId = /** @type {string} */ (res.channel_id);
        await deps.client.conversations.invite({ channel: channelId, users: deps.userId }).catch((e) => {
          if (slackError(e) !== 'already_in_channel') throw e;
        });
        return textResult(`Created code channel <#${channelId}> (id: ${channelId}) and invited <@${deps.userId}>.`);
      } catch (e) {
        return textResult(`Could not create code channel: ${slackError(e)}`);
      }
    },
  );

  const postMessage = tool(
    'post_message',
    'Post a message to a code channel. Returns the message ts, which can be passed to set_summary_message.',
    {
      channel_id: z.string().describe('The code channel ID.'),
      markdown_text: z.string().describe('The message body in standard Markdown.'),
    },
    async ({ channel_id, markdown_text }) => {
      if (!deps) return textResult('No deps available to post a message.');

      try {
        const res = await deps.client.chat.postMessage({ channel: channel_id, markdown_text });
        return textResult(`Posted message (ts: ${res.ts}) to <#${channel_id}>.`);
      } catch (e) {
        return textResult(`Could not post message: ${slackError(e)}`);
      }
    },
  );

  const setContextBar = tool(
    'set_context_bar',
    'Set the context bar along the top of a code channel (max 5 items). The items you send REPLACE the current set, ' +
      'so resend any items you want to keep. Use it for quick orientation: dataset date range, top page, links.',
    {
      channel_id: z.string().describe('The code channel ID.'),
      items: z
        .array(
          z.object({
            key: z.string().max(64).describe('Unique key within the channel, e.g. "date-range".'),
            label: z.string().max(128).describe('Display text.'),
            icon: z.enum(CONTEXT_BAR_ICONS).optional(),
            url: z.string().url().max(2048).optional().describe('Makes the item a link.'),
          }),
        )
        .max(5),
    },
    async ({ channel_id, items }) => {
      if (!deps) return textResult('No deps available to set the context bar.');

      try {
        await deps.client.apiCall('agents.conversations.setProperties', {
          channel_id,
          code_channel: { context_bar_items: items },
        });
        return textResult(`Set ${items.length} context bar item(s).`);
      } catch (e) {
        return textResult(`Could not set context bar: ${slackError(e)}`);
      }
    },
  );

  const setSummaryMessage = tool(
    'set_summary_message',
    "Record which message in a code channel is the session's current summary.",
    {
      channel_id: z.string().describe('The code channel ID.'),
      message_ts: z.string().describe('ts of the summary message (from post_message).'),
    },
    async ({ channel_id, message_ts }) => {
      if (!deps) return textResult('No deps available to set the summary message.');

      try {
        await deps.client.apiCall('agents.conversations.setProperties', {
          channel_id,
          code_channel: { summary_message: { message_ts } },
        });
        return textResult(`Summary message set to ${message_ts}.`);
      } catch (e) {
        return textResult(`Could not set summary message: ${slackError(e)}`);
      }
    },
  );

  const setHtmlView = tool(
    'set_html_view',
    'Create or update an HTML view tab in a code channel, e.g. a page performance dashboard or report. ' +
      'Calls with the same view_key update the same tab. Content must be a complete, self-contained HTML document ' +
      '(inline CSS/SVG only; no external scripts, fonts, or images).',
    {
      channel_id: z.string().describe('The code channel ID.'),
      view_key: z.string().describe('Stable key for this view, e.g. "page-performance-dashboard".'),
      name: z.string().describe('Tab label, e.g. "Dashboard".'),
      html: z.string().describe('Full self-contained HTML document.'),
    },
    async ({ channel_id, view_key, name, html }) => {
      if (!deps) return textResult('No deps available to set a view.');

      try {
        await deps.client.apiCall('agents.conversations.setView', {
          channel_id,
          type: 'html',
          view_key,
          name,
          content: html,
        });
        return textResult(`View "${name}" saved.`);
      } catch (e) {
        return textResult(`Could not set view: ${slackError(e)}`);
      }
    },
  );

  const setSessionStatus = tool(
    'set_session_status',
    'Set the code channel session status: processing while working, active when waiting on the user, closed when done.',
    {
      channel_id: z.string().describe('The code channel ID.'),
      status: z.enum(SESSION_STATUSES),
    },
    async ({ channel_id, status }) => {
      if (!deps) return textResult('No deps available to set session status.');

      try {
        await deps.client.apiCall('agents.sessions.setStatus', { channel_id, status });
        return textResult(`Session status set to ${status}.`);
      } catch (e) {
        return textResult(`Could not set session status: ${slackError(e)}`);
      }
    },
  );

  const renameSession = tool(
    'rename_session',
    'Rename a code channel session (this also renames the channel).',
    {
      channel_id: z.string().describe('The code channel ID.'),
      title: z.string().min(1).max(200),
    },
    async ({ channel_id, title }) => {
      if (!deps) return textResult('No deps available to rename the session.');

      try {
        await deps.client.apiCall('agents.sessions.rename', { channel_id, title });
        return textResult(`Session renamed to "${title}".`);
      } catch (e) {
        return textResult(`Could not rename session: ${slackError(e)}`);
      }
    },
  );

  return [
    createCodeChannel,
    postMessage,
    setContextBar,
    setSummaryMessage,
    setHtmlView,
    setSessionStatus,
    renameSession,
  ];
}

export const CODE_CHANNEL_TOOL_NAMES = [
  'create_code_channel',
  'post_message',
  'set_context_bar',
  'set_summary_message',
  'set_html_view',
  'set_session_status',
  'rename_session',
];
