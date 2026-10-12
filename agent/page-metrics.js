import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const DATA_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'page-metrics.csv');

/**
 * One row per page per day. engaged_time_sec is the average engaged time per session.
 * @typedef {Object} PageRow
 * @property {string} date - YYYY-MM-DD
 * @property {string} page
 * @property {string} page_type
 * @property {number} sessions
 * @property {number} engaged_time_sec
 * @property {number} cta_clicks
 */

/** @type {Promise<PageRow[]> | null} */
let rowsPromise = null;

/**
 * Normalize YYYYMMDD or YYYY-MM-DD to YYYY-MM-DD.
 * @param {string} raw
 */
function normalizeDate(raw) {
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
}

/**
 * Parse the GA4-style CSV export, skipping `#` comment lines.
 * @param {string} csv
 * @returns {PageRow[]}
 */
export function parsePageMetrics(csv) {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const header = /** @type {string} */ (lines.shift()).split(',').map((h) => h.trim());
  return lines.map((line) => {
    const cells = line.split(',');
    /** @type {Record<string, string>} */
    const r = Object.fromEntries(header.map((h, i) => [h, cells[i]?.trim() ?? '']));
    return {
      date: normalizeDate(r.date),
      page: r.page,
      page_type: r.page_type,
      sessions: Number(r.sessions),
      engaged_time_sec: Number(r.engaged_time_sec),
      cta_clicks: Number(r.cta_clicks),
    };
  });
}

function loadRows() {
  rowsPromise ??= readFile(DATA_FILE, 'utf8')
    .then(parsePageMetrics)
    .catch((e) => {
      rowsPromise = null;
      throw e;
    });
  return rowsPromise;
}

/**
 * ISO week start (Monday) for a YYYY-MM-DD date.
 * @param {string} date
 */
function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** @type {Record<string, (r: PageRow) => string>} */
const GROUP_KEYS = {
  page: (r) => r.page,
  page_type: (r) => r.page_type,
  date: (r) => r.date,
  week: (r) => weekOf(r.date),
  none: () => 'all',
};

/**
 * Filter, group, and aggregate page rows.
 * @param {PageRow[]} rows
 * @param {{group_by: keyof typeof GROUP_KEYS, page_contains?: string, page_type?: string, start_date?: string, end_date?: string, sort_by: string, limit: number}} q
 */
export function aggregatePageMetrics(rows, q) {
  const filtered = rows.filter(
    (r) =>
      (!q.page_contains || r.page.includes(q.page_contains)) &&
      (!q.page_type || r.page_type === q.page_type) &&
      (!q.start_date || r.date >= q.start_date) &&
      (!q.end_date || r.date <= q.end_date),
  );

  /** @type {Map<string, {sessions: number, engaged_total: number, cta_clicks: number, days: Set<string>}>} */
  const groups = new Map();
  for (const r of filtered) {
    const key = GROUP_KEYS[q.group_by](r);
    const g = groups.get(key) ?? { sessions: 0, engaged_total: 0, cta_clicks: 0, days: new Set() };
    g.sessions += r.sessions;
    g.engaged_total += r.engaged_time_sec * r.sessions;
    g.cta_clicks += r.cta_clicks;
    g.days.add(r.date);
    groups.set(key, g);
  }

  const results = [...groups].map(([key, g]) => ({
    [q.group_by]: key,
    sessions: g.sessions,
    cta_clicks: g.cta_clicks,
    cta_click_rate_pct: g.sessions ? +((g.cta_clicks / g.sessions) * 100).toFixed(2) : 0,
    avg_engaged_time_sec: g.sessions ? Math.round(g.engaged_total / g.sessions) : 0,
    days: g.days.size,
  }));

  const chronological = q.group_by === 'date' || q.group_by === 'week';
  results.sort((a, b) =>
    chronological && q.sort_by === 'chronological'
      ? String(a[q.group_by]).localeCompare(String(b[q.group_by]))
      : Number(b[q.sort_by] ?? 0) - Number(a[q.sort_by] ?? 0),
  );

  return { matched_rows: filtered.length, total_groups: results.length, results: results.slice(0, q.limit) };
}

/**
 * @param {unknown} value
 */
const jsonResult = (value) => ({ content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(value) }] });

export function createPageMetricsTools() {
  const describePageMetrics = tool(
    'describe_page_metrics',
    'Describe the slack.dev landing page analytics dataset: date range, page types, and every page path. ' +
      'Call this first so you know which pages and dates exist before querying.',
    {},
    async () => {
      try {
        const rows = await loadRows();
        const dates = rows.map((r) => r.date).sort();
        /** @type {Record<string, string[]>} */
        const pagesByType = {};
        for (const r of rows) {
          pagesByType[r.page_type] ??= [];
          if (!pagesByType[r.page_type].includes(r.page)) pagesByType[r.page_type].push(r.page);
        }
        return jsonResult({
          source: 'GA4 export, one row per page per day',
          metrics: {
            sessions: 'sessions that viewed the page',
            cta_clicks: 'clicks on the page call-to-action',
            cta_click_rate_pct: 'cta_clicks / sessions',
            avg_engaged_time_sec: 'session-weighted average engaged time per session',
          },
          start_date: dates[0],
          end_date: dates.at(-1),
          rows: rows.length,
          pages_by_type: pagesByType,
        });
      } catch (e) {
        return jsonResult({ error: `Could not load page metrics: ${/** @type {Error} */ (e).message}` });
      }
    },
  );

  const queryPageMetrics = tool(
    'query_page_metrics',
    'Aggregate slack.dev landing page analytics (sessions, CTA clicks, CTA click rate, avg engaged time). ' +
      'Filter by page, page type, and date range; group by page, page_type, date, week, or none. ' +
      'For period-over-period comparisons, call this once per period. All math is done for you — ' +
      'report these numbers rather than recalculating.',
    {
      group_by: z.enum(['page', 'page_type', 'date', 'week', 'none']).default('page'),
      page_contains: z.string().optional().describe('Only pages whose path contains this, e.g. "/go/" or "bolt".'),
      page_type: z.string().optional().describe('Exact page type, e.g. "go", "learn", "events", "open-source".'),
      start_date: z.string().optional().describe('Inclusive, YYYY-MM-DD.'),
      end_date: z.string().optional().describe('Inclusive, YYYY-MM-DD.'),
      sort_by: z
        .enum(['sessions', 'cta_clicks', 'cta_click_rate_pct', 'avg_engaged_time_sec', 'chronological'])
        .default('sessions')
        .describe('Descending by metric, or "chronological" when grouping by date/week.'),
      limit: z.number().int().min(1).max(100).default(25),
    },
    async (q) => {
      try {
        return jsonResult(aggregatePageMetrics(await loadRows(), q));
      } catch (e) {
        return jsonResult({ error: `Could not query page metrics: ${/** @type {Error} */ (e).message}` });
      }
    },
  );

  return [describePageMetrics, queryPageMetrics];
}

export const PAGE_METRICS_TOOL_NAMES = ['describe_page_metrics', 'query_page_metrics'];
