import { runAgent } from '../../agent/index.js';
import { METRICS } from '../../proactive/anomalies.js';
import { proactiveStore } from '../../proactive/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { CODE_CHANNEL_SESSION_KEY } from '../events/code-channel.js';
import { ALERT_ACTIONS_BLOCK_ID, formatRange, signedPct, withAlertState } from '../views/alert-builder.js';

const SNOOZE_DAYS = 7;

/**
 * The anomaly an alert's buttons carry (see buildAlertMessage).
 * @typedef {{page: string, page_type: string, metric: keyof typeof METRICS, direction: 'spike' | 'dip', start: string, end: string, base_start: string, base_end: string, pct: number, z: number}} AlertValue
 */

/**
 * @typedef {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockButtonAction>} ButtonArgs
 */

/**
 * @param {ButtonArgs['body']} body
 */
function alertContext(body) {
  return {
    value: /** @type {AlertValue} */ (JSON.parse(body.actions[0].value ?? '{}')),
    channelId: /** @type {string} */ (body.channel?.id),
    messageTs: /** @type {string} */ (body.message?.ts),
    threadTs: /** @type {string} */ (body.message?.thread_ts ?? body.message?.ts),
    blocks: /** @type {any[]} */ (body.message?.blocks ?? []),
    text: /** @type {string} */ (body.message?.text ?? ''),
    fromAlert: body.actions[0].block_id === ALERT_ACTIONS_BLOCK_ID,
  };
}

/**
 * Prompt that seeds the code channel with the alert's page, metric, and date ranges.
 * @param {AlertValue} v
 */
export function buildInvestigatePrompt(v) {
  const metric = METRICS[v.metric].label;
  return `\
A proactive alert flagged \`${v.page}\` (${v.page_type} page): ${metric} ${v.direction === 'spike' ? 'spiked' : 'dipped'} \
${signedPct(v.pct)} vs. its same-weekday baseline (peak z = ${v.z}) from ${v.start} to ${v.end}. \
The baseline is the same weekdays from ${v.base_start} to ${v.base_end}.

Investigate this in a new code channel named "Investigate: ${v.page} ${metric} ${v.direction}". Follow the usual code channel steps:
- Query daily and weekly metrics for ${v.page} from ${v.base_start} to ${v.end}, and compare with the other ${v.page_type} pages over the same dates.
- Context bar: date range ${v.start} to ${v.end}, the page, the metric and its change, and a globe link to https://docs.slack.dev.
- An HTML dashboard of the trend before and during the move, plus how the sibling pages did.
- A summary of what changed and what to check next, set as the summary message.
Skip the emoji reaction. When done, reply with one line linking the channel.`;
}

/**
 * Create a code channel for the alert with the existing code channel tools.
 * @param {ButtonArgs} args
 * @returns {Promise<void>}
 */
export async function handleAlertInvestigate({ ack, body, client, context, logger }) {
  await ack();
  const { value, channelId, messageTs, threadTs, blocks, text, fromAlert } = alertContext(body);
  const userId = /** @type {string} */ (context.userId);
  const status = `:mag: <@${userId}> is investigating \`${value.page}\`. Spinning up a code channel…`;

  try {
    // An alert swaps its buttons for the status; a digest table row keeps the table and notes it in the thread
    if (fromAlert) {
      await client.chat.update({ channel: channelId, ts: messageTs, text, blocks: withAlertState(blocks, status) });
    } else {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: status });
    }

    const deps = { client, userId, channelId, threadTs, messageTs, userToken: context.userToken };
    const { responseText, sessionId } = await runAgent(buildInvestigatePrompt(value), undefined, deps);

    // Follow-ups in the new code channel continue this investigation
    const codeChannelId = responseText.match(/<#([CG][A-Z0-9]+)/)?.[1];
    if (codeChannelId && sessionId) sessionStore.setSession(codeChannelId, CODE_CHANNEL_SESSION_KEY, sessionId);

    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, markdown_text: responseText });
  } catch (e) {
    logger.error(`Failed to investigate alert: ${e}`);
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `:warning: Couldn't start the investigation (${e})`,
      })
      .catch(() => {});
  }
}

/**
 * Snooze alerts for this page and metric for 7 days.
 * @param {ButtonArgs} args
 * @returns {Promise<void>}
 */
export async function handleAlertSnooze({ ack, body, client, context, logger }) {
  await ack();
  const { value, channelId, messageTs, blocks, text } = alertContext(body);

  try {
    const until = new Date(Date.now() + SNOOZE_DAYS * 86_400_000);
    proactiveStore.snooze(value.page, value.metric, until);
    const untilDate = until.toISOString().slice(0, 10);
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks: withAlertState(
        blocks,
        `:zzz: Snoozed by <@${context.userId}>. No ${METRICS[value.metric].label} alerts for \`${value.page}\` until ${formatRange(untilDate, untilDate)}.`,
      ),
    });
  } catch (e) {
    logger.error(`Failed to snooze alert: ${e}`);
  }
}

/**
 * Dismiss this move; a later, separate move on the same page and metric still alerts.
 * @param {ButtonArgs} args
 * @returns {Promise<void>}
 */
export async function handleAlertDismiss({ ack, body, client, context, logger }) {
  await ack();
  const { value, channelId, messageTs, blocks, text } = alertContext(body);

  try {
    proactiveStore.dismiss(value.page, value.metric, value.direction, value.end);
    await client.chat.update({
      channel: channelId,
      ts: messageTs,
      text,
      blocks: withAlertState(blocks, `:white_check_mark: <@${context.userId}> marked this as not an issue.`),
    });
  } catch (e) {
    logger.error(`Failed to dismiss alert: ${e}`);
  }
}
