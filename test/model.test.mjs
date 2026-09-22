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

test('previous releases come from successful PRD deployments without creation logs', () => {
  const data = model([build(1, { finishTime: at(15), reason: 'manual', requestedBy: { displayName: 'Example operator' } })], [[1, detail([
    ...chartTimeline('TST', { finishTime: at(4) }),
    ...chartTimeline('PRE', { finishTime: at(6) }),
    ...chartTimeline('PRD', { finishTime: at(10) }),
  ])]]);
  assert.deepEqual(data.releases, []);
  const [release] = data.previousReleases;
  assert.equal(release.version, '4.2.0');
  assert.equal(release.commit, sha);
  assert.equal(release.history, true);
  assert.equal(release.observedAt, at(10));
  assert.deepEqual(release.progress.slice(1).map(item => item.lastSuccess.finishedAt), [at(4), at(6), at(10)]);
  assert.equal(release.progress[0].status, 'not-recorded');
  assert.equal(release.progress[0].lastSuccess, null);
  assert.equal(release.progress[3].deployments[0].trigger.requestedBy, 'Example operator');
  assert.match(release.url, /buildId=1/);
});

test('production deployment history survives later failed, canceled and abandoned parents', () => {
  for (const overrides of [{ result: 'failed' }, { result: 'canceled' }, { status: 'abandoned' }]) {
    const data = model([build(1, overrides)], [[1, detail(chartTimeline('PRD'))]]);
    assert.equal(data.previousReleases.length, 1);
    assert.equal(data.previousReleases[0].progress[3].lastSuccess.status, 'succeeded');
  }
});

test('only successful PRD deployments move an identity into previous releases', () => {
  for (const result of ['failed', 'canceled', 'skipped', 'partiallySucceeded', null]) {
    const data = model([build(1)], [[1, detail([
      ...chartTimeline('TST'), ...chartTimeline('PRE'),
      ...chartTimeline('PRD', { result, state: result ? 'completed' : 'pending' }, { result, state: result ? 'completed' : 'pending' }),
    ])]]);
    assert.deepEqual(data.previousReleases, []);
  }
  const pending = model([releaseBuild(1)], [[1, detail([releaseRecord()], [releaseLog(`Created tag '4.2.0' at ${sha}`)])]]);
  assert.equal(pending.releases.length, 1);
  assert.deepEqual(pending.previousReleases, []);
});

test('history requires an exact release tag and full commit, retaining conflicting identities', () => {
  for (const overrides of [
    { sourceBranch: 'refs/heads/4.2.0' }, { sourceBranch: '4.2.0' }, { sourceBranch: 'refs/tags/4.02.0' },
    { sourceVersion: 'abcdef12' }, { sourceVersion: null },
  ]) assert.deepEqual(model([build(1, overrides)], [[1, detail(chartTimeline('PRD'))]]).previousReleases, []);
  const data = model([build(1), build(2, { sourceVersion: otherSha.toUpperCase() })], [
    [1, detail(chartTimeline('PRD', { finishTime: at(8) }))],
    [2, detail(chartTimeline('PRD', { finishTime: at(10) }))],
  ]);
  assert.deepEqual(data.previousReleases.map(item => item.commit), [otherSha, sha]);
  assert.deepEqual(data.previousReleases.map(item => item.progress[3].deployments.length), [1, 1]);
  assert.ok(data.warnings.some(item => item.code === 'RELEASE_TAG_CONFLICT'));
});

test('previous releases sort by successful PRD completion and retain repeated deployments', () => {
  const data = model([
    build(1, { sourceVersion: sha.toUpperCase() }),
    build(2, { sourceBranch: 'refs/tags/4.3.0', sourceVersion: otherSha }),
    build(3), build(4, { result: 'failed' }),
  ], [
    [1, detail(chartTimeline('PRD', { startTime: at(4), finishTime: at(4) }))],
    [2, detail(chartTimeline('PRD', { startTime: at(7), finishTime: at(7) }))],
    [3, detail(chartTimeline('PRD', { startTime: at(10), finishTime: at(10), attempt: 2 }))],
    [4, detail(chartTimeline('PRD', { startTime: at(12), finishTime: at(12), result: 'failed' }, { result: 'failed' }))],
  ]);
  assert.deepEqual(data.previousReleases.map(item => item.version), ['4.2.0', '4.3.0']);
  const prd = data.previousReleases[0].progress[3];
  assert.equal(prd.status, 'deployed');
  assert.equal(prd.lastSuccess.runId, 3);
  assert.equal(prd.latestAttempt.runId, 4);
  assert.deepEqual(prd.deployments.map(item => item.runId), [3, 1]);
  assert.equal(data.previousReleases[0].observedAt, at(10));
  assert.match(prd.detail, /latest recorded attempt/);
});

