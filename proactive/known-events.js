import { readFile } from 'node:fs/promises';

/** An anomaly within this many days of a known event gets a "Possible cause" note. */
export const KNOWN_EVENT_WINDOW_DAYS = 2;

/**
 * @typedef {{date: string, label: string}} KnownEvent
 */

/**
 * Load known events (launches, outages, campaigns). A missing file means no events.
 * @param {string} file
 * @returns {Promise<KnownEvent[]>}
 */
export async function loadKnownEvents(file) {
  try {
    const events = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(events) ? events.filter((e) => e?.date && e?.label) : [];
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Labels of events within KNOWN_EVENT_WINDOW_DAYS of the anomaly's date range.
 * @param {{start_date: string, end_date: string}} anomaly
 * @param {KnownEvent[]} events
 * @returns {string[]}
 */
export function possibleCauses(anomaly, events) {
  const dayMs = 86_400_000;
  const start = Date.parse(anomaly.start_date) - KNOWN_EVENT_WINDOW_DAYS * dayMs;
  const end = Date.parse(anomaly.end_date) + KNOWN_EVENT_WINDOW_DAYS * dayMs;
  return events.filter((e) => Date.parse(e.date) >= start && Date.parse(e.date) <= end).map((e) => e.label);
}
