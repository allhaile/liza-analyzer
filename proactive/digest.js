import { aggregatePageMetrics, loadRows } from '../agent/page-metrics.js';
import {
  buildAlertMessage,
  buildDigestErrorText,
  buildDigestMessage,
  buildSteadyNote,
} from '../listeners/views/alert-builder.js';
import { addDays, BASELINE_WEEKS, detectAnomalies } from './anomalies.js';
import { loadKnownEvents, possibleCauses } from './known-events.js';

/** Page types broken out in the week-over-week comparison. */
export const PAGE_TYPES = ['go', 'learn', 'events', 'open-source'];

/**
 * YYYY-MM-DD for an instant in a timezone.
 * @param {Date} now
 * @param {string} timeZone
 */
export function localDate(now, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * ISO week key for a YYYY-MM-DD date, e.g. "2026-W43".
 * @param {string} date
 */
export function isoWeekKey(date) {
  const d = new Date(`${date}T00:00:00Z`);
  // The ISO week belongs to the year of its Thursday
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The latest complete Monday–Sunday week in the data (and before today), plus the week before it.
 * @param {import('../agent/page-metrics.js').PageRow[]} rows
 * @param {string} today - YYYY-MM-DD
 */
export function reportWindows(rows, today) {
  const lastDataDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '');
  const yesterday = addDays(today, -1);
  const last = lastDataDate < yesterday ? lastDataDate : yesterday;
  const end = addDays(last, -new Date(`${last}T00:00:00Z`).getUTCDay());
  const start = addDays(end, -6);
  return {
    current: { start, end },
    previous: { start: addDays(start, -7), end: addDays(start, -1) },
  };
}

/**
 * @param {number} current
 * @param {number} previous
 */
const pctChange = (current, previous) => (previous ? +(((current - previous) / previous) * 100).toFixed(1) : 0);

/**
 * Week-over-week comparison over equal-length windows, overall and by page type.
 * @param {import('../agent/page-metrics.js').PageRow[]} rows
 * @param {ReturnType<typeof reportWindows>} windows
 * @param {number} minSessions - Daily traffic floor; the best CTA page needs 7x this for the week.
 * @returns {import('../listeners/views/alert-builder.js').WeekComparison}
 */
export function compareWeeks(rows, windows, minSessions) {
  /**
   * @param {{start: string, end: string}} w
   * @param {'none' | 'page_type' | 'page'} group_by
   * @param {'sessions' | 'cta_click_rate_pct'} [sort_by]
   */
  const query = (w, group_by, sort_by = 'sessions') =>
    aggregatePageMetrics(rows, {
      group_by,
      start_date: w.start,
      end_date: w.end,
      sort_by,
      limit: Number.POSITIVE_INFINITY,
    }).results;

  const [cur] = query(windows.current, 'none');
  const [prev] = query(windows.previous, 'none');
  const curTypes = new Map(query(windows.current, 'page_type').map((r) => [r.page_type, r]));
  const prevTypes = new Map(query(windows.previous, 'page_type').map((r) => [r.page_type, r]));
  const best = query(windows.current, 'page', 'cta_click_rate_pct').find((r) => r.sessions >= minSessions * 7);

  return {
    current: windows.current,
    previous: windows.previous,
    overall: {
      sessions: cur?.sessions ?? 0,
      previous_sessions: prev?.sessions ?? 0,
      sessions_pct: pctChange(cur?.sessions ?? 0, prev?.sessions ?? 0),
      cta_click_rate_pct: cur?.cta_click_rate_pct ?? 0,
    },
    by_type: PAGE_TYPES.map((t) => ({
      page_type: t,
      sessions: curTypes.get(t)?.sessions ?? 0,
      previous_sessions: prevTypes.get(t)?.sessions ?? 0,
      sessions_pct: pctChange(curTypes.get(t)?.sessions ?? 0, prevTypes.get(t)?.sessions ?? 0),
    })),
    best_cta_page: best
      ? {
          page: String(best.page),
          cta_click_rate_pct: best.cta_click_rate_pct,
          cta_clicks: best.cta_clicks,
          sessions: best.sessions,
        }
      : null,
  };
}

/**
 * Decide what to post: one "all steady" note, or a digest with up to maxAlerts alerts.
 * @param {import('../listeners/views/alert-builder.js').WeekComparison} comparison
 * @param {import('./anomalies.js').Anomaly[]} anomalies - Already filtered for snoozes/dismissals, sorted by |z|.
 * @param {{steadyBandPct: number, maxAlerts: number}} config
 * @returns {{kind: 'steady'} | {kind: 'digest', alerts: import('./anomalies.js').Anomaly[], hiddenCount: number, anomalies: import('./anomalies.js').Anomaly[]}}
 */
export function planDigest(comparison, anomalies, config) {
  if (!anomalies.length && Math.abs(comparison.overall.sessions_pct) < config.steadyBandPct) return { kind: 'steady' };
  const alerts = anomalies.slice(0, config.maxAlerts);
  return { kind: 'digest', alerts, hiddenCount: anomalies.length - alerts.length, anomalies };
}

/**
 * Totals for the anomaly's date range, plus the report week's daily metric against its same-weekday
 * 4-week average (the comparison detectAnomalies makes), all from the data layer.
 * @param {import('../agent/page-metrics.js').PageRow[]} rows
 * @param {import('./anomalies.js').Anomaly} a
 * @param {{start: string, end: string}} week - The report window.
 * @param {import('./known-events.js').KnownEvent[]} events
 * @returns {import('../listeners/views/alert-builder.js').AlertDetails}
 */
export function alertDetails(rows, a, week, events) {
  const pageRows = rows.filter((r) => r.page === a.page);
  const [totals] = aggregatePageMetrics(pageRows, {
    group_by: 'none',
    start_date: a.start_date,
    end_date: a.end_date,
    sort_by: 'sessions',
    limit: 1,
  }).results;
  const daily = aggregatePageMetrics(pageRows, {
    group_by: 'date',
    start_date: addDays(week.start, -7 * BASELINE_WEEKS),
    end_date: week.end,
    sort_by: 'chronological',
    limit: Number.POSITIVE_INFINITY,
  }).results;
  const value = new Map(
    daily.map((d) => [String(d.date), a.metric === 'cta_rate' ? d.cta_click_rate_pct : d.sessions]),
  );
  const dates = Array.from({ length: 7 }, (_, i) => addDays(week.start, i));
  const baseline = dates.map((date) => {
    const history = Array.from({ length: BASELINE_WEEKS }, (_, i) => value.get(addDays(date, -7 * (i + 1)))).filter(
      (v) => v !== undefined,
    );
    const mean = history.length ? history.reduce((x, y) => x + y, 0) / history.length : 0;
    return a.metric === 'cta_rate' ? +mean.toFixed(2) : Math.round(mean);
  });
  return {
    sessions: totals?.sessions ?? 0,
    cta_click_rate_pct: totals?.cta_click_rate_pct ?? 0,
    avg_engaged_time_sec: totals?.avg_engaged_time_sec ?? 0,
    week: { dates, current: dates.map((date) => value.get(date) ?? 0), baseline },
    possible_causes: possibleCauses(a, events),
  };
}

let running = false;

/**
 * @typedef {Object} DigestResult
 * @property {'posted-steady' | 'posted-digest' | 'already-ran' | 'busy' | 'disabled' | 'failed'} status
 * @property {number} [alerts]
 * @property {string} [ts] - ts of the steady note or digest parent.
 * @property {string} [error]
 */

/**
 * Run the weekly digest: WoW comparison, anomaly detection, then post to the alerts channel only.
 * Scheduled runs record the ISO week so a restart doesn't post twice; forced (manual) runs skip that check.
 * Never throws: failures are logged and reported in one line to the alerts channel.
 * @param {Object} args
 * @param {import('@slack/web-api').WebClient} args.client
 * @param {import('./config.js').ProactiveConfig} args.config
 * @param {import('./state-store.js').ProactiveStore} args.store
 * @param {import('@slack/bolt').Logger} args.logger
 * @param {Date} [args.now]
 * @param {boolean} [args.force]
 * @param {import('../agent/page-metrics.js').PageRow[]} [args.rows] - Defaults to the page metrics dataset.
 * @returns {Promise<DigestResult>}
 */
export async function runWeeklyDigest({ client, config, store, logger, now = new Date(), force = false, rows }) {
  const channel = config.alertsChannelId;
  if (!channel) {
    logger.warn('Weekly digest skipped: ALERTS_CHANNEL_ID is not set.');
    return { status: 'disabled' };
  }

  const runKey = isoWeekKey(localDate(now, config.digestTimezone));
  if (!force && store.getLastDigestKey() === runKey) {
    logger.info(`Weekly digest already posted for ${runKey}; skipping.`);
    return { status: 'already-ran' };
  }
  if (running) {
    logger.warn('Weekly digest is already running; skipping this trigger.');
    return { status: 'busy' };
  }

  running = true;
  try {
    const data = rows ?? (await loadRows());
    const windows = reportWindows(data, localDate(now, config.digestTimezone));
    const comparison = compareWeeks(data, windows, config.minSessions);
    const anomalies = detectAnomalies(data, { ...config, window: windows.current }).filter(
      (a) => !store.isSuppressed(a, now),
    );
    const plan = planDigest(comparison, anomalies, config);

    /** @type {DigestResult} */
    let result;
    if (plan.kind === 'steady') {
      const res = await client.chat.postMessage({ channel, ...buildSteadyNote(comparison) });
      result = { status: 'posted-steady', ts: res.ts };
    } else {
      const events = config.knownEventsEnabled ? await loadKnownEvents(config.knownEventsFile) : [];
      const parent = await client.chat.postMessage({
        channel,
        ...buildDigestMessage(comparison, plan.alerts, plan.hiddenCount, plan.anomalies),
      });
      for (const a of plan.alerts) {
        await client.chat.postMessage({
          channel,
          thread_ts: parent.ts,
          ...buildAlertMessage(a, alertDetails(data, a, windows.current, events)),
        });
      }
      result = { status: 'posted-digest', alerts: plan.alerts.length, ts: parent.ts };
    }

    if (!force) store.setLastDigestKey(runKey);
    logger.info(
      `Weekly digest ${result.status} for ${windows.current.start}..${windows.current.end}` +
        `${result.alerts ? ` with ${result.alerts} alert(s)` : ''}.`,
    );
    return result;
  } catch (e) {
    logger.error(`Weekly digest failed: ${/** @type {Error} */ (e)?.stack ?? e}`);
    await client.chat.postMessage({ channel, text: buildDigestErrorText(e) }).catch((postError) => {
      logger.error(`Could not post digest failure to ${channel}: ${postError}`);
    });
    return { status: 'failed', error: String(/** @type {Error} */ (e)?.message ?? e) };
  } finally {
    running = false;
  }
}
