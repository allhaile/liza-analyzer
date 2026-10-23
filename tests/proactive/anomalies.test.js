import assert from 'node:assert';
import { describe, it } from 'node:test';

import { detectAnomalies } from '../../proactive/anomalies.js';
import {
  buildRows,
  CYCLE_PAGE,
  DEFAULT_DETECTION,
  DIP_PAGE,
  LOW_TRAFFIC_PAGE,
  REPORT_WEEK,
  SPIKE_PAGE,
} from './fixtures.js';

const config = { ...DEFAULT_DETECTION, window: REPORT_WEEK };

describe('detectAnomalies', () => {
  const rows = buildRows([CYCLE_PAGE, SPIKE_PAGE, DIP_PAGE, LOW_TRAFFIC_PAGE]);
  const anomalies = detectAnomalies(rows, config);

  it('flags only the seeded spike and dip', () => {
    assert.deepStrictEqual(anomalies.map((a) => `${a.page} ${a.metric} ${a.direction}`).sort(), [
      '/go/spiky sessions spike',
      '/learn/dippy cta_rate dip',
    ]);
  });

  it('reports the seeded spike with baseline, observed, change, z, and date ranges', () => {
    const spike = anomalies.find((a) => a.page === SPIKE_PAGE.page);
    assert.ok(spike);
    assert.strictEqual(spike.direction, 'spike');
    assert.strictEqual(spike.start_date, '2026-09-29');
    assert.strictEqual(spike.end_date, '2026-09-30');
    assert.strictEqual(spike.days, 2);
    assert.strictEqual(spike.baseline, 1600);
    assert.strictEqual(spike.observed, 3200);
    assert.strictEqual(spike.pct_change, 100);
    assert.ok(spike.z >= 2);
    assert.strictEqual(spike.baseline_start, '2026-09-01');
    assert.strictEqual(spike.baseline_end, '2026-09-23');
  });

  it('reports the seeded dip on CTA rate', () => {
    const dip = anomalies.find((a) => a.page === DIP_PAGE.page);
    assert.ok(dip);
    assert.strictEqual(dip.metric, 'cta_rate');
    assert.strictEqual(dip.direction, 'dip');
    assert.strictEqual(dip.start_date, '2026-10-01');
    assert.strictEqual(dip.end_date, '2026-10-03');
    assert.ok(dip.z <= -2);
    assert.ok(Math.abs(dip.pct_change + 50) < 1, `pct_change ${dip.pct_change}`);
  });

  it('does not flag the low-traffic page, even with a big relative swing', () => {
    assert.ok(!anomalies.some((a) => a.page === LOW_TRAFFIC_PAGE.page));
  });

  it('does not flag the normal weekday/weekend cycle', () => {
    assert.deepStrictEqual(detectAnomalies(buildRows([CYCLE_PAGE]), config), []);
  });

  it('sorts by |z|, largest first', () => {
    const zs = anomalies.map((a) => Math.abs(a.z));
    assert.deepStrictEqual(
      zs,
      [...zs].sort((a, b) => b - a),
    );
  });

  it('needs persistence for a moderate move, but not for a big one', () => {
    // Baseline wobble has stddev ~2.9%, so +7% is z ≈ 2.4: above Z_THRESHOLD, below Z_THRESHOLD * 1.5
    const moderate = (/** @type {Record<string, {sessions: number}>} */ seeded) =>
      detectAnomalies(buildRows([{ ...CYCLE_PAGE, seeded }]), config);

    assert.deepStrictEqual(moderate({ '2026-09-29': { sessions: 1.07 } }), []);
    assert.strictEqual(moderate({ '2026-09-29': { sessions: 1.07 }, '2026-09-30': { sessions: 1.07 } }).length, 1);
    assert.strictEqual(moderate({ '2026-09-29': { sessions: 1.5 } }).length, 1);
  });

  it('respects MIN_SESSIONS', () => {
    const strict = detectAnomalies(rows, { ...config, minSessions: 100_000 });
    assert.deepStrictEqual(strict, []);
  });
});
