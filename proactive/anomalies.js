import { aggregatePageMetrics } from '../agent/page-metrics.js';

/** Weeks of same-weekday history that make up a day's baseline. */
export const BASELINE_WEEKS = 4;

/**
 * Shift a YYYY-MM-DD date by a number of days.
 * @param {string} date
 * @param {number} days
 */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * @typedef {{sessions: number, cta_click_rate_pct: number, avg_engaged_time_sec: number}} DailyMetrics
 */

/** @type {Record<string, {label: string, unit: string, value: (d: DailyMetrics) => number}>} */
export const METRICS = {
  sessions: { label: 'sessions', unit: '', value: (d) => d.sessions },
  cta_rate: { label: 'CTA rate', unit: '%', value: (d) => d.cta_click_rate_pct },
};

/**
 * @typedef {Object} Anomaly
 * @property {string} page
 * @property {string} page_type
 * @property {keyof typeof METRICS} metric
 * @property {'spike' | 'dip'} direction
 * @property {number} baseline - Mean of the same-weekday baselines across the flagged days.
 * @property {number} observed - Mean observed value across the flagged days.
 * @property {number} pct_change - observed vs. baseline, in percent.
 * @property {number} z - Peak z-score across the flagged days (signed).
 * @property {string} start_date - First flagged day.
 * @property {string} end_date - Last flagged day.
 * @property {number} days - Consecutive flagged days.
 * @property {string} baseline_start - Earliest day used in the baseline.
 * @property {string} baseline_end - Latest day used in the baseline.
 */

/**
 * @typedef {Object} DetectionConfig
 * @property {number} zThreshold
 * @property {number} minSessions
 * @property {number} minPersistenceDays
 * @property {number} bigMoveMultiplier
 * @property {{start: string, end: string}} [window] - Days to evaluate (inclusive). Defaults to the last 7 days of data.
 */

const round = (/** @type {number} */ n, digits = 2) => +n.toFixed(digits);

/**
 * @param {number[]} values
 */
function meanAndStddev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

/**
 * Per-day metrics for one page, computed by the same aggregation the query tool uses.
 * @param {import('../agent/page-metrics.js').PageRow[]} pageRows
 * @returns {Map<string, DailyMetrics>}
 */
function dailySeries(pageRows) {
  const { results } = aggregatePageMetrics(pageRows, {
    group_by: 'date',
    sort_by: 'chronological',
    limit: Number.POSITIVE_INFINITY,
  });
  return new Map(
    results.map((r) => [
      String(r.date),
      { sessions: r.sessions, cta_click_rate_pct: r.cta_click_rate_pct, avg_engaged_time_sec: r.avg_engaged_time_sec },
    ]),
  );
}

/**
 * Flag pages whose daily sessions or CTA click rate move away from the trailing same-weekday baseline.
 *
 * A day is flagged when |z| >= zThreshold vs. the previous BASELINE_WEEKS of the same weekday and it has
 * enough traffic (minSessions). Consecutive flagged days in the same direction form one move, which is
 * reported if it lasts minPersistenceDays or its peak |z| reaches zThreshold * bigMoveMultiplier.
 * @param {import('../agent/page-metrics.js').PageRow[]} data
 * @param {DetectionConfig} config
 * @returns {Anomaly[]} Sorted by |z|, largest first.
 */
export function detectAnomalies(data, config) {
  if (!data.length) return [];
  const dates = [...new Set(data.map((r) => r.date))].sort();
  const last = /** @type {string} */ (dates.at(-1));
  const window = config.window ?? { start: addDays(last, -6), end: last };

  /** @type {Map<string, import('../agent/page-metrics.js').PageRow[]>} */
  const byPage = new Map();
  for (const r of data) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r]);

  /** @type {Anomaly[]} */
  const anomalies = [];

  for (const [page, pageRows] of byPage) {
    const series = dailySeries(pageRows);

    for (const [metric, def] of Object.entries(METRICS)) {
      /** @type {{date: string, z: number, observed: number, baseline: number}[]} */
      let run = [];

      const flush = () => {
        if (!run.length) return;
        const peak = run.reduce((a, d) => (Math.abs(d.z) > Math.abs(a.z) ? d : a));
        if (
          run.length >= config.minPersistenceDays ||
          Math.abs(peak.z) >= config.zThreshold * config.bigMoveMultiplier
        ) {
          const baseline = run.reduce((a, d) => a + d.baseline, 0) / run.length;
          const observed = run.reduce((a, d) => a + d.observed, 0) / run.length;
          anomalies.push({
            page,
            page_type: pageRows[0].page_type,
            metric: /** @type {keyof typeof METRICS} */ (metric),
            direction: peak.z > 0 ? 'spike' : 'dip',
            baseline: round(baseline),
            observed: round(observed),
            pct_change: baseline ? round(((observed - baseline) / baseline) * 100, 1) : 0,
            z: round(peak.z),
            start_date: run[0].date,
            end_date: /** @type {{date: string}} */ (run.at(-1)).date,
            days: run.length,
            baseline_start: addDays(run[0].date, -7 * BASELINE_WEEKS),
            baseline_end: addDays(/** @type {{date: string}} */ (run.at(-1)).date, -7),
          });
        }
        run = [];
      };

      for (let date = window.start; date <= window.end; date = addDays(date, 1)) {
        const day = series.get(date);
        const history = Array.from({ length: BASELINE_WEEKS }, (_, i) => series.get(addDays(date, -7 * (i + 1))));
        if (!day || history.some((h) => !h)) {
          flush();
          continue;
        }

        const { mean, stddev } = meanAndStddev(history.map((h) => def.value(/** @type {DailyMetrics} */ (h))));
        const observed = def.value(day);
        const z = stddev ? (observed - mean) / stddev : 0;

        // A sessions dip can take the day below the floor, so the baseline's traffic also counts there
        const baselineSessions =
          history.reduce((a, h) => a + /** @type {DailyMetrics} */ (h).sessions, 0) / BASELINE_WEEKS;
        const traffic = metric === 'sessions' ? Math.max(day.sessions, baselineSessions) : day.sessions;
        const flagged = Math.abs(z) >= config.zThreshold && traffic >= config.minSessions;

        // A flagged day in the opposite direction starts a new move
        if (!flagged || (run.length && Math.sign(run[0].z) !== Math.sign(z))) flush();
        if (flagged) run.push({ date, z, observed, baseline: mean });
      }
      flush();
    }
  }

  return anomalies.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
