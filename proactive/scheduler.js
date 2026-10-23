import cron from 'node-cron';

import { runWeeklyDigest } from './digest.js';

/**
 * Schedule the weekly digest inside the running app. Call after app.start().
 * Proactive mode stays off (and the app keeps running) when ALERTS_CHANNEL_ID is unset or the schedule is invalid.
 * @param {import('@slack/bolt').App} app
 * @param {{config: import('./config.js').ProactiveConfig, store: import('./state-store.js').ProactiveStore, warnings: string[]}} proactive
 * @returns {import('node-cron').ScheduledTask | null}
 */
export function scheduleWeeklyDigest(app, { config, store, warnings }) {
  for (const warning of warnings) app.logger.warn(`Proactive config: ${warning}`);

  if (!config.alertsChannelId) {
    app.logger.warn('Proactive mode off: ALERTS_CHANNEL_ID is not set, so the weekly digest is skipped.');
    return null;
  }
  if (!cron.validate(config.digestCron)) {
    app.logger.error(`Proactive mode off: DIGEST_CRON "${config.digestCron}" is not a valid cron expression.`);
    return null;
  }

  try {
    const task = cron.schedule(
      config.digestCron,
      () => runWeeklyDigest({ client: app.client, config, store, logger: app.logger }),
      { name: 'weekly-digest', timezone: config.digestTimezone, noOverlap: true },
    );
    app.logger.info(
      `Weekly digest scheduled (${config.digestCron}, ${config.digestTimezone}); ` +
        `next run ${task.getNextRun()?.toISOString() ?? 'unknown'}, posting to ${config.alertsChannelId}.`,
    );
    return task;
  } catch (e) {
    app.logger.error(`Proactive mode off: could not schedule the weekly digest: ${e}`);
    return null;
  }
}
