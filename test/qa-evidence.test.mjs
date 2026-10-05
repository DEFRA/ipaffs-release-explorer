import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard } from '../src/model.mjs';

const at = minute => `2035-03-15T12:${String(minute).padStart(2, '0')}:00Z`;
const commit = 'a'.repeat(40);
const parent = (id = 1, environment = 'DEV', overrides = {}) => ({
  id, _kind: environment === 'DEV' ? 'dev' : 'release', definition: { id: environment === 'DEV' ? 101 : 102 },
  buildNumber: '20350315.1', sourceBranch: environment === 'DEV' ? 'refs/heads/master' : 'refs/tags/4.2.0',
  sourceVersion: commit, status: 'completed', result: 'succeeded', queueTime: at(1), ...overrides,
});
const child = (id = 11, environment = 'DEV', overrides = {}) => ({
  id, _kind: environment === 'DEV' ? 'qaDev' : 'qaTst', definition: { id: environment === 'DEV' ? 103 : 104 },
  sourceBranch: 'refs/heads/main', sourceVersion: 'b'.repeat(40), reason: 'resourceTrigger',
  triggerInfo: { alias: 'deployment', artifactType: 'Pipeline', pipelineId: '1', pipelineTriggerType: 'PipelineCompletion',
    branch: environment === 'DEV' ? 'refs/heads/master' : 'refs/tags/4.2.0' },
  queueTime: at(6), startTime: at(7), finishTime: at(20), status: 'completed', result: 'succeeded', ...overrides,
});
const stage = (environment, overrides = {}) => ({ id: `${environment}-stage`, type: 'Stage', identifier: `${environment}_DeployChart`,
  state: 'completed', result: 'succeeded', startTime: at(2), finishTime: at(4), attempt: 1, ...overrides });
const job = (environment, overrides = {}) => ({ id: `${environment}-job`, parentId: `${environment}-stage`, type: 'Job',
  identifier: `${environment}_DeployChart.DeployChart`, state: 'completed', result: 'succeeded',
  startTime: at(2), finishTime: at(4), attempt: 1, ...overrides });
const marker = (environment, overrides = {}) => ({ id: `${environment}-ready`, type: 'Stage', identifier: `QA_${environment}_Ready`,
  state: 'completed', result: 'succeeded', startTime: at(4), finishTime: at(5), ...overrides });
