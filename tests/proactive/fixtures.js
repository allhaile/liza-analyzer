import { addDays } from '../../proactive/anomalies.js';

/** Monday of the first baseline week; the report week is the fifth week, 2026-09-28 – 2026-10-04. */
export const FIRST_DAY = '2026-08-31';
export const REPORT_WEEK = { start: '2026-09-28', end: '2026-10-04' };

// Week-to-week wobble in the four baseline weeks; the report week sits at 1.0
const SESSION_WOBBLE = [1.03, 0.97, 1.02, 0.98, 1];
const RATE_WOBBLE = [1.02, 0.98, 1.01, 0.99, 1];

/**
 * @typedef {Object} PageSpec
 * @property {string} page
 * @property {string} page_type
 * @property {number} weekday - Weekday sessions.
 * @property {number} weekend - Weekend sessions (the normal weekly cycle).
 * @property {number} ctaRate - Fraction, e.g. 0.06.
 * @property {Record<string, {sessions?: number, ctaRate?: number}>} [seeded] - Date -> multipliers.
 */

/**
 * Five weeks of daily rows shaped like data/page-metrics.csv.
 * @param {PageSpec[]} pages
 * @returns {import('../../agent/page-metrics.js').PageRow[]}
 */
export function buildRows(pages) {
  const rows = [];
  for (let i = 0; i < 35; i++) {
    const date = addDays(FIRST_DAY, i);
    const week = Math.floor(i / 7);
    const isWeekend = i % 7 >= 5;
    for (const p of pages) {
      const seed = p.seeded?.[date] ?? {};
      const sessions = Math.round((isWeekend ? p.weekend : p.weekday) * SESSION_WOBBLE[week] * (seed.sessions ?? 1));
      const rate = p.ctaRate * RATE_WOBBLE[week] * (seed.ctaRate ?? 1);
      rows.push({
        date,
        page: p.page,
        page_type: p.page_type,
        sessions,
        engaged_time_sec: 120,
        cta_clicks: Math.round(sessions * rate),
      });
    }
  }
  return rows;
}

/** A page with a strong weekday/weekend cycle and nothing unusual. */
export const CYCLE_PAGE = {
  page: '/go/steady',
  page_type: 'go',
  weekday: 2000,
  weekend: 900,
  ctaRate: 0.08,
};

/** Sessions double on Tue–Wed of the report week. */
export const SPIKE_PAGE = {
  page: '/go/spiky',
  page_type: 'go',
  weekday: 1600,
  weekend: 700,
  ctaRate: 0.07,
  seeded: { '2026-09-29': { sessions: 2 }, '2026-09-30': { sessions: 2 } },
};

/** CTA rate halves Thu–Sat of the report week. */
export const DIP_PAGE = {
  page: '/learn/dippy',
  page_type: 'learn',
  weekday: 1800,
  weekend: 800,
  ctaRate: 0.06,
  seeded: {
    '2026-10-01': { ctaRate: 0.5 },
    '2026-10-02': { ctaRate: 0.5 },
    '2026-10-03': { ctaRate: 0.5 },
  },
};

/** Tiny page with a big relative swing that should stay below the traffic floor. */
export const LOW_TRAFFIC_PAGE = {
  page: '/events/tiny',
  page_type: 'events',
  weekday: 12,
  weekend: 6,
  ctaRate: 0.1,
  seeded: { '2026-09-29': { sessions: 3, ctaRate: 3 }, '2026-09-30': { sessions: 3, ctaRate: 3 } },
};

export const DEFAULT_DETECTION = { zThreshold: 2, minSessions: 50, minPersistenceDays: 2, bigMoveMultiplier: 1.5 };
