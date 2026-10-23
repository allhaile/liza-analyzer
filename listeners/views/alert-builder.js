import { METRICS } from '../../proactive/anomalies.js';

export const ALERT_ACTIONS_BLOCK_ID = 'alert_actions';
export const DIGEST_TABLE_BLOCK_ID = 'digest_anomalies';

/** Investigate buttons share this prefix; table rows need distinct action_ids within one block. */
export const INVESTIGATE_ACTION_PREFIX = 'alert_investigate';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Data table rows include each row's button value, so cap rows to stay well under the 20,000 character limit
const MAX_TABLE_ROWS = 50;

/**
 * data_visualization and data_table aren't in @slack/types yet, so they're cast to the generic Block.
 * @param {Record<string, unknown> & {type: string}} block
 */
const nativeBlock = (block) => /** @type {import('@slack/types').Block} */ (block);

/**
 * "Sep 28 – Oct 4", or "Sep 21 – 27" within one month.
 * @param {string} start - YYYY-MM-DD
 * @param {string} end - YYYY-MM-DD
 */
export function formatRange(start, end) {
  const [, sm, sd] = start.split('-').map(Number);
  const [, em, ed] = end.split('-').map(Number);
  if (start === end) return `${MONTHS[sm - 1]} ${sd}`;
  return sm === em ? `${MONTHS[sm - 1]} ${sd} – ${ed}` : `${MONTHS[sm - 1]} ${sd} – ${MONTHS[em - 1]} ${ed}`;
}

/**
 * @param {number} pct
 */
export const signedPct = (pct) => `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct).toFixed(1)}%`;

/**
 * @param {number} n
 */
const fmt = (n) => n.toLocaleString('en-US');

/**
 * @param {number} sec
 */
const duration = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`);

/**
 * Short x-axis label, e.g. "Mon 9/28".
 * @param {string} date - YYYY-MM-DD
 */
export function dayLabel(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${m}/${d}`;
}

/**
 * Button value carrying the anomaly to the action handlers.
 * @param {import('../../proactive/anomalies.js').Anomaly} a
 */
function anomalyValue(a) {
  return JSON.stringify({
    page: a.page,
    page_type: a.page_type,
    metric: a.metric,
    direction: a.direction,
    start: a.start_date,
    end: a.end_date,
    base_start: a.baseline_start,
    base_end: a.baseline_end,
    pct: a.pct_change,
    z: a.z,
  });
}

/**
 * Headline for an anomaly, e.g. "`/go/bolt-js` CTA rate dropped 38% vs. baseline".
 * @param {import('../../proactive/anomalies.js').Anomaly} a
 */
export function anomalyHeadline(a) {
  const verb = a.direction === 'spike' ? 'jumped' : 'dropped';
  return `\`${a.page}\` ${METRICS[a.metric].label} ${verb} ${Math.abs(Math.round(a.pct_change))}% vs. baseline`;
}

/**
 * @param {number} value
 * @param {string} metric
 */
const metricValue = (value, metric) =>
  metric === 'cta_rate' ? `${value.toFixed(2)}%` : `${fmt(Math.round(value))}/day`;

/**
 * @typedef {Object} WeekComparison
 * @property {{start: string, end: string}} current
 * @property {{start: string, end: string}} previous
 * @property {{sessions: number, previous_sessions: number, sessions_pct: number, cta_click_rate_pct: number}} overall
 * @property {{page_type: string, sessions: number, previous_sessions: number, sessions_pct: number}[]} by_type
 * @property {{page: string, cta_click_rate_pct: number, cta_clicks: number, sessions: number} | null} best_cta_page
 */

/**
 * @param {WeekComparison} c
 */
const rangeLine = (c) =>
  `${formatRange(c.current.start, c.current.end)} vs. ${formatRange(c.previous.start, c.previous.end)}`;

/**
 * The one short note posted when nothing moved enough to mention.
 * @param {WeekComparison} c
 * @returns {{text: string, blocks: import('@slack/types').KnownBlock[]}}
 */
