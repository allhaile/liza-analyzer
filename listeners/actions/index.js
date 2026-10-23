import { INVESTIGATE_ACTION_PREFIX } from '../views/alert-builder.js';
import { handleAlertDismiss, handleAlertInvestigate, handleAlertSnooze } from './alert-buttons.js';
import { handleFeedbackButton } from './feedback-buttons.js';

/**
 * Register action listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.action('feedback', handleFeedbackButton);
  // Matches the alert button and the digest table's per-row buttons (alert_investigate_0, _1, …)
  app.action(new RegExp(`^${INVESTIGATE_ACTION_PREFIX}(_\\d+)?$`), handleAlertInvestigate);
  app.action('alert_snooze', handleAlertSnooze);
  app.action('alert_dismiss', handleAlertDismiss);
}
