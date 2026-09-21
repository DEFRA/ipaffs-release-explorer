import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDashboard, parseReleaseEvidence, parseQaRunEvidence } from '../src/model.mjs';

// Synthetic IDs, commits, versions and dates; log formats exercise the ADO parser contract.
const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const at = day => `2035-03-${String(day).padStart(2, '0')}T12:00:00Z`;
const build = (id, overrides = {}) => ({ id, _kind: 'release', definition: { id: 103, name: 'Release Pipeline' }, buildNumber: '4.2.0', sourceBranch: 'refs/tags/4.2.0', sourceVersion: sha, status: 'completed', result: 'succeeded', queueTime: at(id), startTime: at(id), finishTime: at(id), ...overrides });
const stage = (environment, overrides = {}) => ({ id: `stage-${environment}`, parentId: null, type: 'Stage', name: `Deploy Helm Charts (${environment})`, identifier: `${environment}_DeployChart`, state: 'completed', result: 'succeeded', startTime: at(9), finishTime: at(9), attempt: 1, ...overrides });
const chartJob = (environment, overrides = {}) => ({ id: `job-${environment}`, parentId: `phase-${environment}`, type: 'Job', name: 'Deploy Helm Charts', identifier: `${environment}_DeployChart.DeployChart.__default`, state: 'completed', result: 'succeeded', startTime: at(9), finishTime: at(9), attempt: 1, ...overrides });
const phase = environment => ({ id: `phase-${environment}`, parentId: `stage-${environment}`, type: 'Phase', identifier: `${environment}_DeployChart.DeployChart` });
const chartTimeline = (environment, overrides = {}, stageOverrides = {}) => [stage(environment, stageOverrides), phase(environment), chartJob(environment, overrides)];
const detail = (records, logs = []) => ({ timeline: { records }, logs });
const model = (builds, entries = [], extra = {}) => buildDashboard({ builds, details: new Map(entries), organization: 'test-org', project: 'test-project', fetchedAt: at(15), ...extra });
const env = (data, name) => data.environments.find(item => item.name === name);
const releaseRecord = (overrides = {}) => ({ id: 'release-task', type: 'Task', name: 'Create release branch or next patch tag', state: 'completed', result: 'succeeded', finishTime: at(9), log: { id: 17 }, ...overrides });
const releaseBuild = (id, overrides = {}) => build(id, { _kind: 'create', definition: { id: 102, name: 'Create Release' }, sourceBranch: 'refs/heads/master', ...overrides });
const releaseLog = text => ({ id: 17, recordName: 'Create release branch or next patch tag', text });
const resolverRecord = (overrides = {}) => ({ id: 'resolver', type: 'Task', name: 'Resolve namespace', state: 'completed', result: 'succeeded', log: { id: 27 }, ...overrides });
const devBuild = (id, overrides = {}) => build(id, { _kind: 'dev', definition: { id: 101, name: 'Deploy DEV' }, sourceBranch: 'refs/heads/master', buildNumber: '20350315.6', ...overrides });

test('only post-push release evidence is parsed, including timestamped log lines', () => {
  const result = parseReleaseEvidence(`2035-03-09T12:17:49.65Z Release branch: RELEASE/4.2.x\n2035-03-09T12:17:49.66Z Created tag '4.2.10' at ${sha}\nCompleted. Branch 'RELEASE/4.2.x' and tag '4.2.10' are aligned to ${sha}.`);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], { version: '4.2.10', series: '4.2', commit: sha, branch: 'RELEASE/4.2.x', outcome: 'created', confidence: 'recorded' });
  assert.deepEqual(parseReleaseEvidence(`Next patch release: 4.2.11\ngit push rejected\nTag '4.2.11' already exists`), []);
});

test('release evidence rejects malformed versions and truncated SHAs', () => {
  assert.deepEqual(parseReleaseEvidence(`Created tag '4.02.0' at ${sha}\nCreated tag '4.2.0' at abcdef\nCreated tag '4.2.0' at ${sha}f`), []);
});