export function buildSteadyNote(c) {
  const best = c.best_cta_page;
  const lines = [
    `*All steady on slack.dev this week* :ok_hand: Sessions came in at ${fmt(c.overall.sessions)}, ` +
      `${signedPct(c.overall.sessions_pct)} week over week.`,
    best
      ? `Best CTA rate: \`${best.page}\` at ${best.cta_click_rate_pct}% (${fmt(best.cta_clicks)} clicks / ${fmt(best.sessions)} sessions).`
      : 'No page cleared the traffic floor for a best-CTA pick.',
    `_${rangeLine(c)} · Nothing to chase. Back next week._`,
  ];
  const text = lines.join('\n');
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

/**
 * Grouped bar chart of sessions by page type, last week vs. this week.
 * @param {WeekComparison} c
 */
function pageTypeChart(c) {
  const categories = c.by_type.map((t) => t.page_type);
  return nativeBlock({
    type: 'data_visualization',
    title: 'Sessions by page type, week over week',
    chart: {
      type: 'bar',
      series: [
        { name: 'Last week', data: c.by_type.map((t) => ({ label: t.page_type, value: t.previous_sessions })) },
        { name: 'This week', data: c.by_type.map((t) => ({ label: t.page_type, value: t.sessions })) },
      ],
      axis_config: { categories, x_label: rangeLine(c), y_label: 'Sessions' },
    },
  });
}

/**
 * Sortable table of every anomaly, with an Investigate button per row.
 * @param {import('../../proactive/anomalies.js').Anomaly[]} anomalies
 */
function anomalyTable(anomalies) {
  const text = (/** @type {string} */ t) => ({ type: 'raw_text', text: t });
  const number = (/** @type {number} */ value, /** @type {string} */ t) => ({ type: 'raw_number', value, text: t });
  const shown = anomalies.slice(0, MAX_TABLE_ROWS);
  return nativeBlock({
    type: 'data_table',
    block_id: DIGEST_TABLE_BLOCK_ID,
    caption: `All ${anomalies.length} anomalies, ranked by |z|${anomalies.length > shown.length ? ` (top ${shown.length})` : ''}`,
    page_size: 5,
    rows: [
      [text('Page'), text('Metric'), text('Change'), text('z'), text('Dates'), text('Action')],
      ...shown.map((a, i) => [
        text(a.page),
        text(METRICS[a.metric].label),
        number(a.pct_change, signedPct(a.pct_change)),
        number(a.z, a.z.toFixed(1)),
        text(formatRange(a.start_date, a.end_date)),
        {
          type: 'action_cell',
          element: {
            type: 'button',
            action_id: `${INVESTIGATE_ACTION_PREFIX}_${i}`,
            text: { type: 'plain_text', text: 'Investigate' },
            value: anomalyValue(a),
          },
          fallback: text('Investigate'),
        },
      ]),
    ],
  });
}

/**
 * Parent message for a weekly digest: summary, page type chart, and anomaly table. Alerts go in its thread.
 * @param {WeekComparison} c
 * @param {import('../../proactive/anomalies.js').Anomaly[]} alerts - The alerts being posted.
 * @param {number} hiddenCount - Anomalies beyond the alert cap.
 * @param {import('../../proactive/anomalies.js').Anomaly[]} [anomalies] - Every anomaly, for the table.
 * @returns {{text: string, blocks: (import('@slack/types').KnownBlock | import('@slack/types').Block)[]}}
 */
export function buildDigestMessage(c, alerts, hiddenCount, anomalies = alerts) {
  const n = alerts.length;
  const title = n
    ? `*Weekly slack.dev digest: ${n} thing${n === 1 ? '' : 's'} worth a look* :mag:`
    : '*Weekly slack.dev digest: no anomalies, but traffic moved* :chart_with_upwards_trend:';
  const byType = c.by_type.map((t) => `${t.page_type} ${signedPct(t.sessions_pct)}`).join(' · ');
  const lines = [
    title,
    `Sessions: ${fmt(c.overall.sessions)} (${signedPct(c.overall.sessions_pct)} WoW). By type: ${byType}`,
  ];
  if (n) lines.push(`Biggest mover: ${anomalyHeadline(alerts[0])}.`);
  if (hiddenCount) lines.push(`The top ${n} are in the thread; all ${anomalies.length} are in the table below.`);
  const nextStep = n
    ? 'Hit *Investigate* on any alert or table row you want me to dig into.'
    : 'DM me "what drove the change last week?" if you want the breakdown.';
  const text = lines.join('\n');
  /** @type {(import('@slack/types').KnownBlock | import('@slack/types').Block)[]} */
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text } }, pageTypeChart(c)];
  if (anomalies.length) blocks.push(anomalyTable(anomalies));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${rangeLine(c)} · ${nextStep}` }] });
  return { text, blocks };
}

/**
 * @typedef {Object} AlertDetails
 * @property {number} sessions - Total sessions over the anomaly's date range.
 * @property {number} cta_click_rate_pct
 * @property {number} avg_engaged_time_sec
 * @property {{dates: string[], current: number[], baseline: number[]}} week - The report week's daily metric and
 *   its same-weekday 4-week average.
 * @property {string[]} possible_causes
 */

/**
 * One alert per anomaly, with buttons to investigate, snooze, or dismiss.
 * @param {import('../../proactive/anomalies.js').Anomaly} a
 * @param {AlertDetails} d
 * @returns {{text: string, blocks: (import('@slack/types').KnownBlock | import('@slack/types').Block)[]}}
 */
export function buildAlertMessage(a, d) {
  const headline = anomalyHeadline(a);
  const value = anomalyValue(a);
  const label = METRICS[a.metric].label;
  const categories = d.week.dates.map(dayLabel);
  const days = `${a.days} day${a.days === 1 ? '' : 's'}`;

  /** @type {(import('@slack/types').KnownBlock | import('@slack/types').Block)[]} */
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${headline}*` } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            `Avg ${metricValue(a.observed, a.metric)} vs. ${metricValue(a.baseline, a.metric)} baseline ` +
            `(same weekday, ${formatRange(a.baseline_start, a.baseline_end)}) · z = ${a.z.toFixed(1)} · ${days}`,
        },
      ],
    },
  ];
  if (d.possible_causes.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `:bulb: Possible cause: ${d.possible_causes.join('; ')}` }],
    });
  }
  blocks.push(
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Sessions*\n${fmt(d.sessions)}` },
        { type: 'mrkdwn', text: `*CTA rate*\n${d.cta_click_rate_pct}%` },
        { type: 'mrkdwn', text: `*Avg engaged time*\n${duration(d.avg_engaged_time_sec)}` },
        { type: 'mrkdwn', text: `*Date range*\n${formatRange(a.start_date, a.end_date)}` },
      ],
    },
    nativeBlock({
      type: 'data_visualization',
      title: `Daily ${label} vs. 4-week baseline`,
      chart: {
        type: 'line',
        series: [
          { name: 'This week', data: categories.map((c, i) => ({ label: c, value: d.week.current[i] })) },
          { name: 'Same-day 4-wk avg', data: categories.map((c, i) => ({ label: c, value: d.week.baseline[i] })) },
        ],
        axis_config: {
          categories,
          x_label: formatRange(/** @type {string} */ (d.week.dates[0]), /** @type {string} */ (d.week.dates.at(-1))),
          y_label: a.metric === 'cta_rate' ? 'CTA rate (%)' : 'Sessions',
        },
      },
    }),
    {
      type: 'actions',
      block_id: ALERT_ACTIONS_BLOCK_ID,
      elements: [
        {
          type: 'button',
          action_id: INVESTIGATE_ACTION_PREFIX,
          style: 'primary',
          text: { type: 'plain_text', text: 'Investigate' },
          value,
        },
        { type: 'button', action_id: 'alert_snooze', text: { type: 'plain_text', text: 'Snooze 7d' }, value },
        { type: 'button', action_id: 'alert_dismiss', text: { type: 'plain_text', text: 'Not an issue' }, value },
      ],
    },
  );
  return { text: headline, blocks };
}

/**
 * Swap an alert's buttons for a line showing what was chosen.
 * @param {any[]} blocks - The alert message's current blocks.
 * @param {string} stateText - mrkdwn for the new state line.
 * @returns {(import('@slack/types').KnownBlock | import('@slack/types').Block)[]}
 */
export function withAlertState(blocks, stateText) {
  return [
    ...blocks.filter((b) => b.block_id !== ALERT_ACTIONS_BLOCK_ID),
    { type: 'context', elements: [{ type: 'mrkdwn', text: stateText }] },
  ];
}

/**
 * One-line failure notice for the alerts channel.
 * @param {unknown} e
 */
export function buildDigestErrorText(e) {
  return `:warning: The weekly digest hit a snag and didn't finish: ${/** @type {Error} */ (e)?.message ?? e}`;
}
