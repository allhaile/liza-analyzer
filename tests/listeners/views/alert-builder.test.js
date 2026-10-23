import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  ALERT_ACTIONS_BLOCK_ID,
  buildAlertMessage,
  buildDigestMessage,
  dayLabel,
  INVESTIGATE_ACTION_PREFIX,
} from '../../../listeners/views/alert-builder.js';
import { detectAnomalies } from '../../../proactive/anomalies.js';
import { alertDetails, compareWeeks, reportWindows } from '../../../proactive/digest.js';
import {
  buildRows,
  CYCLE_PAGE,
  DEFAULT_DETECTION,
  DIP_PAGE,
  REPORT_WEEK,
  SPIKE_PAGE,
} from '../../proactive/fixtures.js';

/**
 * Limits from docs.slack.dev/reference/block-kit/blocks/data-visualization-block.
 * @param {any} block
 */
function assertValidChart(block) {
  assert.strictEqual(block.type, 'data_visualization');
  assert.ok(block.title.length <= 50, `title too long: ${block.title}`);
  const { chart } = block;
  assert.ok(['line', 'bar', 'area'].includes(chart.type));
  const { categories } = chart.axis_config;
  assert.ok(categories.every((/** @type {string} */ c) => c.length <= 20));
  assert.ok(chart.axis_config.x_label.length <= 50 && chart.axis_config.y_label.length <= 50);
  assert.ok(chart.series.length >= 1 && chart.series.length <= 12);
  assert.strictEqual(new Set(chart.series.map((/** @type {any} */ s) => s.name)).size, chart.series.length);
  for (const s of chart.series) {
    assert.ok(s.name.length <= 20, `series name too long: ${s.name}`);
    assert.ok(s.data.length >= 1 && s.data.length <= 20);
    assert.deepStrictEqual(
      s.data.map((/** @type {any} */ d) => d.label),
      categories,
    );
    assert.ok(s.data.every((/** @type {any} */ d) => Number.isFinite(d.value)));
  }
}

/**
 * Limits from docs.slack.dev/reference/block-kit/blocks/data-table-block.
 * @param {any} block
 */
function assertValidTable(block) {
  assert.strictEqual(block.type, 'data_table');
  assert.ok(block.caption);
  assert.ok(block.rows.length >= 2 && block.rows.length <= 201);
  const width = block.rows[0].length;
  assert.ok(width >= 1 && width <= 20);
  assert.ok(block.rows.every((/** @type {any[]} */ r) => r.length === width));
  assert.ok(block.rows[0].every((/** @type {any} */ c) => c.type === 'raw_text'));
  // blocks.validate rejects empty cell text, including header cells
  assert.ok(block.rows.flat().every((/** @type {any} */ c) => c.type === 'action_cell' || c.text.length > 0));
  assert.ok(JSON.stringify(block.rows).length < 20_000);
  const actionIds = block.rows.slice(1).map((/** @type {any[]} */ r) => r.at(-1).element.action_id);
  assert.strictEqual(new Set(actionIds).size, actionIds.length);
}

const rows = buildRows([CYCLE_PAGE, SPIKE_PAGE, DIP_PAGE]);
const windows = reportWindows(rows, '2026-10-05');
const anomalies = detectAnomalies(rows, { ...DEFAULT_DETECTION, window: windows.current });

describe('alert message', () => {
  const spike = /** @type {import('../../../proactive/anomalies.js').Anomaly} */ (
    anomalies.find((a) => a.page === SPIKE_PAGE.page)
  );
  const { blocks } = buildAlertMessage(spike, alertDetails(rows, spike, windows.current, []));
  const charts = blocks.filter((/** @type {any} */ b) => b.type === 'data_visualization');

  it('charts the report week against the same-weekday baseline', () => {
    assert.strictEqual(charts.length, 1);
    const chart = /** @type {any} */ (charts[0]);
    assertValidChart(chart);
    assert.strictEqual(chart.chart.type, 'line');
    assert.deepStrictEqual(chart.chart.axis_config.categories, [
      'Mon 9/28',
      'Tue 9/29',
      'Wed 9/30',
      'Thu 10/1',
      'Fri 10/2',
      'Sat 10/3',
      'Sun 10/4',
    ]);
    const [current, baseline] = chart.chart.series.map((/** @type {any} */ s) =>
      s.data.map((/** @type {any} */ d) => d.value),
    );
    // Seeded 2x on Tue–Wed; every baseline day is the plain 4-week average
    assert.deepStrictEqual(current.slice(1, 3), [3200, 3200]);
    assert.deepStrictEqual(baseline.slice(1, 3), [1600, 1600]);
    assert.strictEqual(current[0], baseline[0]);
  });

  it('keeps Investigate, Snooze, and Not an issue in the alert actions block', () => {
    const actions = /** @type {any} */ (blocks.find((/** @type {any} */ b) => b.block_id === ALERT_ACTIONS_BLOCK_ID));
    assert.deepStrictEqual(
      actions.elements.map((/** @type {any} */ e) => e.action_id),
      [INVESTIGATE_ACTION_PREFIX, 'alert_snooze', 'alert_dismiss'],
    );
  });
});

describe('digest message', () => {
  const comparison = compareWeeks(rows, windows, DEFAULT_DETECTION.minSessions);
  const { blocks } = buildDigestMessage(comparison, anomalies.slice(0, 1), anomalies.length - 1, anomalies);

  it('has a page-type bar chart and at most 2 charts', () => {
    const charts = blocks.filter((/** @type {any} */ b) => b.type === 'data_visualization');
    assert.strictEqual(charts.length, 1);
    const chart = /** @type {any} */ (charts[0]);
    assertValidChart(chart);
    assert.strictEqual(chart.chart.type, 'bar');
    assert.deepStrictEqual(chart.chart.axis_config.categories, ['go', 'learn', 'events', 'open-source']);
    assert.deepStrictEqual(
      chart.chart.series.map((/** @type {any} */ s) => s.name),
      ['Last week', 'This week'],
    );
  });

  it('lists every anomaly in a data table with per-row Investigate buttons', () => {
    const table = /** @type {any} */ (blocks.find((/** @type {any} */ b) => b.type === 'data_table'));
    assertValidTable(table);
    assert.strictEqual(table.rows.length, anomalies.length + 1);
    const pattern = new RegExp(`^${INVESTIGATE_ACTION_PREFIX}(_\\d+)?$`);
    assert.ok(table.rows.slice(1).every((/** @type {any[]} */ r) => pattern.test(r.at(-1).element.action_id)));
    assert.ok(table.rows.slice(1).every((/** @type {any[]} */ r) => r[2].type === 'raw_number'));
  });

  it('omits the table when there are no anomalies', () => {
    const quiet = buildDigestMessage(comparison, [], 0, []);
    assert.ok(!quiet.blocks.some((/** @type {any} */ b) => b.type === 'data_table'));
  });
});

describe('dayLabel', () => {
  it('formats weekday and month/day', () => {
    assert.strictEqual(dayLabel(REPORT_WEEK.start), 'Mon 9/28');
  });
});
