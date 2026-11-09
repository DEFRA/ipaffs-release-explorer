import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInfrastructureProgress, infrastructureTag } from '../src/infrastructure-model.mjs';

const base = 'https://dev.azure.com/example-org';
const project = 'Example Project';
const commit = 'a'.repeat(40);
const otherCommit = 'b'.repeat(40);
const date = hour => `2035-03-15T${String(hour).padStart(2, '0')}:00:00Z`;

function run(id, sourceBranch, records, fields = {}) {
  return { build: { id, sourceBranch, sourceVersion: commit, queueTime: date(id), status: 'inProgress',
    _links: { web: { href: 'https://untrusted.invalid/' } }, ...fields }, records };
}

function stage(identifier, fields = {}) {
  return { id: identifier, identifier, type: 'Stage', state: 'pending', result: null, ...fields };
}

function success(identifier, hour, fields) {
  return stage(identifier, { state: 'completed', result: 'succeeded', finishTime: date(hour), ...fields });
}

function model(releaseRuns, devRuns = [], overrides = {}) {
  return buildInfrastructureProgress({ base, project, releaseRuns, devRuns, ...overrides });
}

function devRecords() {
  return [
    ['DeployResourceGroup', 'Deploy - ResourceGroup'],
    ['DeployNetwork', 'Deploy - Network'],
    ['DeployACR', 'Deploy - ACR'],
    ['DeployClassic', 'Deploy - Classic'],
    ['DeployInfrastructure', 'Deploy - Infrastructure'],
    ['PrivateLink', 'Deploy - PrivateLink'],
  ].flatMap(([identifier, name], index) => {
    const state = 'completed', result = 'succeeded';
    return [
      success(identifier, index + 1),
      { id: `${identifier}-phase`, type: 'Phase', state, result, parentId: identifier },
      { id: `${identifier}-job`, type: 'Job', state, result, parentId: `${identifier}-phase` },
      { id: `${identifier}-task`, type: 'Task', state, result, name, parentId: `${identifier}-job` },
    ];
  });
}

function devRun(id, records = devRecords(), overrides) {
  return run(id, 'refs/heads/main', records, { status: 'completed', result: 'succeeded', tags: ['Environment-DEV'], ...overrides });
}

test('recognizes canonical major and major.patch infrastructure tags as text', () => {
  for (const tag of ['1', '1.0', '1.1', '9007199254740993101.9007199254740993101']) {
    assert.equal(infrastructureTag(`refs/tags/${tag}`), tag);
  }
  for (const tag of ['0', '0.1', '01', '1.01', '1.2.3', 'v1', '1-beta', '1.2\n', 'ipaffs-infra-pin-abc']) {
    assert.equal(infrastructureTag(`refs/tags/${tag}`), null);
  }
  assert.equal(infrastructureTag('refs/heads/1'), null);
  assert.equal(infrastructureTag('1'), null);
});

test('distinguishes current TST deployment, pending gates and an earlier TST failure', () => {
  const pending = ['TST_Complete', 'GateToPRE', 'PRE_Complete', 'GateToPRD', 'PRD_Complete'].map(name => stage(name));
  const running = run(3, 'refs/tags/1.1', [
    success('TST_DeployNetwork', 4), stage('TST_DeployClassic', { state: 'inProgress', startTime: date(5) }), ...pending,
  ]);
  const failed = run(1, 'refs/tags/1', [
    stage('TST_DeployNetwork', { state: 'completed', result: 'failed', finishTime: date(2) }),
    ...pending.map(record => ({ ...record, state: 'completed', result: 'skipped' })),
  ], { status: 'completed', result: 'failed' });
  const { releases, latestSuccessful } = model([failed, running]);
  assert.deepEqual(releases.map(row => row.tag), ['1.1', '1']);
  assert.equal(releases[0].environments.DEV.status, 'noEvidence');
  assert.deepEqual(releases[0].environments.TST, {
    status: 'running', at: date(5), runId: 3,
    runUrl: `${base}/Example%20Project/_build/results?buildId=3&view=logs&j=TST_DeployClassic`,
    stage: 'TST_DeployClassic', successful: null,
  });
  assert.equal(releases[0].environments.PRE.status, 'pending');
  assert.equal(releases[1].environments.TST.status, 'failed');
  assert.equal(releases[1].environments.PRE.status, 'skipped');
  assert.equal(releases[1].environments.PRD.status, 'skipped');
  assert.deepEqual(latestSuccessful, { TST: null, PRE: null, PRD: null });
});

test('reports approval only from the active target gate and keeps completed deployments', () => {
  const { releases, latestSuccessful } = model([run(1, 'refs/tags/1.1', [
    success('TST_Complete', 2), success('GateToPRE', 3), success('PRE_Complete', 4),
    stage('GateToPRD', { state: 'inProgress', startTime: date(5) }), stage('PRD_Complete'),
  ])]);
  assert.equal(releases[0].environments.TST.status, 'succeeded');
  assert.equal(releases[0].environments.PRE.status, 'succeeded');
  assert.equal(releases[0].environments.PRD.status, 'awaitingApproval');
  assert.equal(releases[0].environments.PRD.stage, 'GateToPRD');
  assert.equal(latestSuccessful.PRD, null);
  assert.deepEqual(latestSuccessful.PRE, { tag: '1.1', commit, ...releases[0].environments.PRE.successful });

  const denied = model([run(2, 'refs/tags/1.2', [success('TST_Complete', 3),
    stage('GateToPRE', { state: 'completed', result: 'failed', finishTime: date(4) }),
    stage('PRE_Complete', { state: 'completed', result: 'skipped' }),
  ])]).releases[0].environments.PRE;
  assert.equal(denied.status, 'approvalFailed');
  assert.equal(denied.stage, 'GateToPRE');
});

