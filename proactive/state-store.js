import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { logger } from '../logging/logger.js';
import { addDays } from './anomalies.js';

/**
 * @typedef {Object} ProactiveState
 * @property {string | null} lastDigestKey - ISO week of the last scheduled digest, e.g. "2026-W43".
 * @property {Record<string, string>} snoozes - "page|metric" -> ISO timestamp the snooze ends.
 * @property {Record<string, string>} dismissals - "page|metric|direction" -> end date of the dismissed move.
 */

/**
 * @param {string} page
 * @param {string} metric
 */
const snoozeKey = (page, metric) => `${page}|${metric}`;

/**
 * @param {string} page
 * @param {string} metric
 * @param {string} direction
 */
const dismissKey = (page, metric, direction) => `${page}|${metric}|${direction}`;

/**
 * Small JSON-file store for proactive mode: last digest run, snoozes, and dismissals.
 * Reads once, writes through on every change (atomic rename), so restarts keep state.
 */
export class ProactiveStore {
  /**
   * @param {string} file
   */
  constructor(file) {
    /** @private */
    this._file = file;
    /** @private @type {ProactiveState} */
    this._state = { lastDigestKey: null, snoozes: {}, dismissals: {} };
    try {
      this._state = { ...this._state, ...JSON.parse(readFileSync(file, 'utf8')) };
    } catch (e) {
      // Start fresh rather than crash on a corrupt file; the next write replaces it
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') logger.warn(`Could not read ${file}: ${e}`);
    }
  }

  /** @returns {string | null} */
  getLastDigestKey() {
    return this._state.lastDigestKey;
  }

  /**
   * @param {string} key
   */
  setLastDigestKey(key) {
    this._state.lastDigestKey = key;
    this._save();
  }

  /**
   * @param {string} page
   * @param {string} metric
   * @param {Date} until
   */
  snooze(page, metric, until) {
    this._state.snoozes[snoozeKey(page, metric)] = until.toISOString();
    this._save();
  }

  /**
   * Dismiss one move; a later move on the same page, metric, and direction alerts again.
   * @param {string} page
   * @param {string} metric
   * @param {string} direction
   * @param {string} endDate - Last day of the dismissed move, YYYY-MM-DD.
   */
  dismiss(page, metric, direction, endDate) {
    this._state.dismissals[dismissKey(page, metric, direction)] = endDate;
    this._save();
  }

  /**
   * @param {import('./anomalies.js').Anomaly} anomaly
   * @param {Date} [now]
   */
  isSuppressed(anomaly, now = new Date()) {
    const snoozedUntil = this._state.snoozes[snoozeKey(anomaly.page, anomaly.metric)];
    if (snoozedUntil && new Date(snoozedUntil) > now) return true;
    // Still the same move if it starts no later than the day after the dismissed one ended
    const dismissedEnd = this._state.dismissals[dismissKey(anomaly.page, anomaly.metric, anomaly.direction)];
    return !!dismissedEnd && anomaly.start_date <= addDays(dismissedEnd, 1);
  }

  /** @private */
  _save() {
    mkdirSync(path.dirname(this._file), { recursive: true });
    const tmp = `${this._file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this._state, null, 2)}\n`);
    renameSync(tmp, this._file);
  }
}