test('historical environment dates never borrow another commit or pipeline finish time', () => {
  const data = model([build(1), build(2, { sourceVersion: otherSha })], [
    [1, detail(chartTimeline('PRD', { finishTime: null }))],
    [2, detail([...chartTimeline('TST'), ...chartTimeline('PRE')])],
  ]);
  const [release] = data.previousReleases;
  assert.equal(release.observedAt, null);
  assert.equal(release.progress[3].lastSuccess.finishedAt, null);
  for (const item of release.progress.slice(0, 3)) {
    assert.equal(item.status, 'not-recorded');
    assert.deepEqual(item.deployments, []);
  }
});

test('history keeps retained successful job attempts when a later retry fails', () => {
  const records = chartTimeline('PRD', { result: 'failed', attempt: 2, finishTime: at(12) }, { result: 'failed', attempt: 2 });
  records.push(chartJob('PRD', { id: 'previous-prd-job', attempt: 1, startTime: at(8), finishTime: at(8) }));
  const [release] = model([build(1, { result: 'failed' })], [[1, detail(records)]]).previousReleases;
  assert.equal(release.observedAt, at(8));
  assert.equal(release.progress[3].lastSuccess.attempt, 1);
  assert.equal(release.progress[3].latestAttempt.attempt, 2);
  assert.equal(release.progress[3].deployments.length, 1);
});