test('effective release commit comes from successful log, not the pipeline source commit', () => {
  const data = model([releaseBuild(1, { sourceVersion: otherSha })], [[1, detail([releaseRecord()], [releaseLog(`Created tag '4.2.0' at ${sha}`)])]]);
  assert.equal(data.releases[0].commit, sha);
  assert.equal(data.releases[0].confidence, 'recorded');
});

test('failed or unrelated tasks never establish successful release creation', () => {
  const text = `Created tag '4.2.0' at ${sha}`;
  const failed = model([releaseBuild(1, { result: 'failed' })], [[1, detail([releaseRecord({ result: 'failed' })], [releaseLog(text)])]]);
  assert.deepEqual(failed.releases, []);
  const unrelated = model([releaseBuild(1)], [[1, detail([releaseRecord({ name: 'Checkout' })], [{ id: 17, recordName: 'Checkout', text }])]]);
  assert.deepEqual(unrelated.releases, []);
});

test('verified no-ops deduplicate without replacing original creation time', () => {
  const data = model([releaseBuild(1), releaseBuild(2)], [
    [1, detail([releaseRecord({ finishTime: at(1) })], [releaseLog(`Created tag '4.2.0' at ${sha}`)])],
    [2, detail([releaseRecord({ finishTime: at(2) })], [releaseLog(`Commit ${sha} is already tagged '4.2.0'. No patch tag is required.`)])],
  ]);
  assert.equal(data.releases.length, 1);
  assert.equal(data.releases[0].outcome, 'created');
  assert.equal(data.releases[0].observedAt, at(1));
});

test('release version order is numeric and conflicting commits remain explicit', () => {
  const data = model([releaseBuild(1), releaseBuild(2), releaseBuild(3)], [
    [1, detail([releaseRecord()], [releaseLog(`Created tag '4.2.9' at ${sha}`)])],
    [2, detail([releaseRecord()], [releaseLog(`Created tag '4.2.10' at ${sha}`)])],
    [3, detail([releaseRecord()], [releaseLog(`Created tag '4.2.10' at ${otherSha}`)])],
  ]);
  assert.deepEqual(data.releases.map(item => item.version), ['4.2.10', '4.2.10', '4.2.9']);
  assert.ok(data.warnings.some(item => item.code === 'RELEASE_TAG_CONFLICT'));
});

test('successful TST/PRE are visible while overall release awaits PRD approval', () => {
  const records = [...chartTimeline('TST'), ...chartTimeline('PRE', { startTime: at(14), finishTime: at(14) }), stage('PRD', { state: 'pending', result: null, startTime: null, finishTime: null })];
  const data = model([build(1, { status: 'inProgress', result: null, finishTime: null })], [[1, detail(records)]]);
  assert.equal(env(data, 'TST').lastSuccess.version, '4.2.0');
  assert.equal(env(data, 'PRE').lastSuccess.finishedAt, at(14));
  assert.equal(env(data, 'PRD').lastSuccess, null);
  assert.equal(env(data, 'PRD').latestAttempt.status, 'pending');
  assert.equal(env(data, 'PRD').latestAttempt.startedAt, null);
});

test('a later failed deployment preserves last success', () => {
  const data = model([build(1), build(2, { result: 'failed' })], [
    [1, detail(chartTimeline('TST', { startTime: at(1), finishTime: at(1) }))],
    [2, detail(chartTimeline('TST', { startTime: at(2), finishTime: at(2), result: 'failed' }, { result: 'failed' }))],
  ]);
  assert.equal(env(data, 'TST').lastSuccess.runId, 1);
  assert.equal(env(data, 'TST').latestAttempt.runId, 2);
  assert.equal(env(data, 'TST').latestAttempt.status, 'failed');
});