const details = (environment = 'DEV', overrides = {}) => ({
  timeline: { records: [stage(environment), job(environment), marker(environment),
    { id: 'resolver', type: 'Task', name: 'Resolve namespace', state: 'completed', result: 'succeeded', log: { id: 27 } }] },
  logs: [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: dev' }], ...overrides,
});
const available = { availability: 'available', total: 10, passed: 8, failed: 1, skipped: 1, other: 0, executed: 9, passPercentage: 88.9 };
const dashboard = (builds = [parent(), child()], entries = [[1, details()]], extra = {}) => buildDashboard({
  builds, details: new Map(entries), organization: 'test-org', project: 'test-project',
  qaSummaries: new Map([[11, available]]), ...extra,
});
const environment = (data, name = 'DEV') => data.environments.find(item => item.name === name);

test('native completion trigger attaches test evidence to the exact deployed environment and child result', () => {
  const data = dashboard();
  const qa = environment(data).lastSuccess.qa;
  assert.equal(qa.state, 'linked');
  assert.equal(qa.latest.id, 11);
  assert.equal(qa.latest.environment, 'DEV');
  assert.deepEqual(qa.latest.summary, available);
  assert.equal(qa.latest.revisionVerified, false);
  assert.equal('testedCommit' in qa.latest, false);
  assert.equal(new URL(qa.latest.resultsUrl).searchParams.get('buildId'), '11');
  assert.equal(new URL(qa.latest.resultsUrl).searchParams.get('view'), 'ms.vss-test-web.build-test-results-tab');
  assert.deepEqual(data.runs.find(run => run.id === 1).qaLinks, qa.runs);
  assert.deepEqual(data.namespaces[0].lastSuccess.qa, qa);
});

test('manual, scheduled and unrelated resource selections cannot claim version-specific test evidence', () => {
  for (const overrides of [
    { reason: 'manual' }, { reason: 'schedule' }, { reason: 'buildCompletion' },
    { triggerInfo: { ...child().triggerInfo, alias: 'another-pipeline' } },
    { triggerInfo: { ...child().triggerInfo, pipelineTriggerType: 'BuildCompletion' } },
    { triggerInfo: { ...child().triggerInfo, artifactType: 'Repository' } },
    { triggerInfo: { ...child().triggerInfo, pipelineId: '999' } },
    { triggerInfo: { ...child().triggerInfo, branch: 'refs/heads/another-branch' } },
    { _kind: 'qa' },
  ]) {
    const data = dashboard([parent(), child(11, 'DEV', overrides)]);
    assert.equal(environment(data).lastSuccess.qa.state, 'not-linked', JSON.stringify(overrides));
    assert.deepEqual(data.runs.find(run => run.id === 1).qaLinks, []);
  }
});

test('fixed QA environment cannot attach to another kind of deployment parent', () => {
  const data = dashboard([parent(), child(11, 'TST', { triggerInfo: child().triggerInfo })]);
  assert.equal(environment(data).lastSuccess.qa.state, 'not-linked');
});

test('DEV branch namespaces do not inherit canonical DEV QA', () => {
  const entry = details();
  entry.logs[0].text = 'Using namespace: feature-example';
  const data = dashboard([parent(), child()], [[1, entry]]);
  assert.equal(data.namespaces[0].name, 'feature-example');
  assert.equal(data.namespaces[0].lastSuccess.qa.state, 'not-linked');
});

test('missing or failed readiness marker never establishes a native deployment association', () => {
  for (const markerOverride of [null, { result: 'failed' }, { result: 'skipped' }, { finishTime: null }, { finishTime: at(9) }]) {
    const records = [stage('DEV'), job('DEV'), ...(markerOverride ? [marker('DEV', markerOverride)] : [])];
    assert.equal(environment(dashboard([parent(), child()], [[1, details('DEV', { timeline: { records } })]])).lastSuccess.qa.state, 'not-linked');
  }
});

test('a child queued before the deployment completes cannot be attached', () => {
  const data = dashboard([parent(), child(11, 'DEV', { queueTime: at(3) })]);
  assert.equal(environment(data).lastSuccess.qa.state, 'not-linked');
});

test('earlier passing tests never move to a later deployment attempt in the same run', () => {
  const records = [stage('DEV', { attempt: 2, startTime: at(25), finishTime: at(27) }),
    job('DEV'), job('DEV', { id: 'retry', attempt: 2, startTime: at(25), finishTime: at(27) }), marker('DEV'),
    marker('DEV', { id: 'retry-ready', attempt: 2, startTime: at(27), finishTime: at(28) })];
  const data = dashboard([parent(), child()], [[1, details('DEV', { timeline: { records } })]]);
  assert.equal(environment(data).lastSuccess.attempt, 2);
  assert.equal(environment(data).lastSuccess.qa.state, 'not-linked');
  assert.equal(data.runs.find(run => run.id === 1).qaLinks[0].id, 11);
  const withRetry = dashboard([parent(), child(), child(12, 'DEV', { queueTime: at(29), status: 'inProgress', result: null, finishTime: null })],
    [[1, details('DEV', { timeline: { records } })]]);
  assert.equal(environment(withRetry).lastSuccess.qa.latest.id, 12);
  assert.equal(environment(withRetry).lastSuccess.qa.latest.summary, null);
});

test('a failed or active retry prevents newly queued QA borrowing the older successful attempt', () => {
  for (const result of ['failed', null]) {
    const records = [stage('DEV'), job('DEV'), marker('DEV'),
      job('DEV', { id: 'retry', attempt: 2, startTime: at(5), finishTime: result ? at(5) : null, result, state: result ? 'completed' : 'inProgress' })];
    const data = dashboard([parent(), child()], [[1, details('DEV', { timeline: { records } })]]);
    assert.equal(environment(data).lastSuccess.qa.state, 'not-linked');
    assert.equal(environment(data).latestAttempt.qa.state, 'not-linked');
  }
});

test('latest failed, cancelled or running QA is shown instead of an older passing run', () => {
  for (const [status, result] of [['completed', 'failed'], ['completed', 'canceled'], ['inProgress', null]]) {
    const data = dashboard([parent(), child(), child(12, 'DEV', { queueTime: at(21), finishTime: result ? at(24) : null, status, result })]);
    const qa = environment(data).lastSuccess.qa;
    assert.deepEqual(qa.runs.map(run => run.id), [12, 11]);
    assert.equal(qa.latest.result, result);
    assert.equal(qa.latest.summary, null);
  }
});

test('test API unavailability stays separate from the pipeline result', () => {
  const unavailable = { availability: 'unavailable' };
  const qa = environment(dashboard(undefined, undefined, { qaSummaries: new Map([[11, unavailable]]) })).lastSuccess.qa.latest;
  assert.equal(qa.result, 'succeeded');
  assert.deepEqual(qa.summary, unavailable);
});

test('abandoned native runs retain their abandonment even when an earlier successful result remains', () => {
  for (const status of ['abandoned', 16]) {
    const data = dashboard([parent(), child(11, 'DEV', { status, result: 'succeeded' })]);
    const qa = environment(data).lastSuccess.qa.latest;
    assert.equal(qa.abandonment, 'abandoned');
    assert.equal(qa.result, 'succeeded');
  }
});

test('TST evidence follows the exact release deployment into history without appearing as PRE or PRD tests', () => {
  const records = [stage('TST'), job('TST'), marker('TST'), stage('PRE'), job('PRE'), stage('PRD'), job('PRD')];
  const data = dashboard([parent(1, 'TST'), child(11, 'TST'), parent(2, 'TST', { sourceBranch: 'refs/tags/4.3.0' })],
    [[1, details('TST', { timeline: { records } })], [2, details('TST', { timeline: { records: [stage('PRD'), job('PRD')] } })]]);
  assert.equal(environment(data, 'TST').lastSuccess.qa.latest.id, 11);
  assert.equal(environment(data, 'PRE').lastSuccess.qa.state, 'not-linked');
  assert.equal(environment(data, 'PRD').lastSuccess.qa.state, 'not-linked');
  const release = data.previousReleases.find(item => item.version === '4.2.0');
  assert.equal(release.progress.find(item => item.environment === 'TST').lastSuccess.qa.latest.id, 11);
  assert.equal(data.previousReleases.find(item => item.version === '4.3.0').progress.find(item => item.environment === 'TST').lastSuccess, null);
});

const legacyDetail = (environment = 'TST') => details(environment, { timeline: { records: [stage(environment), job(environment),
  { id: 'legacy-stage', type: 'Stage', identifier: 'TriggerQAAutomation', state: 'completed', result: 'succeeded' },
  { id: 'queue-task', type: 'Task', parentId: 'legacy-stage', name: 'Trigger QA pipeline', state: 'completed', result: 'succeeded',
    startTime: at(5), finishTime: at(7), log: { id: 29 } }] },
  logs: [{ id: 29, recordName: 'Trigger QA pipeline', text: JSON.stringify({ id: 11, definition: { id: 105 }, queueTime: at(6) }) }],
});
const legacyChild = (environment = 'TST') => child(11, environment, { _kind: 'qa', definition: { id: 105 }, reason: 'manual',
  templateParameters: { environmentName: environment }, triggerInfo: undefined });

test('legacy explicit TST queue evidence retains its result summary and environment association', () => {
  const data = dashboard([parent(1, 'TST'), legacyChild()], [[1, legacyDetail()]]);
  const qa = environment(data, 'TST').lastSuccess.qa;
  assert.equal(qa.latest.id, 11);
  assert.deepEqual(qa.latest.summary, available);
});

test('legacy environment selector disagreement and unrelated queue ancestry stay unlinked', () => {
  const mismatch = dashboard([parent(1, 'TST'), legacyChild('DEV')], [[1, legacyDetail()]]);
  assert.equal(environment(mismatch, 'TST').lastSuccess.qa.state, 'not-linked');
  const unrelated = legacyDetail();
  unrelated.timeline.records.find(record => record.id === 'legacy-stage').identifier = 'UnrelatedStage';
  const data = dashboard([parent(1, 'TST'), legacyChild()], [[1, unrelated]]);
  assert.equal(environment(data, 'TST').lastSuccess.qa.state, 'not-linked');
  assert.equal(data.runs.find(run => run.id === 1).qaLinks.length, 1);
});

test('legacy DEV selector can associate only with a canonical DEV deployment', () => {
  const data = dashboard([parent(), legacyChild('DEV')], [[1, legacyDetail('DEV')]]);
  assert.equal(environment(data).lastSuccess.qa.latest.environment, 'DEV');
  const mismatched = dashboard([parent(), legacyChild('TST')], [[1, legacyDetail('DEV')]]);
  assert.equal(environment(mismatched).lastSuccess.qa.state, 'not-linked');
});

test('a retained legacy queue record carries missing-run retention context beside that environment', () => {
  const availability = { status: 'past-retention', label: 'Likely past retention window', detail: 'Synthetic retained queue evidence.' };
  const data = dashboard([parent(1, 'TST')], [[1, legacyDetail()]], { qaAvailability: new Map([[11, availability]]), qaSummaries: new Map() });
  const qa = environment(data, 'TST').lastSuccess.qa.latest;
  assert.deepEqual(qa.availability, availability);
  assert.equal(qa.result, null);
  assert.equal(qa.summary, null);
});