test('previous releases only use DEV commits with recorded namespace mapping', () => {
  const resolver = resolverRecord();
  const data = model([build(1), devBuild(2), devBuild(3, { sourceVersion: otherSha })], [
    [1, detail(chartTimeline('PRD'))],
    [2, detail([...chartTimeline('DEV'), resolver], [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: sample-dev' }])],
    [3, detail(chartTimeline('DEV', { finishTime: at(15) }))],
  ]);
  const dev = data.previousReleases[0].progress[0];
  assert.equal(dev.status, 'deployed');
  assert.equal(dev.matchedBy, 'commit');
  assert.equal(dev.lastSuccess.namespace, 'sample-dev');
  assert.equal(dev.lastSuccess.runId, 2);
  assert.match(dev.detail, /does not establish deployment of the release tag/);
  const noResolver = model([build(1), devBuild(2)], [[1, detail(chartTimeline('PRD'))], [2, detail(chartTimeline('DEV'))]]);
  assert.equal(noResolver.previousReleases[0].progress[0].status, 'not-recorded');
});

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

test('DEV deployment trigger retains only requester display names and the original reason', () => {
  const requester = { displayName: 'Example operator', id: 'private-identity-id', uniqueName: 'operator@example.invalid', imageUrl: 'https://avatar.example.invalid/private' };
  const data = model([devBuild(1, { reason: 'manual', requestedBy: requester, requestedFor: { displayName: 'Example delegate' } })], [[1, detail(chartTimeline('DEV'))]]);
  const expected = { reason: 'manual', requestedBy: 'Example operator', requestedFor: 'Example delegate' };
  assert.deepEqual(data.runs[0].trigger, expected);
  assert.deepEqual(data.namespaces[0].lastSuccess.trigger, expected);
  assert.deepEqual(env(data, 'DEV').lastSuccess.trigger, expected);
  assert.doesNotMatch(JSON.stringify(data), /private-identity-id|operator@example\.invalid|avatar\.example\.invalid/);
});

test('a later failed DEV attempt cannot replace the successful deployment requester', () => {
  const data = model([
    devBuild(1, { reason: 'manual', requestedBy: { displayName: 'Successful operator' } }),
    devBuild(2, { reason: 'manual', result: 'failed', requestedBy: { displayName: 'Retry operator' } }),
  ], [
    [1, detail(chartTimeline('DEV', { startTime: at(1), finishTime: at(1) }))],
    [2, detail(chartTimeline('DEV', { startTime: at(2), finishTime: at(2), result: 'failed' }, { result: 'failed' }))],
  ]);
  assert.equal(data.namespaces[0].lastSuccess.trigger.requestedBy, 'Successful operator');
  assert.equal(data.namespaces[0].latestAttempt.trigger.requestedBy, 'Retry operator');
});

test('automated DEV deployments preserve their trigger reason and service identity', () => {
  const data = model([devBuild(1, { reason: 'batchedCI', requestedBy: { displayName: 'Example build service' }, requestedFor: { displayName: 'Example build service' } })], [[1, detail(chartTimeline('DEV'))]]);
  assert.deepEqual(data.namespaces[0].lastSuccess.trigger, { reason: 'batchedCI', requestedBy: 'Example build service', requestedFor: 'Example build service' });
});

test('missing or malformed requester metadata never falls back to beneficiary, commit author or last changer', () => {
  for (const requestedBy of [undefined, {}, { displayName: '' }, { displayName: '  ' }, { displayName: 123 }, { uniqueName: 'operator@example.invalid' }]) {
    const data = model([devBuild(1, { requestedBy, reason: 123, requestedFor: { displayName: 'Example beneficiary' }, lastChangedBy: { displayName: 'Example editor' } })], [[1, detail(chartTimeline('DEV'))]]);
    assert.deepEqual(data.namespaces[0].lastSuccess.trigger, { reason: null, requestedBy: null, requestedFor: 'Example beneficiary' });
  }
});

test('retry records retain original run attribution without inventing a retry actor', () => {
  const data = model([devBuild(1, { reason: 'manual', requestedBy: { displayName: 'Original operator' }, lastChangedBy: { displayName: 'Later editor' } })], [[1, detail(chartTimeline('DEV', { attempt: 2 }, { attempt: 2 }))]]);
  assert.equal(data.namespaces[0].lastSuccess.attempt, 2);
  assert.equal(data.namespaces[0].lastSuccess.trigger.requestedBy, 'Original operator');
  assert.doesNotMatch(JSON.stringify(data.namespaces), /Later editor/);
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
  assert.equal(data.warnings.some(item => item.code === 'UNKNOWN_DEV_NAMESPACE'), false);
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

const urlSummary = (namespace = 'feature-example', host = 'app.example.invalid') => `# Namespace access URLs
- Environment: \`DEV\`
- Namespace: \`${namespace}\`
- B2C base URL: https://${host}
- B2B base URL: https://internal.${host}
- B2C notifications URL: https://${host}/notification/DEV/protected/notifications
- B2B notifications URL: https://internal.${host}/notification/DEV/protected/notifications`;
function accessDetail({ name = 'Publish namespace access URLs', stageId = 'DEV_DeployChart', namespace = 'feature-example', text = urlSummary(namespace), task = {}, job = {}, extraRecords = [] } = {}) {
  return detail([
    resolverRecord(),
    ...chartTimeline('DEV', job, { identifier: stageId }),
    { id: 'urls', type: 'Task', name, parentId: 'job-DEV', state: 'completed', result: 'succeeded', attempt: 1, startTime: at(9), finishTime: at(9), log: { id: 29 }, ...task },
    ...extraRecords,
  ], [
    { id: 27, recordName: 'Resolve namespace', text: `Using namespace: ${namespace}\n` },
    { id: 29, recordName: name, text },
  ]);
}

test('mapped DEV namespaces expose recorded access URLs with source evidence from both publisher layouts', () => {
  for (const options of [{}, { name: 'Generate namespace URLs', stageId: 'DEV_PublishNamespaceUrls' }]) {
    const data = model([devBuild(1)], [[1, accessDetail(options)]]);
    const access = data.namespaces[0].access;
    assert.equal(access.links.length, 4);
    assert.equal(access.links.find(link => link.kind === 'b2c-notifications').url, 'https://app.example.invalid/notification/DEV/protected/notifications');
    assert.equal(access.runId, 1);
    assert.equal(access.observedAt, at(9));
    assert.match(access.evidence[0].url, /buildId=1.*l=29/);
  }
});

test('namespace links require matching namespace, DEV context, successful task and job', () => {
  for (const options of [
    { text: urlSummary('other-namespace') },
    { text: urlSummary().replace('`DEV`', '`TST`') },
    { stageId: 'TST_DeployChart' },
    { name: 'Checkout' },
    { task: { result: 'failed' } },
    { task: { state: 'inProgress', result: null } },
    { job: { result: 'failed' } },
    { task: { parentId: 'missing' } },
    { text: urlSummary().replace('https://app.example.invalid', 'javascript:alert(1)') },
  ]) {
    const data = model([devBuild(1)], [[1, accessDetail(options)]]);
    assert.equal(data.namespaces[0].access, null, JSON.stringify(options));
  }
  for (const status of ['abandoned', 'canceled']) {
    assert.equal(model([devBuild(1, { status })], [[1, accessDetail()]]).namespaces[0].access, null);
  }
});

test('unmapped DEV runs are silently excluded even if a URL log names a namespace', () => {
  const source = accessDetail();
  source.timeline.records.find(item => item.id === 'resolver').result = 'failed';
  const data = model([devBuild(1)], [[1, source]]);
  assert.deepEqual(data.namespaces, []);
  assert.deepEqual(data.warnings, []);
});

test('a failed publisher retry cannot reuse an earlier successful log within the run', () => {
  const source = accessDetail({ extraRecords: [{ id: 'urls-retry', type: 'Task', name: 'Publish namespace access URLs', parentId: 'job-DEV', state: 'completed', result: 'failed', attempt: 2, log: { id: 30 } }] });
  assert.equal(model([devBuild(1)], [[1, source]]).namespaces[0].access, null);
  const retriedJob = accessDetail({ job: { attempt: 2 } });
  assert.equal(model([devBuild(1)], [[1, retriedJob]]).namespaces[0].access, null);
});

test('namespace links use the latest successful publication and retain its provenance across newer runs without URLs', () => {
  const earlyQueueLatePublish = accessDetail({ task: { finishTime: at(12) }, text: urlSummary('feature-example', 'latest.example.invalid') });
  const lateQueueEarlyPublish = accessDetail({ task: { finishTime: at(10) } });
  const unpublished = accessDetail({ task: { result: 'skipped' } });
  const data = model([devBuild(1), devBuild(2), devBuild(3)], [[1, earlyQueueLatePublish], [2, lateQueueEarlyPublish], [3, unpublished]]);
  assert.equal(data.namespaces[0].access.runId, 1);
  assert.equal(data.namespaces[0].access.observedAt, at(12));
  assert.equal(data.namespaces[0].access.links[0].url, 'https://latest.example.invalid/');
});

test('a mapped namespace without a recorded URL summary has no invented links', () => {
  const data = model([devBuild(1)], [[1, detail(chartTimeline('DEV'))]]);
  assert.equal(data.namespaces[0].name, 'dev');
  assert.equal(data.namespaces[0].access, null);
});

test('configured canonical DEV entry points replace logged proxy URLs without inventing notification paths or provenance', () => {
  const devUrls = { b2c: 'https://public.example.invalid/', b2b: 'https://internal.example.invalid/start' };
  for (const source of [detail(chartTimeline('DEV')), accessDetail({ namespace: 'dev' })]) {
    const data = model([devBuild(1)], [[1, source]], { devUrls });
    assert.equal(data.namespaces[0].name, 'dev');
    assert.deepEqual(data.namespaces[0].access, { source: 'configured', links: [
      { kind: 'b2c-base', label: 'B2C', url: devUrls.b2c },
      { kind: 'b2b-base', label: 'B2B', url: devUrls.b2b },
    ], evidence: [] });
  }
});

test('configured canonical DEV URLs leave branch and release namespace links unchanged', () => {
  const builds = [devBuild(1, { sourceBranch: 'refs/heads/feature/example' }), devBuild(2, { sourceBranch: 'refs/heads/RELEASE/4.2.x' })];
  const entries = [[1, accessDetail()], [2, accessDetail({ namespace: '4-2-x' })]];
  const unchanged = model(builds, entries);
  const configured = model(builds, entries, { devUrls: { b2c: 'https://public.example.invalid/', b2b: 'https://internal.example.invalid/' } });
  assert.deepEqual(configured.namespaces, unchanged.namespaces);
});

test('canonical DEV keeps recorded URLs when no configured pair is provided', () => {
  const data = model([devBuild(1)], [[1, accessDetail({ namespace: 'dev' })]]);
  assert.equal(data.namespaces[0].access.links.length, 4);
  assert.equal(data.namespaces[0].access.runId, 1);
  assert.equal(data.namespaces[0].access.source, undefined);
});

test('canonical DEV configuration does not invent a namespace when no mapped run exists', () => {
  const data = model([devBuild(1, { sourceBranch: 'refs/heads/feature/unknown' })], [[1, detail(chartTimeline('DEV'))]],
    { devUrls: { b2c: 'https://public.example.invalid/', b2b: 'https://internal.example.invalid/' } });
  assert.deepEqual(data.namespaces, []);
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

test('QA evidence preserves the child timestamps and retention flags from both queue response formats', () => {
  for (const timestamps of [
    { createdDate: at(1), finishedDate: at(2) },
    { queueTime: at(1), finishTime: at(2) },
  ]) {
    assert.deepEqual(parseQaRunEvidence(JSON.stringify({
      id: 503, pipeline: { id: 104 }, ...timestamps, reason: 'manual', keepForever: true, retainedByRelease: false,
    })), { id: 503, pipelineId: 104, queuedAt: at(1), finishedAt: at(2), reason: 'manual', keepForever: true, retainedByRelease: false });
  }
});

test('QA availability is separate from results and cannot replace an available child outcome', () => {
  const record = { id: 'qa-task', type: 'Task', name: 'Trigger QA pipeline', state: 'completed', result: 'succeeded', log: { id: 29 } };
  const entries = [[1, detail([record], [{ id: 29, recordName: 'Trigger QA pipeline', text: '{"id":2,"pipeline":{"id":104}}' }])]];
  const availability = { status: 'past-retention', label: 'Likely past retention window', detail: 'Synthetic retention context.' };
  const extra = { qaAvailability: new Map([[2, availability]]) };
  const missing = model([build(1)], entries, extra).runs.find(run => run.id === 1).qaLinks[0];
  assert.deepEqual(missing.availability, availability);
  assert.equal(missing.result, null);
  assert.equal(missing.revisionVerified, false);
  const present = model([build(1), build(2, { _kind: 'qa', definition: { id: 104, name: 'QA' }, result: 'failed' })], entries, extra).runs.find(run => run.id === 1).qaLinks[0];
  assert.equal(present.result, 'failed');
  assert.equal(present.availability, undefined);
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

test('confirmed validation failures remain in history without timeline or namespace warnings', () => {
  const builds = [devBuild(1, { result: 'failed' }), releaseBuild(2, { result: 'failed' }), build(3, { result: 'failed' })];
  const data = model(builds, builds.map(run => [run.id, { ...detail([]), validationFailed: true }]));
  assert.equal(data.runs.length, 3);
  assert.ok(data.runs.every(run => run.result === 'failed'));
  assert.deepEqual(data.warnings, []);
  assert.deepEqual(data.namespaces, []);
  assert.deepEqual(data.releases, []);
  assert.ok(data.environments.every(environment => environment.lastSuccess === null && environment.latestAttempt === null));
});

test('a validation marker cannot discard nonempty deployment or namespace evidence', () => {
  const data = model([devBuild(1, { result: 'failed' })], [[1, {
    ...detail([...chartTimeline('DEV'), resolverRecord()], [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: dev\n' }]),
    validationFailed: true,
  }]]);
  assert.equal(env(data, 'DEV').lastSuccess.runId, 1);
  assert.equal(data.namespaces[0].confidence, 'recorded');
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

test('candidate progress identifies pipeline validation failure without inventing a deployment attempt', () => {
  const data = candidateModel([devBuild(1, { result: 'failed' }), build(2, { result: 'failed' })], [
    [1, { ...detail([]), validationFailed: true }],
    [2, { ...detail([]), validationFailed: true }],
  ]);
  for (const environment of ['DEV', 'TST', 'PRE', 'PRD']) {
    const item = progress(data, environment);
    assert.equal(item.status, 'failed', environment);
    assert.equal(item.label, 'Failed');
    assert.equal(item.detail, 'Pipeline validation failed before any deployment started.');
    assert.equal(item.lastSuccess, null);
    assert.equal(item.latestAttempt, null);
    assert.equal(item.runId, environment === 'DEV' ? 1 : 2);
    assert.equal(item.evidence[0].type, 'run');
  }
  assert.deepEqual(data.warnings, []);
});

test('later validation failures preserve earlier successful DEV and release deployment evidence', () => {
  const data = candidateModel([
    devBuild(1, { queueTime: at(9) }), build(2, { queueTime: at(9) }),
    devBuild(3, { queueTime: at(12), result: 'failed' }), build(4, { queueTime: at(12), result: 'failed' }),
  ], [
    [1, detail([...chartTimeline('DEV'), resolverRecord()], [{ id: 27, recordName: 'Resolve namespace', text: 'Using namespace: dev\n' }])],
    [2, detail(chartTimeline('TST'))],
    [3, { ...detail([]), validationFailed: true }],
    [4, { ...detail([]), validationFailed: true }],
  ]);
  for (const [environment, successfulRun, failedRun] of [['DEV', 1, 3], ['TST', 2, 4]]) {
    const item = progress(data, environment);
    assert.equal(item.status, 'failed');
    assert.equal(item.runId, failedRun);
    assert.equal(item.lastSuccess.runId, successfulRun);
    assert.equal(item.latestAttempt.runId, successfulRun);
    assert.equal(env(data, environment).latestAttempt.runId, successfulRun);
    assert.match(item.detail, /Pipeline validation failed before any deployment started\./);
    assert.match(item.detail, /earlier successful/);
    assert.ok(item.evidence.some(source => source.url.includes(`buildId=${successfulRun}`)));
    assert.ok(item.evidence.some(source => source.url.includes(`buildId=${failedRun}`)));
  }
  assert.deepEqual(data.warnings, []);
  assert.equal(data.coverage.find(item => item.label === 'Deployment history').status, 'available');
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
