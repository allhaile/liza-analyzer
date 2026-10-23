import { loadProactiveConfig } from './config.js';
import { scheduleWeeklyDigest } from './scheduler.js';
import { ProactiveStore } from './state-store.js';

export const { config: proactiveConfig, warnings: proactiveConfigWarnings } = loadProactiveConfig();
export const proactiveStore = new ProactiveStore(proactiveConfig.stateFile);

/**
 * Start the weekly digest schedule with the env-driven config and the shared state store.
 * @param {import('@slack/bolt').App} app
 */
export function startProactiveScheduler(app) {
  return scheduleWeeklyDigest(app, {
    config: proactiveConfig,
    store: proactiveStore,
    warnings: proactiveConfigWarnings,
  });
}

export { runWeeklyDigest } from './digest.js';
