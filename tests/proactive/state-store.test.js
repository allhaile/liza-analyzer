import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { loadProactiveConfig } from '../../proactive/config.js';
import { possibleCauses } from '../../proactive/known-events.js';
import { ProactiveStore } from '../../proactive/state-store.js';

const anomaly = /** @type {any} */ ({
  page: '/go/bolt-js',
  metric: 'cta_rate',
  direction: 'dip',
  start_date: '2026-10-01',
  end_date: '2026-10-03',
});

describe('ProactiveStore', () => {
  /** @type {string} */
  let file;

  beforeEach(() => {
    file = path.join(mkdtempSync(path.join(tmpdir(), 'liza-')), 'state.json');
  });

  it('persists the last digest key across instances', () => {
    new ProactiveStore(file).setLastDigestKey('2026-W43');
    assert.strictEqual(new ProactiveStore(file).getLastDigestKey(), '2026-W43');
  });

  it('suppresses a snoozed page and metric until the snooze ends', () => {
    const store = new ProactiveStore(file);
    store.snooze('/go/bolt-js', 'cta_rate', new Date('2026-10-10T00:00:00Z'));
    assert.ok(store.isSuppressed(anomaly, new Date('2026-10-09T00:00:00Z')));
    assert.ok(!store.isSuppressed(anomaly, new Date('2026-10-11T00:00:00Z')));
    assert.ok(!store.isSuppressed({ ...anomaly, metric: 'sessions' }, new Date('2026-10-09T00:00:00Z')));
  });

  it('suppresses a dismissed move and its continuation, but not a later move', () => {
    const store = new ProactiveStore(file);
    store.dismiss('/go/bolt-js', 'cta_rate', 'dip', '2026-10-03');
    assert.ok(new ProactiveStore(file).isSuppressed(anomaly));
    assert.ok(store.isSuppressed({ ...anomaly, start_date: '2026-10-04', end_date: '2026-10-05' }));
    assert.ok(!store.isSuppressed({ ...anomaly, start_date: '2026-10-12', end_date: '2026-10-13' }));
    assert.ok(!store.isSuppressed({ ...anomaly, direction: 'spike' }));
  });

  it('starts fresh on a corrupt state file', () => {
    writeFileSync(file, '{not json');
    assert.strictEqual(new ProactiveStore(file).getLastDigestKey(), null);
  });
});

describe('possibleCauses', () => {
  const events = [{ date: '2026-04-14', label: 'slack.dev redesign launch' }];

  it('matches events within 2 days of the anomaly', () => {
    assert.deepStrictEqual(possibleCauses({ start_date: '2026-04-16', end_date: '2026-04-17' }, events), [
      'slack.dev redesign launch',
    ]);
    assert.deepStrictEqual(possibleCauses({ start_date: '2026-04-10', end_date: '2026-04-12' }, events), [
      'slack.dev redesign launch',
    ]);
    assert.deepStrictEqual(possibleCauses({ start_date: '2026-04-17', end_date: '2026-04-18' }, events), []);
  });
});

describe('loadProactiveConfig', () => {
  it('uses defaults and leaves proactive mode off without ALERTS_CHANNEL_ID', () => {
    const { config, warnings } = loadProactiveConfig({});
    assert.strictEqual(config.alertsChannelId, null);
    assert.strictEqual(config.digestCron, '0 9 * * 1');
    assert.strictEqual(config.digestTimezone, 'America/New_York');
    assert.deepStrictEqual(
      [
        config.zThreshold,
        config.minSessions,
        config.minPersistenceDays,
        config.bigMoveMultiplier,
        config.steadyBandPct,
      ],
      [2, 50, 2, 1.5, 10],
    );
    assert.deepStrictEqual(warnings, []);
  });

  it('reads overrides and warns on invalid numbers', () => {
    const { config, warnings } = loadProactiveConfig({
      ALERTS_CHANNEL_ID: 'C1',
      Z_THRESHOLD: '3',
      MIN_SESSIONS: 'lots',
    });
    assert.strictEqual(config.alertsChannelId, 'C1');
    assert.strictEqual(config.zThreshold, 3);
    assert.strictEqual(config.minSessions, 50);
    assert.strictEqual(warnings.length, 1);
  });
});
