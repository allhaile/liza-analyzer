import { proactiveConfig, proactiveStore, runWeeklyDigest } from '../../proactive/index.js';

/** @type {Record<string, string>} */
const RESULT_TEXT = {
  'posted-steady': 'All steady, so I posted one short note.',
  'posted-digest': 'Posted the digest.',
  busy: 'A digest is already running. Give it a moment.',
  failed: 'The digest failed; the error is in the alerts channel and the logs.',
};

/**
 * /liza-run-digest: run the weekly digest now, for testing. Posts only to ALERTS_CHANNEL_ID and
 * doesn't count as this week's scheduled run.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackCommandMiddlewareArgs} args
 * @returns {Promise<void>}
 */
export async function handleRunDigestCommand({ ack, client, logger, respond }) {
  await ack();

  const channel = proactiveConfig.alertsChannelId;
  if (!channel) {
    await respond({ response_type: 'ephemeral', text: 'Proactive mode is off. Set `ALERTS_CHANNEL_ID` and restart.' });
    return;
  }

  try {
    await respond({ response_type: 'ephemeral', text: `On it. Running the weekly digest into <#${channel}>…` });
    const result = await runWeeklyDigest({
      client,
      config: proactiveConfig,
      store: proactiveStore,
      logger,
      force: true,
    });
    const detail = result.alerts ? ` (${result.alerts} alert${result.alerts === 1 ? '' : 's'})` : '';
    await respond({ response_type: 'ephemeral', text: `${RESULT_TEXT[result.status] ?? result.status}${detail}` });
  } catch (e) {
    logger.error(`Failed to handle /liza-run-digest: ${e}`);
  }
}
