import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { loadProactiveConfig } from '../../proactive/config.js';
import { isoWeekKey, planDigest, reportWindows, runWeeklyDigest } from '../../proactive/digest.js';
import { ProactiveStore } from '../../proactive/state-store.js';
import { buildRows, CYCLE_PAGE, DIP_PAGE, REPORT_WEEK, SPIKE_PAGE } from './fixtures.js';

// Monday after the report week, 9:00 America/New_York
const NOW = new Date('2026-10-05T13:00:00Z');
const silentLogger = /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {} });

function fakeClient({ failFirst = false } = {}) {
  /** @type {any[]} */
  const posts = [];
  let calls = 0;
  return {
    posts,
    client: /** @type {any} */ ({
      chat: {
        postMessage: async (/** @type {any} */ msg) => {
          if (failFirst && calls++ === 0) throw new Error('channel_not_found');
          posts.push(msg);
          return { ts: `100.${posts.length}` };
        },
      },
    }),
  };
}

describe('weekly digest', () => {
  /** @type {ProactiveStore} */
  let store;
  const { config } = loadProactiveConfig({ ALERTS_CHANNEL_ID: 'CALERTS', KNOWN_EVENTS_ENABLED: 'false' });

  beforeEach(() => {
    store = new ProactiveStore(path.join(mkdtempSync(path.join(tmpdir(), 'liza-')), 'state.json'));
  });

  it('reports the last complete week in the data, with an equal-length previous week', () => {
    const windows = reportWindows(buildRows([CYCLE_PAGE]), '2026-10-23');
    assert.deepStrictEqual(windows.current, REPORT_WEEK);
    assert.deepStrictEqual(windows.previous, { start: '2026-09-21', end: '2026-09-27' });
  });

  it('keys runs by ISO week', () => {
    assert.strictEqual(isoWeekKey('2026-10-05'), '2026-W41');
    assert.strictEqual(isoWeekKey('2026-01-01'), '2026-W01');
    assert.strictEqual(isoWeekKey('2027-01-01'), '2026-W53');
  });

  it('posts one short "all steady" note when nothing is dramatic', async () => {
    const { client, posts } = fakeClient();
    const result = await runWeeklyDigest({
      client,
      config,
      store,
      logger: silentLogger,
      now: NOW,
      rows: buildRows([CYCLE_PAGE]),
    });

    assert.strictEqual(result.status, 'posted-steady');
    assert.strictEqual(posts.length, 1);
    const [note] = posts;
    assert.strictEqual(note.channel, 'CALERTS');
    assert.strictEqual(note.thread_ts, undefined);
    const lines = note.text.split('\n');
    assert.ok(lines.length >= 2 && lines.length <= 3, `expected 2-3 lines, got ${lines.length}`);
    assert.match(note.text, /\+2\.0% week over week/);
    assert.match(note.text, /Best CTA rate: `\/go\/steady` at 8%/);
    assert.match(note.text, /Sep 28 – Oct 4 vs\. Sep 21 – 27/);
  });

  it('plans "steady" only when there are no anomalies and WoW is inside the band', () => {
    const comparison = /** @type {any} */ ({ overall: { sessions_pct: 4 } });
    const opts = { steadyBandPct: 10, maxAlerts: 5 };
    assert.deepStrictEqual(planDigest(comparison, [], opts), { kind: 'steady' });
    assert.strictEqual(planDigest({ ...comparison, overall: { sessions_pct: -12 } }, [], opts).kind, 'digest');
    const anomalies = /** @type {any[]} */ (Array.from({ length: 7 }, (_, i) => ({ z: 10 - i })));
    const plan = planDigest(comparison, anomalies, opts);
    assert.strictEqual(plan.kind, 'digest');
    assert.strictEqual(plan.kind === 'digest' && plan.alerts.length, 5);
    assert.strictEqual(plan.kind === 'digest' && plan.hiddenCount, 2);
  });

  it('posts a digest parent with one threaded alert per anomaly', async () => {
    const { client, posts } = fakeClient();
    const result = await runWeeklyDigest({
      client,
      config,
      store,
      logger: silentLogger,
      now: NOW,
      rows: buildRows([CYCLE_PAGE, SPIKE_PAGE, DIP_PAGE]),
    });

    assert.strictEqual(result.status, 'posted-digest');
    assert.strictEqual(posts.length, 3);
    assert.ok(posts.every((p) => p.channel === 'CALERTS'));
    assert.strictEqual(posts[0].thread_ts, undefined);
    assert.ok(posts.slice(1).every((p) => p.thread_ts === result.ts));
    assert.ok(posts.slice(1).some((p) => p.text === '`/go/spiky` sessions jumped 100% vs. baseline'));
    const actions = posts[1].blocks.find((/** @type {any} */ b) => b.type === 'actions');
    assert.deepStrictEqual(
      actions.elements.map((/** @type {any} */ e) => e.action_id),
      ['alert_investigate', 'alert_snooze', 'alert_dismiss'],
    );
  });

  it('suppresses snoozed and dismissed anomalies', async () => {
    store.snooze(SPIKE_PAGE.page, 'sessions', new Date('2026-10-10T00:00:00Z'));
    store.dismiss(DIP_PAGE.page, 'cta_rate', 'dip', '2026-10-03');
    const { client, posts } = fakeClient();
    await runWeeklyDigest({
      client,
      config,
      store,
      logger: silentLogger,
      now: NOW,
      rows: buildRows([CYCLE_PAGE, SPIKE_PAGE, DIP_PAGE]),
    });
    assert.strictEqual(posts.length, 1);
    assert.ok(!posts[0].thread_ts);
  });

  it("doesn't post twice in the same week unless forced", async () => {
    const rows = buildRows([CYCLE_PAGE]);
    const { client, posts } = fakeClient();
    const args = { client, config, store, logger: silentLogger, now: NOW, rows };

    assert.strictEqual((await runWeeklyDigest(args)).status, 'posted-steady');
    assert.strictEqual((await runWeeklyDigest(args)).status, 'already-ran');
    assert.strictEqual((await runWeeklyDigest({ ...args, force: true })).status, 'posted-steady');
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(store.getLastDigestKey(), '2026-W41');
  });

  it('posts a one-line error to the alerts channel instead of throwing', async () => {
    const { client, posts } = fakeClient({ failFirst: true });
    const result = await runWeeklyDigest({
      client,
      config,
      store,
      logger: silentLogger,
      now: NOW,
      rows: buildRows([CYCLE_PAGE]),
    });
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].channel, 'CALERTS');
    assert.match(posts[0].text, /^:warning: .*channel_not_found$/);
    assert.strictEqual(store.getLastDigestKey(), null);
  });

  it('does nothing without ALERTS_CHANNEL_ID', async () => {
    const { client, posts } = fakeClient();
    const { config: off } = loadProactiveConfig({});
    const result = await runWeeklyDigest({ client, config: off, store, logger: silentLogger, now: NOW, rows: [] });
    assert.strictEqual(result.status, 'disabled');
    assert.strictEqual(posts.length, 0);
  });
});
