import { handleRunDigestCommand } from './run-digest.js';

/**
 * Register slash command listeners with the Bolt app.
 * @param {import('@slack/bolt').App} app
 * @returns {void}
 */
export function register(app) {
  app.command('/liza-run-digest', handleRunDigestCommand);
}