test('retains completion evidence across a later run and across visible stage attempts', () => {
  const { releases, latestSuccessful } = model([
    run(2, 'refs/tags/1', [success('TST_Complete', 3), success('PRE_Complete', 4)]),
    run(5, 'refs/tags/1', [
      success('TST_Complete', 6, { attempt: 1 }),
      stage('TST_Complete', { id: 'retry', attempt: 2, state: 'completed', result: 'failed', finishTime: date(7) }),
      stage('PRE_Complete'),
    ]),
  ]);
  const { TST, PRE } = releases[0].environments;
  assert.equal(TST.status, 'failed');
  assert.equal(TST.at, date(7));
  assert.equal(TST.successful.runId, 5);
  assert.equal(TST.successful.at, date(6));
  assert.equal(PRE.status, 'pending');
  assert.equal(PRE.successful.runId, 2);
  assert.equal(latestSuccessful.PRE.runId, 2);
});

test('groups exact tag and commit and orders successful deployments by their own completion', () => {
  const { releases, latestSuccessful, limited } = model([
    run(2, 'refs/tags/1', [success('TST_Complete', 9)]),
    run(4, 'refs/tags/1', [success('TST_Complete', 6)], { sourceVersion: otherCommit.toUpperCase() }),
    run(5, 'refs/tags/1.1', [success('TST_Complete', 7)]),
    run(10, 'refs/tags/1.1', [success('TST_Complete', 11)], { sourceVersion: [commit] }),
    run(11, 'refs/tags/1.1.1', [success('TST_Complete', 12)]),
    run(12, 'refs/heads/1', [success('TST_Complete', 13)]),
  ], [], { limited: true });
  assert.equal(limited, true);
  assert.deepEqual(releases.map(row => [row.tag, row.commit]), [['1.1', commit], ['1', otherCommit], ['1', commit]]);
  assert.equal(latestSuccessful.TST.runId, 2);
  assert.equal(latestSuccessful.TST.at, date(9));
});

test('keeps unavailable, skipped, partial and canceled evidence distinct', () => {
  const { releases } = model([
    run(1, 'refs/tags/1', null),
    run(2, 'refs/tags/2', [success('TST_DeployInfrastructure', 3)], { status: 'completed', result: 'succeeded' }),
    run(3, 'refs/tags/3', [stage('TST_Complete', { state: 'completed', result: 'succeededWithIssues', finishTime: date(4) })]),
    run(4, 'refs/tags/4', [], { status: 'completed', result: 'canceled' }),
    run(5, 'refs/tags/5', null, { status: 'notStarted' }),
    run(6, 'refs/tags/6', [stage('TST_Complete', { state: 'completed', result: 'succeeded', startTime: date(7) })]),
  ]);
  assert.deepEqual(releases.map(({ environments }) => [environments.TST.status, environments.TST.at]), [
    ['succeeded', null], ['pending', null], ['canceled', null], ['succeededWithIssues', date(4)], ['unknown', null], ['unavailable', null],
  ]);
  assert.equal(releases[3].environments.TST.successful, null);
});

test('requires DEV main, exact commit, environment tag, and all six successful applies', () => {
  const release = run(10, 'refs/tags/1.1', []);
  const mismatched = devRun(9, devRecords(), { sourceVersion: otherCommit });
  const untagged = devRun(8, devRecords(), { tags: ['Environment-TST'] });
  const branch = devRun(7, devRecords(), { sourceBranch: 'refs/heads/test' });
  const valid = devRun(6);
  const missingApply = devRun(11, devRecords().filter(record => record.id !== 'PrivateLink-task'));
  const skippedJob = devRun(12, devRecords().map(record => record.id === 'PrivateLink-job' ? { ...record, result: 'skipped' } : record));
  const failedBuild = devRun(13, devRecords(), { result: 'failed' });

  const { releases } = model([release], [mismatched, untagged, branch, valid]);
  assert.equal(releases[0].environments.DEV.status, 'succeeded');
  assert.equal(releases[0].environments.DEV.at, date(6));
  assert.equal(releases[0].environments.DEV.stage, 'PrivateLink');
  assert.equal(releases[0].environments.DEV.successful.runId, 6);
  assert.equal(model([release], [mismatched, untagged, branch]).releases[0].environments.DEV.status, 'noEvidence');
  assert.equal(model([release], [], { devAvailability: 'unavailable' }).releases[0].environments.DEV.status, 'unavailable');
  for (const incomplete of [missingApply, skippedJob, failedBuild]) {
    const { DEV } = model([release], [valid, incomplete]).releases[0].environments;
    assert.equal(DEV.status, 'unknown');
    assert.equal(DEV.runId, incomplete.build.id);
    assert.equal(DEV.successful.runId, 6);
  }
});
