import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryMetrics } from '../src/delivery.mjs';
import { buildDashboard } from '../src/model.mjs';

// Synthetic versions, commits and dates relative to a fixed scan time.
const HOUR = 3600000, DAY = 24 * HOUR;
const now = Date.parse('2035-06-30T12:00:00Z');
const at = hours => new Date(now - hours * HOUR).toISOString();
const commit = digit => String(digit).repeat(40);
const deployment = (runId, environment, version, status, hours, overrides = {}) => ({
  runId, environment, namespace: environment.toLowerCase(), version, status, attempt: 1, commit: commit(Number(version.split('.')[2]) % 10),
  versionKind: environment === 'DEV' ? 'build-number' : 'release-tag', sourceRef: environment === 'DEV' ? 'refs/heads/master' : `refs/tags/${version}`,
  startedAt: at(hours + 0.5), finishedAt: at(hours), url: `https://dev.azure.com/example/SAMPLE/_build/results?buildId=${runId}`, ...overrides,
});
const created = (version, hours, overrides = {}) => ({ version, commit: commit(Number(version.split('.')[2]) % 10), outcome: 'created', observedAt: at(hours), runId: 900, url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=900', ...overrides });
const metrics = (deployments, releases = [], coverageStart = at(200 * 24)) => deliveryMetrics({ deployments, releases, coverageStart, now });
const period = (data, days) => data.windows.find(item => item.days === days);

test('frequency counts successful PRD stage attempts once, including redeployments', () => {
  const data = metrics([
    deployment(1, 'PRD', '1.0.1', 'succeeded', 48),
    deployment(1, 'PRD', '1.0.1', 'succeeded', 48, { finishedAt: at(47) }),
    deployment(2, 'PRD', '1.0.1', 'succeeded', 24),
    deployment(3, 'PRD', '1.0.2', 'failed', 12),
    deployment(4, 'PRD', '1.0.2', 'inProgress', 1, { finishedAt: null }),
  ]);
  const thirty = period(data, 30);
  assert.equal(thirty.prd.deployments, 2);
  assert.equal(thirty.prd.releases, 1);
  assert.equal(thirty.prd.perWeek, Math.round(2 / (30 / 7) * 10) / 10);
  assert.deepEqual(thirty.environments.find(item => item.environment === 'PRD'), { environment: 'PRD', succeeded: 2, failed: 1, canceled: 0, rate: 1 / 3 });
});

test('a failed job fails its stage attempt and canceled attempts are excluded from the failure rate', () => {
  const data = metrics([
    deployment(1, 'PRD', '1.0.1', 'succeeded', 30),
    deployment(1, 'PRD', '1.0.1', 'failed', 30),
    deployment(2, 'PRD', '1.0.1', 'canceled', 20),
    deployment(3, 'PRD', '1.0.1', 'succeeded', 10),
  ]);
  const thirty = period(data, 30);
  assert.deepEqual(thirty.failureRate, { failed: 1, succeeded: 1, rate: 0.5, rollbacks: 0 });
  assert.equal(thirty.environments.find(item => item.environment === 'PRD').canceled, 1);
});

test('branch namespaces never count as canonical DEV deployments', () => {
  const data = metrics([
    deployment(1, 'DEV', 'build-1', 'succeeded', 5),
    deployment(2, 'DEV', 'build-2', 'succeeded', 4, { namespace: 'feature-x' }),
  ]);
  assert.equal(period(data, 30).environments.find(item => item.environment === 'DEV').succeeded, 1);
});

test('lead time runs from recorded tag creation to the first successful PRD deployment of that tag', () => {
  const data = metrics([
    deployment(1, 'TST', '1.0.1', 'succeeded', 90),
    deployment(1, 'PRE', '1.0.1', 'succeeded', 80),
    deployment(1, 'PRD', '1.0.1', 'failed', 72),
    deployment(1, 'PRD', '1.0.1', 'succeeded', 70, { attempt: 2 }),
    deployment(2, 'PRD', '1.0.1', 'succeeded', 10),
    deployment(3, 'PRD', '1.0.2', 'succeeded', 5),
    deployment(4, 'PRD', '1.0.3', 'succeeded', 2),
  ], [
    created('1.0.1', 100), created('1.0.2', 9),
    created('1.0.2', 8, { outcome: 'already-present' }),
    created('1.0.3', 1),
  ]);
  const [latest, second, first] = data.releases;
  assert.deepEqual([first.version, second.version, latest.version], ['1.0.1', '1.0.2', '1.0.3']);
  assert.equal(first.leadMs, 30 * HOUR);
  assert.equal(first.firstPrd.attempt, 2);
  assert.equal(first.firstTst.at, at(90));
  assert.equal(first.firstPre.at, at(80));
  assert.equal(second.leadMs, 4 * HOUR);
  // A deployment before the recorded creation time cannot produce a lead time.
  assert.equal(latest.leadMs, null);
  assert.deepEqual(period(data, 30).leadTime, { count: 2, notRecorded: 1, medianMs: 17 * HOUR, minMs: 4 * HOUR, maxMs: 30 * HOUR });
});

test('candidates record first stage successes and whether a later version replaced them', () => {
  const data = metrics([
    deployment(1, 'TST', '1.0.1', 'succeeded', 90),
    deployment(1, 'PRE', '1.0.1', 'succeeded', 80),
    deployment(1, 'PRD', '1.0.1', 'failed', 71),
    deployment(1, 'PRD', '1.0.1', 'succeeded', 70, { attempt: 2 }),
    deployment(2, 'TST', '1.0.2', 'succeeded', 60),
    deployment(3, 'TST', '1.0.3', 'succeeded', 40),
    deployment(4, 'TST', '1.0.4', 'succeeded', 5),
    deployment(5, 'DEV', '1.0.5', 'succeeded', 2),
  ], [created('1.0.1', 100)]);
  const byVersion = Object.fromEntries(data.candidates.map(row => [row.version, row]));
  assert.deepEqual(data.candidates.map(row => row.version), ['1.0.1', '1.0.2', '1.0.3', '1.0.4']);
  assert.equal(byVersion['1.0.1'].outcome, 'production');
  assert.equal(byVersion['1.0.1'].created.at, at(100));
  assert.deepEqual([byVersion['1.0.1'].tst.at, byVersion['1.0.1'].pre.at, byVersion['1.0.1'].prd.at], [at(90), at(80), at(70)]);
  assert.deepEqual(byVersion['1.0.1'].failed.map(row => [row.environment, row.at]), [['PRD', at(71)]]);
  assert.deepEqual(byVersion['1.0.1'].deployments.map(row => [row.environment, row.status]),
    [['TST', 'succeeded'], ['PRE', 'succeeded'], ['PRD', 'failed'], ['PRD', 'succeeded']]);
  assert.equal(byVersion['1.0.2'].outcome, 'replaced');
  assert.equal(byVersion['1.0.2'].created, null);
  assert.equal(byVersion['1.0.3'].outcome, 'replaced');
  assert.equal(byVersion['1.0.4'].outcome, 'in-progress');
});

test('releases without retained creation evidence are reported rather than given a lead time', () => {
  const data = metrics([deployment(1, 'PRD', '1.0.1', 'succeeded', 5)]);
  assert.equal(data.releases[0].created, null);
  assert.deepEqual(period(data, 30).leadTime, { count: 0, notRecorded: 1, medianMs: null, minMs: null, maxMs: null });
});

test('consecutive PRD failures form one interruption until the next success of any version', () => {
  const data = metrics([
    deployment(1, 'PRD', '1.0.2', 'failed', 50),
    deployment(1, 'PRD', '1.0.2', 'failed', 49, { attempt: 2 }),
    deployment(2, 'PRD', '1.0.1', 'succeeded', 45),
    deployment(3, 'PRD', '1.0.3', 'failed', 3),
  ]);
  const [open, restored] = data.failures;
  assert.equal(restored.failedAttempts, 2);
  assert.equal(restored.recoveryMs, 5 * HOUR);
  assert.equal(restored.recovered.version, '1.0.1');
  assert.equal(open.recovered, null);
  assert.equal(open.recoveryMs, null);
  assert.deepEqual(period(data, 30).recovery, { count: 1, unresolved: 1, medianMs: 5 * HOUR });
});

test('a lower version deployed after a higher one is a rollback; an equal redeployment is not', () => {
  const data = metrics([
    deployment(1, 'PRD', '1.0.9', 'succeeded', 40),
    deployment(2, 'PRD', '1.0.10', 'succeeded', 30),
    deployment(3, 'PRD', '1.0.10', 'succeeded', 20),
    deployment(4, 'PRD', '1.0.9', 'succeeded', 10),
  ]);
  assert.equal(data.rollbacks.length, 1);
  assert.deepEqual([data.rollbacks[0].version, data.rollbacks[0].previousVersion], ['1.0.9', '1.0.10']);
  assert.equal(period(data, 30).failureRate.rollbacks, 1);
});

test('periods are bounded by the scanned release history', () => {
  const data = metrics([deployment(1, 'PRD', '1.0.1', 'succeeded', 24 * 40)], [], at(24 * 45));
  const [thirty, ninety] = data.windows;
  assert.equal(thirty.partial, false);
  assert.equal(thirty.prd.deployments, 0);
  assert.equal(ninety.partial, true);
  assert.equal(ninety.coveredDays, 45);
  assert.equal(ninety.coveredFrom, at(24 * 45));
  assert.equal(ninety.prd.perWeek, Math.round(1 / (45 / 7) * 10) / 10);
  const none = deliveryMetrics({ deployments: [], now });
  assert.equal(none.windows[0].coveredFrom, null);
  assert.equal(none.windows[0].partial, true);
  assert.equal(none.windows[0].prd.perWeek, null);
});

test('rows outside the longest period are omitted', () => {
  const data = metrics([deployment(1, 'PRD', '1.0.1', 'failed', 24 * 95), deployment(2, 'PRD', '1.0.1', 'succeeded', 24 * 94)]);
  assert.deepEqual([data.releases, data.failures], [[], []]);
});

test('the dashboard derives delivery metrics from release runs and creation logs', () => {
  const sha = 'a'.repeat(40);
  const day = value => `2035-03-${String(value).padStart(2, '0')}T12:00:00Z`;
  const iso = value => new Date(day(value)).toISOString();
  const records = environment => [
    { id: `stage-${environment}`, type: 'Stage', identifier: `${environment}_DeployChart`, state: 'completed', result: 'succeeded', startTime: day(9), finishTime: day(9), attempt: 1 },
    { id: `phase-${environment}`, parentId: `stage-${environment}`, type: 'Phase', identifier: `${environment}_DeployChart.DeployChart` },
    { id: `job-${environment}`, parentId: `phase-${environment}`, type: 'Job', identifier: `${environment}_DeployChart.DeployChart.__default`, state: 'completed', result: 'succeeded', startTime: day(9), finishTime: day(environment === 'PRD' ? 10 : 8), attempt: 1 },
  ];
  const builds = [
    { id: 1, _kind: 'create', definition: { id: 102, name: 'Create Release' }, sourceBranch: 'refs/heads/master', sourceVersion: sha, status: 'completed', result: 'succeeded', queueTime: day(5), finishTime: day(5) },
    { id: 2, _kind: 'release', definition: { id: 103, name: 'Release Pipeline' }, sourceBranch: 'refs/tags/4.2.0', sourceVersion: sha, status: 'completed', result: 'succeeded', queueTime: day(7), startTime: day(7), finishTime: day(10) },
  ];
  const details = new Map([
    [1, { timeline: { records: [{ id: 'release-task', type: 'Task', name: 'Create release branch or next patch tag', state: 'completed', result: 'succeeded', finishTime: day(6), log: { id: 17 } }] },
      logs: [{ id: 17, recordName: 'Create release branch or next patch tag', text: `Created tag '4.2.0' at ${sha}` }] }],
    [2, { timeline: { records: [...records('TST'), ...records('PRE'), ...records('PRD')] }, logs: [] }],
  ]);
  const { delivery } = buildDashboard({ builds, details, organization: 'test-org', project: 'test-project', fetchedAt: day(15) });
  assert.equal(delivery.coverageStart, iso(7));
  const [row] = delivery.releases;
  assert.equal(row.version, '4.2.0');
  assert.equal(row.created.at, iso(6));
  assert.equal(row.firstPrd.at, iso(10));
  assert.equal(row.leadMs, 4 * DAY);
  const thirty = period(delivery, 30);
  assert.equal(thirty.prd.deployments, 1);
  assert.equal(thirty.partial, true);
  assert.equal(thirty.coveredDays, 8);
});
