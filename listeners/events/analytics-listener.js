import { NO_REPLY, runAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

// Cheap prefilter so the agent only runs on messages that plausibly concern slack.dev analytics
const ANALYTICS_PATTERN = new RegExp(
  [
    String.raw`\b(traffic|page ?views?|pageviews?|sessions?|visits?|visitors?|analytics|ga4|metrics?)\b`,
    String.raw`\b(cta|ctr|click[- ]?(through|rate)s?|conversions?|engage(d|ment)|bounce|dwell)\b`,
    String.raw`\b(landing|top|best|worst)[- ]pages?\b`,
    String.raw`/(go|learn|events|open-source)\b`,
  ].join('|'),
  'i',
);

/**
 * @param {string} text
 */
export function isAnalyticsMessage(text) {
  return ANALYTICS_PATTERN.test(text);
}

/**
 * Passively answer an analytics question posted in a channel, replying in a thread.
 * The agent decides whether the message actually warrants a reply and stays silent otherwise.
 * @param {{client: import('@slack/web-api').WebClient, logger: import('@slack/bolt').Logger, sayStream: Function, channelId: string, userId: string, messageTs: string, text: string, userToken?: string}} args
 */
export async function handleAnalyticsChatter({
  client,
  logger,
  sayStream,
  channelId,
  userId,
  messageTs,
  text,
  userToken,
}) {
  try {
    const deps = { client, userId, channelId, threadTs: messageTs, messageTs, userToken, isPassive: true };
    const { responseText, sessionId } = await runAgent(text, undefined, deps);

    if (!responseText || responseText.trim() === NO_REPLY) return;

    const streamer = sayStream();
    await streamer.append({ markdown_text: responseText });
    await streamer.stop({ blocks: buildFeedbackBlocks() });

    // Thread follow-ups continue this conversation via the existing thread-reply handling
    if (sessionId) {
      sessionStore.setSession(channelId, messageTs, sessionId);
    }
  } catch (e) {
    // Stay quiet in-channel for unsolicited replies; just log
    logger.error(`Failed to handle analytics chatter: ${e}`);
  }
}
