import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {Object} ProactiveConfig
 * @property {string | null} alertsChannelId - Dedicated channel; all proactive posts go only here.
 * @property {string} digestCron - node-cron expression for the weekly digest.
 * @property {string} digestTimezone - IANA timezone the cron expression runs in.
 * @property {number} zThreshold - Minimum |z| vs. the same-weekday baseline to flag a day.
 * @property {number} minSessions - Minimum sessions for a day to be considered.
 * @property {number} minPersistenceDays - Consecutive flagged days needed, unless the move is big.
 * @property {number} bigMoveMultiplier - A single day with |z| >= zThreshold * this flags on its own.
 * @property {number} steadyBandPct - Overall week-over-week change under this (absolute %) counts as steady.
 * @property {number} maxAlerts - Max alert messages per digest, ranked by |z|.
 * @property {boolean} knownEventsEnabled - Add "Possible cause" from the known events file.
 * @property {string} knownEventsFile
 * @property {string} stateFile - JSON file for last run, snoozes, and dismissals.
 */

/**
 * @param {string | undefined} raw
 * @param {number} fallback
 * @param {string} name
 * @param {string[]} warnings
 */
function num(raw, fallback, name, warnings) {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  warnings.push(`${name}="${raw}" is not a non-negative number; using default ${fallback}`);
  return fallback;
}

/**
 * Read proactive mode settings from the environment, falling back to defaults.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{config: ProactiveConfig, warnings: string[]}}
 */
export function loadProactiveConfig(env = process.env) {
  /** @type {string[]} */
  const warnings = [];
  return {
    config: {
      alertsChannelId: env.ALERTS_CHANNEL_ID?.trim() || null,
      digestCron: env.DIGEST_CRON?.trim() || '0 9 * * 1',
      digestTimezone: env.DIGEST_TZ?.trim() || 'America/New_York',
      zThreshold: num(env.Z_THRESHOLD, 2, 'Z_THRESHOLD', warnings),
      minSessions: num(env.MIN_SESSIONS, 50, 'MIN_SESSIONS', warnings),
      minPersistenceDays: num(env.MIN_PERSISTENCE_DAYS, 2, 'MIN_PERSISTENCE_DAYS', warnings),
      bigMoveMultiplier: num(env.BIG_MOVE_MULTIPLIER, 1.5, 'BIG_MOVE_MULTIPLIER', warnings),
      steadyBandPct: num(env.STEADY_BAND_PCT, 10, 'STEADY_BAND_PCT', warnings),
      maxAlerts: 5,
      knownEventsEnabled: env.KNOWN_EVENTS_ENABLED?.trim().toLowerCase() !== 'false',
      knownEventsFile: path.resolve(ROOT, env.KNOWN_EVENTS_FILE?.trim() || 'data/known-events.json'),
      stateFile: path.resolve(ROOT, env.PROACTIVE_STATE_FILE?.trim() || 'data/proactive-state.json'),
    },
    warnings,
  };
}