test('Environment marker failures do not negate an actual successful DeployChart job', () => {
  const records = [...chartTimeline('TST', {}, { result: 'failed' }), { id: 'marker', parentId: 'stage-TST', type: 'Job', identifier: 'TST_DeployChart.RecordEnvironmentDeployment.__default', state: 'completed', result: 'failed' }];
  const data = model([build(1, { result: 'failed' })], [[1, detail(records)]]);
  assert.equal(env(data, 'TST').lastSuccess.status, 'succeeded');
  assert.match(env(data, 'TST').lastSuccess.evidence[0].label, /job/);
});

test('succeeded Environment marker or bootstrap cannot conceal actual application deployment failure', () => {
  const records = [...chartTimeline('TST', { result: 'failed' }, { result: 'failed' }), { id: 'marker', parentId: 'stage-TST', type: 'Job', identifier: 'TST_DeployChart.RecordEnvironmentDeployment.__default', state: 'completed', result: 'succeeded' }, { id: 'bootstrap', type: 'Job', identifier: 'TST_DeployBootstrap.DeployChart.__default', state: 'completed', result: 'succeeded' }];
  const data = model([build(1)], [[1, detail(records)]], { environmentRecords: [{ environmentName: 'TST', owner: { id: 9999 }, result: 'succeeded' }] });
  assert.equal(env(data, 'TST').lastSuccess, null);
  assert.equal(env(data, 'TST').latestAttempt.status, 'failed');
  assert.equal(env(data, 'TST').latestAttempt.evidence.some(item => item.type === 'environment'), false);
});

test('old retained stage-only records can establish a clearly labeled deployment result', () => {
  const data = model([build(1)], [[1, detail([stage('TST')])]]);
  assert.equal(env(data, 'TST').lastSuccess.status, 'succeeded');
  assert.match(env(data, 'TST').lastSuccess.evidence[0].label, /stage/);
});

test('skipped stages and whole-build success do not establish deployment success', () => {
  const data = model([build(1), build(2)], [[1, detail([stage('TST', { result: 'skipped', startTime: null, finishTime: null })])], [2, detail([])]]);
  assert.equal(env(data, 'TST').lastSuccess, null);
  assert.equal(env(data, 'TST').latestAttempt, null);
});

test('retry failures retain successful earlier job attempt if timeline evidence includes it', () => {
  const records = [...chartTimeline('TST', { attempt: 1, startTime: at(1), finishTime: at(1) }, { attempt: 2, result: 'failed' }), chartJob('TST', { id: 'job-TST-retry', attempt: 2, result: 'failed', startTime: at(2), finishTime: at(2) })];
  const data = model([build(1, { result: 'failed' })], [[1, detail(records)]]);
  assert.equal(env(data, 'TST').lastSuccess.attempt, 1);
  assert.equal(env(data, 'TST').latestAttempt.attempt, 2);
});

test('exact successful resolver overrides branch assumptions, including branch deploying canonical DEV', () => {
  const data = model([devBuild(1, { sourceBranch: 'refs/heads/feature/change' })], [[1, detail([...chartTimeline('DEV'), resolverRecord()], [{ id: 27, recordName: 'Resolve namespace', text: '2035-03-15T09:06:59.1Z Using namespace: dev\n' }])]]);
  assert.equal(env(data, 'DEV').lastSuccess.namespace, 'dev');
  assert.equal(data.namespaces[0].confidence, 'recorded');
  assert.equal(data.namespaces[0].branch, 'feature/change');
});

