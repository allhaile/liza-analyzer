import { runAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';

// A code channel is one session, so all of its messages share a single session key
const CODE_CHANNEL_SESSION_KEY = 'code-channel';

/** @type {Map<string, boolean>} */
const codeChannelCache = new Map();

/**
 * Check whether a channel is a code channel via its record_channel property.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} channelId
 * @returns {Promise<boolean>}
 */
export async function isCodeChannel(client, channelId) {
  const cached = codeChannelCache.get(channelId);
  if (cached !== undefined) return cached;

  try {
    const res = await client.conversations.info({ channel: channelId });
    const properties = /** @type {any} */ (res.channel)?.properties;
    const result = properties?.record_channel?.record_type === 'agent_channel';
    codeChannelCache.set(channelId, result);
    return result;
  } catch {
    return false;
  }
}

/**
 * Run the agent for a top-level message in a code channel and reply in the channel.
 * @param {{client: import('@slack/web-api').WebClient, logger: import('@slack/bolt').Logger, channelId: string, userId: string, messageTs: string, text: string, userToken?: string}} args
 */
export async function handleCodeChannelMessage({ client, logger, channelId, userId, messageTs, text, userToken }) {
  const setStatus = (/** @type {string} */ status) =>
    client.apiCall('agents.sessions.setStatus', { channel_id: channelId, status }).catch((e) => {
      logger.warn(`Could not set code channel status to ${status}: ${e}`);
    });

  try {
    await setStatus('processing');

    const existingSessionId = sessionStore.getSession(channelId, CODE_CHANNEL_SESSION_KEY);
    const deps = { client, userId, channelId, threadTs: messageTs, messageTs, userToken, isCodeChannel: true };
    const { responseText, sessionId: newSessionId } = await runAgent(text, existingSessionId ?? undefined, deps);

    if (responseText) {
      await client.chat.postMessage({ channel: channelId, markdown_text: responseText });
    }
    if (newSessionId) {
      sessionStore.setSession(channelId, CODE_CHANNEL_SESSION_KEY, newSessionId);
    }
  } catch (e) {
    logger.error(`Failed to handle code channel message: ${e}`);
    await client.chat.postMessage({ channel: channelId, text: `:warning: Something went wrong! (${e})` });
  } finally {
    await setStatus('active');
  }
}
