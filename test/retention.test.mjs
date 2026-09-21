import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRetentionPolicy, inferQaRetention } from '../src/retention.mjs';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2035-06-01T12:00:00Z');
const ago = days => new Date(now - days * DAY).toISOString();
const rawPolicy = (overrides = {}) => ({ purgeRuns: { value: 60 }, purgePullRequestRuns: { value: 30 },
  retainRunsPerProtectedBranch: { value: 2 }, ...overrides });
const policy = normalizeRetentionPolicy(rawPolicy());
const evidence = (overrides = {}) => ({ id: 501, pipelineId: 104, queuedAt: ago(71), finishedAt: ago(70),
  reason: 'manual', ...overrides });
const build = (id, overrides = {}) => ({ id, definition: { id: 104 }, status: 'completed', result: 'succeeded',
  queueTime: ago(10), finishTime: ago(9), ...overrides });
const runs = [build(601), build(602)];
const infer = (item = evidence(), rule = policy, options = {}) => inferQaRetention(item, rule, { now, runs, ...options });

test('retention policy reads actual project values without relying on limits or hardcoded defaults', () => {
  assert.deepEqual(policy, { runDays: 60, pullRequestDays: 30, minimumRuns: 2 });
  assert.deepEqual(normalizeRetentionPolicy(rawPolicy({ purgeRuns: { min: 1, max: 999, value: 90 },
    retainRunsPerProtectedBranch: { value: 0 } })), { runDays: 90, pullRequestDays: 30, minimumRuns: 0 });
  for (const invalid of [null, {}, { purgeRuns: { max: 60 } }]) assert.equal(normalizeRetentionPolicy(invalid), null);
  for (const key of ['purgeRuns', 'purgePullRequestRuns']) {
    for (const value of [0, -1, 1.5, '60', null, undefined, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(normalizeRetentionPolicy(rawPolicy({ [key]: { value } })), null, `${key}: ${value}`);
    }
  }
  for (const value of [-1, 1.5, '2', null, undefined, Infinity, NaN]) {
    assert.equal(normalizeRetentionPolicy(rawPolicy({ retainRunsPerProtectedBranch: { value } })), null, String(value));
  }
});

test('finish-based classification exposes age context without claiming the cause of deletion', () => {
  const result = infer();
  assert.deepEqual({ ...result, detail: undefined }, { status: 'past-retention', label: 'Past retention window',
    detail: undefined, retentionDays: 60, ageDays: 70, ageBasis: 'finished', minimumRuns: 2 });
  assert.match(result.detail, /Finished 70 days ago/);
  assert.match(result.detail, /current run retention period is 60 days/);
  assert.match(result.detail, /does not confirm why it was removed/);
  assert.equal(Object.hasOwn(result, 'result'), false);
  assert.equal(infer(evidence({ queuedAt: undefined })).ageBasis, 'finished');
});

test('queue-only evidence is explicitly an estimate and can never claim a known finish time', () => {
  for (const finishedAt of [undefined, null]) {
    const result = infer(evidence({ finishedAt }));
    assert.equal(result.label, 'Likely past retention window');
    assert.equal(result.ageBasis, 'queued');
    assert.equal(result.ageDays, 71);
    assert.match(result.detail, /Queued 71 days ago/);
    assert.match(result.detail, /Finish time is unavailable, so this is an estimate/);
  }
});

test('the age boundary is strictly older than the selected retention period and prefers finish time', () => {
  assert.equal(infer(evidence({ finishedAt: ago(60) })), null);
  assert.equal(infer(evidence({ finishedAt: ago(59) })), null);
  assert.equal(infer(evidence({ finishedAt: new Date(now - 60 * DAY - 1).toISOString() })).status, 'past-retention');
  assert.equal(infer(evidence({ queuedAt: ago(100), finishedAt: ago(1) })), null);
});

test('pull request rules use their own period and unknown reasons use the longer current rule', () => {
  const item = evidence({ queuedAt: ago(41), finishedAt: ago(40), reason: 'pullRequest' });
  assert.equal(infer(item).retentionDays, 30);
  assert.equal(infer({ ...item, reason: 'manual' }), null);
  for (const reason of [undefined, null, '', 'unknown', 'none', 256, 'unexpected']) {
    assert.equal(infer({ ...item, reason }), null, String(reason));
  }
  const longerPr = { ...policy, pullRequestDays: 90 };
  assert.equal(infer(evidence({ reason: undefined }), longerPr), null);
  assert.equal(infer(evidence({ reason: 'manual' }), longerPr).retentionDays, 60);
});

test('a current policy change alters classification without persisting an earlier estimate', () => {
  assert.equal(infer().status, 'past-retention');
  assert.equal(infer(evidence(), { ...policy, runDays: 90 }), null);
  assert.equal(infer(evidence(), { ...policy, minimumRuns: 3 }), null);
});

test('the recent-run minimum needs enough distinct actual newer completed successes from the same pipeline', () => {
  assert.equal(infer(evidence(), policy, { runs: [runs[0]] }), null);
  assert.equal(infer(evidence(), policy, { runs: [runs[0], runs[0]] }), null);
  assert.equal(infer(evidence(), policy, { runs: [] }), null);
  const invalid = [
    { definition: { id: 105 } }, { status: 'inProgress' }, { status: 'abandoned' },
    { result: 'failed' }, { result: 'canceled' }, { result: null }, { deleted: true },
    { queueTime: ago(70) }, { queueTime: ago(80) }, { queueTime: '' },
    { finishTime: null }, { finishTime: 'invalid' }, { finishTime: ago(-1) },
    { finishTime: ago(11) }, { id: 501 }, { id: null }, { id: '602' },
  ];
  for (const overrides of invalid) {
    assert.equal(infer(evidence(), policy, { runs: [runs[0], build(602, overrides)] }), null, JSON.stringify(overrides));
  }
  assert.equal(infer(evidence(), policy, { runs: [runs[0], build(602, { result: 'partiallySucceeded' })] }).status, 'past-retention');
  assert.equal(infer(evidence(), { ...policy, minimumRuns: 0 }, { runs: [] }).status, 'past-retention');
});

test('explicit retention exceptions prevent a retention inference', () => {
  assert.equal(infer(evidence({ keepForever: true })), null);
  assert.equal(infer(evidence({ retainedByRelease: true })), null);
  assert.equal(infer(evidence({ keepForever: false, retainedByRelease: false })).status, 'past-retention');
});

test('invalid, absent, contradictory or future dates do not create a retention label', () => {
  const invalid = [
    { queuedAt: undefined, finishedAt: undefined }, { queuedAt: null, finishedAt: null },
    { queuedAt: '' }, { queuedAt: 0 }, { queuedAt: 'invalid' }, { queuedAt: '2035' },
    { finishedAt: '' }, { finishedAt: 0 }, { finishedAt: 'invalid' },
    { queuedAt: '2035-02-30T12:00:00Z' }, { queuedAt: '2035-03-01T24:00:00Z' },
    { queuedAt: ago(1) }, { queuedAt: ago(-1), finishedAt: null }, { finishedAt: ago(-1) },
  ];
  for (const overrides of invalid) assert.equal(infer(evidence(overrides)), null, JSON.stringify(overrides));
  for (const invalidNow of [NaN, Infinity, 'invalid', '', null, 1e20]) {
    assert.equal(infer(evidence(), policy, { now: invalidNow }), null, String(invalidNow));
  }
  assert.equal(infer(evidence(), policy, { now: new Date(now).toISOString() }).status, 'past-retention');
});

test('invalid identities, settings and insufficient scan data fall back without throwing', () => {
  for (const item of [null, {}, evidence({ id: 0 }), evidence({ pipelineId: '104' })]) assert.equal(infer(item), null);
  for (const rule of [null, {}, { ...policy, runDays: 0 }, { ...policy, pullRequestDays: -1 },
    { ...policy, minimumRuns: 1.5 }]) assert.equal(infer(evidence(), rule), null);
  for (const invalidRuns of [undefined, null, {}]) assert.equal(infer(evidence(), policy, { runs: invalidRuns }), null);
});