test('failed resolver is unknown even when log emitted a namespace before failure', () => {
  const data = model([devBuild(1, { result: 'failed' })], [[1, detail([resolverRecord({ result: 'failed' })], [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: dev\n' }])]]);
  assert.deepEqual(data.namespaces, []);
  assert.ok(data.warnings.some(item => item.code === 'UNKNOWN_DEV_NAMESPACE'));
});

test('a failed resolver retry cannot reuse namespace evidence from a previous successful attempt', () => {
  const records = [resolverRecord({ attempt: 1 }), resolverRecord({ id: 'resolver-retry', attempt: 2, result: 'failed', log: { id: 28 } })];
  const data = model([devBuild(1, { result: 'failed' })], [[1, detail(records, [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: dev\n' }])]]);
  assert.deepEqual(data.namespaces, []);
});

test('missing resolver logs permit clearly marked predictable inference but never arbitrary branch names', () => {
  const data = model([devBuild(1, { sourceBranch: 'refs/heads/RELEASE/4.2.x' }), devBuild(2, { sourceBranch: 'refs/heads/feature/unknown' })], [[1, detail(chartTimeline('DEV'))], [2, detail(chartTimeline('DEV'))]]);
  assert.equal(data.namespaces.length, 1);
  assert.equal(data.namespaces[0].name, '4-2-x');
  assert.equal(data.namespaces[0].confidence, 'inferred');
  assert.equal(env(data, 'DEV').lastSuccess, null);
});

test('QA child extraction handles timestamps and requires structured pipeline identity', () => {
  const json = JSON.stringify({ id: 503, name: 'TST--20350309.2', pipeline: { id: 104 } }, null, 2).split('\n').map(line => `2035-03-09T12:51:00.1Z ${line}`).join('\n');
  assert.deepEqual(parseQaRunEvidence(`Starting task\n${json}\nFinished task`), { id: 503, pipelineId: 104 });
  assert.equal(parseQaRunEvidence('Run 503 succeeded'), null);
  assert.equal(parseQaRunEvidence('{"id":503}'), null);
});

test('linked passing QA remains explicitly unverified against the deployed revision', () => {
  const records = [{ id: 'qa-task', type: 'Task', name: 'Trigger QA pipeline', state: 'completed', result: 'succeeded', log: { id: 29 } }];
  const data = model([build(1), build(2, { _kind: 'qa', definition: { id: 104, name: 'QA' } })], [[1, detail(records, [{ id: 29, recordName: 'Trigger QA pipeline', text: '{"id":2,"pipeline":{"id":104}}' }])]]);
  const linked = data.runs.find(run => run.id === 1).qaLinks[0];
  assert.equal(linked.result, 'succeeded');
  assert.equal(linked.revisionVerified, false);
  assert.equal('testedCommit' in linked, false);
});

test('configured pipeline kinds support arbitrary IDs and names', () => {
  const data = model([build(1, { definition: { id: 999, name: 'Alternate release' }, _kind: 'release' })], [[1, detail(chartTimeline('TST'))]]);
  assert.equal(env(data, 'TST').lastSuccess.runId, 1);
});

test('organization URL and slug both produce valid run links', () => {
  const byUrl = model([build(1)], [], { organization: 'https://dev.azure.com/test-org/' });
  const bySlug = model([build(1)]);
  assert.equal(byUrl.runs[0].url, bySlug.runs[0].url);
  assert.equal(byUrl.runs[0].url, 'https://dev.azure.com/test-org/test-project/_build/results?buildId=1');
});

test('QA runs without deployment timelines do not reduce deployment coverage', () => {
  const data = model([build(1), build(2, { _kind: 'qa', definition: { id: 104, name: 'QA' } })], [[1, detail(chartTimeline('TST'))]]);
  assert.equal(data.warnings.some(item => item.code === 'TIMELINE_COVERAGE'), false);
  assert.equal(data.coverage.find(item => item.label === 'Deployment history').status, 'available');
});

test('DEV run numbers are labeled as build numbers and preserve source ref', () => {
  const data = model([devBuild(1)], [[1, detail(chartTimeline('DEV'))]]);
  assert.equal(env(data, 'DEV').lastSuccess.versionKind, 'build-number');
  assert.equal(env(data, 'DEV').lastSuccess.sourceRef, 'refs/heads/master');
});

function candidateModel(runBuilds = [], entries = [], extra = {}) {
  return model([releaseBuild(20, { queueTime: at(1), sourceVersion: otherSha }), ...runBuilds], [
    [20, detail([releaseRecord()], [releaseLog(`Created tag '4.2.0' at ${sha}`)])], ...entries,
  ], extra);
}
const progress = (data, environment) => data.releases.find(item => item.version === '4.2.0').progress.find(item => item.environment === environment);
const gate = (environment, overrides = {}) => ({ id: `gate-${environment}`, type: 'Stage', identifier: `GateTo${environment}`, name: `Manual approval before ${environment}`, state: 'inProgress', result: null, attempt: 1, startTime: at(10), finishTime: null, ...overrides });

test('candidate progress always has DEV/TST/PRE/PRD and absent history is not a never-deployed claim', () => {
  const data = candidateModel([], [], { limits: { buildsTruncated: true } });
  assert.deepEqual(data.releases[0].progress.map(item => item.environment), ['DEV', 'TST', 'PRE', 'PRD']);
  assert.ok(data.releases[0].progress.every(item => item.status === 'not-recorded' && item.matchedBy === null));
  assert.match(progress(data, 'TST').detail, /loaded ADO history.*Older runs/);
});

test('candidate higher-environment progress requires exact tag and commit, even for same-SHA versions', () => {
  const data = candidateModel([build(1, { sourceBranch: 'refs/tags/4.2.1', sourceVersion: sha }), build(2, { sourceBranch: 'refs/tags/4.2.0', sourceVersion: otherSha })], [
    [1, detail(chartTimeline('TST'))], [2, detail(chartTimeline('PRE'))],
  ]);
  assert.equal(progress(data, 'TST').status, 'not-recorded');
  assert.equal(progress(data, 'PRE').status, 'not-recorded');
  assert.equal(progress(data, 'TST').lastSuccess, null);
});

test('branch build numbers and abbreviated commits cannot substitute for exact tagged source identity', () => {
  const data = candidateModel([build(1, { sourceBranch: 'refs/heads/RELEASE/4.2.x' }), build(2, { sourceVersion: sha.slice(0, 7) })], [[1, detail(chartTimeline('TST'))], [2, detail(chartTimeline('PRE'))]]);
  assert.equal(progress(data, 'TST').status, 'not-recorded');
  assert.equal(progress(data, 'PRE').status, 'not-recorded');
});

test('candidate DEV progress matches the full effective commit in any recorded namespace', () => {
  const data = candidateModel([devBuild(1, { sourceBranch: 'refs/heads/feature/fix', sourceVersion: sha })], [[1, detail([...chartTimeline('DEV'), resolverRecord()], [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: my-dev-test\n' }])]]);
  const item = progress(data, 'DEV');
  assert.equal(item.status, 'deployed');
  assert.equal(item.label, 'Commit deployed');
  assert.equal(item.matchedBy, 'commit');
  assert.equal(item.lastSuccess.namespace, 'my-dev-test');
  assert.match(item.detail, /not deployment of the release tag/);
});

test('older master deployment and inferred DEV namespace cannot establish candidate commit deployment', () => {
  const oldCommit = candidateModel([devBuild(1, { sourceVersion: otherSha })], [[1, detail([...chartTimeline('DEV'), resolverRecord()], [{ id: 27, text: 'Using namespace: dev' }])]]);
  assert.equal(progress(oldCommit, 'DEV').status, 'not-recorded');
  const missingResolver = candidateModel([devBuild(1, { sourceVersion: sha })], [[1, detail(chartTimeline('DEV'))]]);
  assert.equal(progress(missingResolver, 'DEV').status, 'unknown');
  assert.equal(progress(missingResolver, 'DEV').lastSuccess, null);
});

test('candidate progress follows its matching run rather than global latest deployed version', () => {
  const data = candidateModel([build(1, { queueTime: at(9) }), build(2, { sourceBranch: 'refs/tags/5.0.0', sourceVersion: otherSha, queueTime: at(11) })], [
    [1, detail(chartTimeline('TST', { startTime: at(9), finishTime: at(9) }))],
    [2, detail(chartTimeline('TST', { startTime: at(11), finishTime: at(11) }))],
  ]);
  assert.equal(env(data, 'TST').lastSuccess.version, '5.0.0');
  assert.equal(progress(data, 'TST').lastSuccess.version, '4.2.0');
  assert.equal(progress(data, 'TST').runId, 1);
  assert.equal(progress(data, 'TST').matchedBy, 'tag-and-commit');
});

test('active matching approval gate is distinct from a merely pending target', () => {
  const data = candidateModel([build(1, { status: 'inProgress', result: null })], [[1, detail([
    ...chartTimeline('TST'), stage('PRE', { state: 'pending', result: null, startTime: null, finishTime: null }), gate('PRE'),
    stage('PRD', { state: 'pending', result: null, startTime: null, finishTime: null }), gate('PRD', { state: 'pending', startTime: null }),
  ])]]);
  assert.equal(progress(data, 'PRE').status, 'awaiting-approval');
  assert.equal(progress(data, 'PRD').status, 'not-started');
  assert.equal(progress(data, 'TST').status, 'deployed');
  assert.match(progress(data, 'PRE').evidence[0].label, /Manual approval before PRE/);
});

test('a gate from another release or an older target attempt cannot invent approval state', () => {
  const data = candidateModel([build(1, { status: 'inProgress', result: null }), build(2, { sourceBranch: 'refs/tags/4.3.0' })], [
    [1, detail([stage('PRE', { state: 'pending', result: null, startTime: null, finishTime: null, attempt: 2 }), gate('PRE', { attempt: 1 }), stage('PRD', { state: 'pending', result: null, startTime: null, finishTime: null })])],
    [2, detail([gate('PRD')])],
  ]);
  assert.equal(progress(data, 'PRE').status, 'not-started');
  assert.equal(progress(data, 'PRD').status, 'not-started');
});

test('running deployment preparation is deploying while downstream stages remain not started', () => {
  const data = candidateModel([build(1, { status: 'inProgress', result: null })], [[1, detail([
    stage('TST', { state: 'pending', result: null, startTime: null, finishTime: null }),
    stage('TST', { id: 'bootstrap-stage', identifier: 'TST_DeployBootstrap', state: 'inProgress', result: null, finishTime: null }),
    stage('PRE', { state: 'pending', result: null, startTime: null, finishTime: null }), gate('PRE', { state: 'pending', startTime: null }),
  ])]]);
  assert.equal(progress(data, 'TST').status, 'deploying');
  assert.equal(progress(data, 'PRE').status, 'not-started');
});

test('later candidate failure keeps earlier success and includes both evidence sources', () => {
  const data = candidateModel([build(1, { queueTime: at(9) }), build(2, { queueTime: at(11), result: 'failed' })], [
    [1, detail(chartTimeline('TST', { startTime: at(9), finishTime: at(9) }))],
    [2, detail(chartTimeline('TST', { startTime: at(11), finishTime: at(11), result: 'failed' }, { result: 'failed' }))],
  ]);
  const item = progress(data, 'TST');
  assert.equal(item.status, 'failed');
  assert.equal(item.lastSuccess.runId, 1);
  assert.equal(item.latestAttempt.runId, 2);
  assert.match(item.detail, /earlier successful/);
  assert.ok(item.evidence.some(source => source.url.includes('buildId=1')));
  assert.ok(item.evidence.some(source => source.url.includes('buildId=2')));
});

test('missing newer matching timeline stays unknown while retaining older success', () => {
  const data = candidateModel([build(1, { queueTime: at(9) }), build(2, { queueTime: at(12) })], [[1, detail(chartTimeline('TST', { startTime: at(9), finishTime: at(9) }))]]);
  assert.equal(progress(data, 'TST').status, 'unknown');
  assert.equal(progress(data, 'TST').runId, 2);
  assert.equal(progress(data, 'TST').lastSuccess.runId, 1);
  assert.match(progress(data, 'TST').detail, /timeline is unavailable/);
});

test('a later pending or skipped retry does not erase known candidate deployment history', () => {
  const data = candidateModel([build(1, { queueTime: at(9) }), build(2, { queueTime: at(12), status: 'inProgress', result: null })], [
    [1, detail(chartTimeline('TST', { startTime: at(9), finishTime: at(9) }))],
    [2, detail([stage('TST', { state: 'pending', result: null, startTime: null, finishTime: null })])],
  ]);
  assert.equal(progress(data, 'TST').status, 'deployed');
  assert.equal(progress(data, 'TST').lastSuccess.runId, 1);
});

test('failed own environment preparation is failed and downstream environment is blocked', () => {
  const data = candidateModel([build(1, { result: 'failed' })], [[1, detail([
    stage('TST', { result: 'skipped', startTime: null, finishTime: null }),
    stage('TST', { id: 'failed-preparation', identifier: 'TST_DeployBootstrap', result: 'failed' }),
    stage('PRE', { result: 'skipped', startTime: null, finishTime: null }),
  ])]]);
  assert.equal(progress(data, 'TST').status, 'failed');
  assert.equal(progress(data, 'PRE').status, 'blocked');
});

test('a canceled stage in a failed run does not mean the candidate was abandoned', () => {
  const data = candidateModel([build(1, { result: 'failed' })], [[1, detail(chartTimeline('TST', { result: 'canceled' }, { result: 'canceled' }))]]);
  assert.equal(progress(data, 'TST').status, 'canceled');
  assert.equal(progress(data, 'TST').lastSuccess, null);
});

test('candidates whose matching release runs are all abandoned are hidden, including partial deployments', () => {
  for (const state of [
    { result: 'canceled' }, { result: 'cancelled' }, { result: 'abandoned' },
    { status: 'cancelling', result: null }, { status: 'canceling', result: null }, { status: 'abandoned', result: null },
  ]) {
    const data = candidateModel([build(1, state)], [[1, detail([...chartTimeline('TST'), gate('PRD')])]]);
    assert.deepEqual(data.releases, [], JSON.stringify(state));
    assert.equal(data.runs.some(run => run.id === 1), true);
    assert.equal(env(data, 'TST').lastSuccess.runId, 1);
  }
});

test('a newer abandoned retry cannot replace remaining candidate progress or add deployment evidence', () => {
  const data = candidateModel([build(1, { queueTime: at(9) }), build(2, { queueTime: at(12), result: 'canceled' })], [
    [1, detail(chartTimeline('TST', { startTime: at(9), finishTime: at(9) }))],
    [2, detail([...chartTimeline('TST', { startTime: at(12), finishTime: at(12) }), ...chartTimeline('PRE'), gate('PRD')])],
  ]);
  assert.equal(data.releases.length, 1);
  const tst = progress(data, 'TST');
  assert.equal(tst.status, 'deployed');
  assert.equal(tst.lastSuccess.runId, 1);
  assert.equal(tst.latestAttempt.runId, 1);
  assert.equal(tst.evidence.some(source => source.url.includes('buildId=2')), false);
  assert.equal(progress(data, 'PRE').lastSuccess, null);
  assert.notEqual(progress(data, 'PRD').status, 'awaiting-approval');
  assert.equal(env(data, 'TST').lastSuccess.runId, 2);
});

test('active and failed attempts after abandonment keep the candidate visible', () => {
  for (const remaining of [{ status: 'inProgress', result: null }, { status: 'completed', result: 'failed' }]) {
    const data = candidateModel([build(1, { result: 'canceled', queueTime: at(9) }), build(2, { ...remaining, queueTime: at(12) })], [
      [1, detail(chartTimeline('TST', { result: 'canceled' }))],
      [2, detail(chartTimeline('TST', { state: remaining.status, result: remaining.result, startTime: at(12), finishTime: null }, { state: remaining.status, result: remaining.result }))],
    ]);
    assert.equal(data.releases.length, 1);
    assert.equal(progress(data, 'TST').runId, 2);
    assert.equal(progress(data, 'TST').status, remaining.result === 'failed' ? 'failed' : 'deploying');
  }
});

test('abandonment applies only to the exact release tag and full commit', () => {
  const data = candidateModel([
    build(1, { result: 'canceled', sourceBranch: 'refs/tags/2044.2.0' }),
    build(2, { result: 'canceled', sourceVersion: otherSha }),
    build(3, { result: 'canceled', sourceVersion: sha.slice(0, 7) }),
  ]);
  assert.equal(data.releases.length, 1);
  assert.ok(data.releases[0].progress.every(item => item.status === 'not-recorded'));
});

test('an abandoned DEV run neither hides a candidate nor supplies commit deployment progress', () => {
  const data = candidateModel([devBuild(1, { result: 'canceled' })], [[1, detail([...chartTimeline('DEV'), resolverRecord()], [{ id: 27, text: 'Using namespace: dev\n' }])]]);
  assert.equal(data.releases.length, 1);
  assert.equal(progress(data, 'DEV').status, 'not-recorded');
  assert.equal(progress(data, 'DEV').lastSuccess, null);
  assert.equal(env(data, 'DEV').lastSuccess.runId, 1);
});

test('abandoned Create Release runs cannot supply candidates even with retained successful tag logs', () => {
  for (const state of [{ result: 'canceled' }, { status: 'cancelling' }, { status: 16 }, { status: 'abandoned' }]) {
    const data = model([releaseBuild(1, state)], [[1, detail([releaseRecord()], [releaseLog(`Created tag '4.2.0' at ${sha}`)])]]);
    assert.deepEqual(data.releases, []);
    assert.equal(data.runs.length, 1);
  }
});

test('abandoned successful creation and no-op runs cannot resurrect a candidate for the same tag', () => {
  const data = model([
    releaseBuild(1, { status: 'abandoned' }),
    releaseBuild(2, { status: 'abandoned' }),
    releaseBuild(3, { status: 'completed' }),
  ], [
    [1, detail([releaseRecord()], [releaseLog(`Created tag '2044.2.0' at ${sha}`)])],
    [2, detail([releaseRecord()], [releaseLog(`Commit ${sha} is already tagged '2044.2.0'. No patch tag is required.`)])],
    [3, detail([releaseRecord()], [releaseLog(`Created tag '4.2.0' at ${sha}`)])],
  ]);
  assert.deepEqual(data.releases.map(item => item.version), ['4.2.0']);
  assert.equal(data.runs.find(run => run.id === 1).abandonment, 'abandoned');
  assert.equal(data.runs.find(run => run.id === 1).result, 'succeeded');
});

test('a completed deployment later marked abandoned cannot supply candidate progress', () => {
  const data = candidateModel([build(1, { status: 'abandoned' }), build(2, { status: 'inProgress', result: null })], [
    [1, detail(chartTimeline('TST'))],
    [2, detail([stage('TST', { state: 'pending', result: null, startTime: null, finishTime: null })])],
  ]);
  assert.equal(progress(data, 'TST').status, 'not-started');
  assert.equal(progress(data, 'TST').lastSuccess, null);
  assert.equal(env(data, 'TST').lastSuccess.runId, 1);
});

test('later approval failures cannot block earlier environments', () => {
  const data = candidateModel([build(1, { result: 'failed' })], [[1, detail([
    stage('TST', { result: 'skipped', startTime: null, finishTime: null }),
    stage('PRE', { result: 'skipped', startTime: null, finishTime: null }),
    gate('PRD', { state: 'completed', result: 'failed', finishTime: at(11) }),
  ])]]);
  assert.equal(progress(data, 'TST').status, 'not-started');
  assert.equal(progress(data, 'PRE').status, 'not-started');
});
