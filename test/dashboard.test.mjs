import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient } from '../src/ado-client.mjs';
import { createDashboardService } from '../src/dashboard.mjs';
import { loadConfig } from '../src/config.mjs';

// All identifiers and history in these tests are synthetic.
const config = loadConfig({
  ADO_ORGANIZATION: 'https://dev.azure.com/example-org', ADO_PROJECT: 'example-project',
  ADO_DEV_PIPELINE_ID: '101', ADO_CREATE_RELEASE_PIPELINE_ID: '102',
  ADO_RELEASE_PIPELINE_ID: '103', ADO_QA_PIPELINE_ID: '104',
});
const changedAt = '2035-03-15T12:00:00Z';
const sha = 'a'.repeat(40);
const createRun = (overrides = {}) => ({
  id: 501, definition: { id: config.pipelines.create, name: 'Create Release' },
  buildNumber: '20350309.1', sourceBranch: 'refs/heads/master', sourceVersion: sha,
  status: 'completed', result: 'succeeded', lastChangedDate: changedAt,
  queueTime: changedAt, startTime: changedAt, finishTime: changedAt, ...overrides,
});

function fixture(initialRuns = [createRun()], { versions = {}, linkedQa, timelines = {}, qaEvidence = {}, retentionPolicy, now } = {}) {
  let runs = initialRuns;
  let policy = retentionPolicy;
  const failures = new Map();
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture-workload-identity-token',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.Authorization, 'Bearer fixture-workload-identity-token');
      // Authenticated web pages can fail for this identity. They are never needed.
      if (url.pathname.includes('/_build/')) return new Response('private-page-error', { status: 500 });
      const path = url.pathname.split('/_apis/')[1];
      if (failures.has(path)) {
        const status = failures.get(path);
        if (status === 'network') throw new Error('private-network-error');
        return new Response('private-upstream-error', { status });
      }
      if (path === 'build/retention') {
        assert.equal(url.searchParams.get('api-version'), '7.1');
        return Response.json(policy);
      }
      if (path === 'build/builds') {
        assert.equal(url.searchParams.get('api-version'), '7.2-preview.8');
        return Response.json({ value: runs.filter(run => run.definition.id === Number(url.searchParams.get('definitions'))) });
      }
      const summary = path.match(/^build\/builds\/(\d+)$/);
      if (summary && linkedQa && Number(summary[1]) === linkedQa.id) {
        assert.equal(url.searchParams.get('api-version'), '7.2-preview.8');
        return Response.json(linkedQa);
      }
      const timeline = path.match(/^build\/builds\/(\d+)\/timeline$/);
      if (timeline) {
        assert.equal(url.searchParams.get('api-version'), '7.1');
        if (Object.hasOwn(timelines, timeline[1])) return timelines[timeline[1]] === null
          ? new Response(null, { status: 204 }) : Response.json(timelines[timeline[1]]);
        const records = [{ id: 'create-task', type: 'Task', name: 'Create release branch or next patch tag', state: 'completed', result: 'succeeded', finishTime: changedAt, log: { id: 17 } }];
        if (linkedQa || qaEvidence[timeline[1]]) records.push({ id: 'qa-task', type: 'Task', name: 'Trigger QA pipeline', state: 'completed', result: 'succeeded', log: { id: 18 } });
        return Response.json({ records });
      }
      const log = path.match(/^build\/builds\/(\d+)\/logs\/(\d+)$/);
      if (log) {
        assert.equal(url.searchParams.get('api-version'), '7.1');
        if (Number(log[2]) === 18) return new Response(JSON.stringify(qaEvidence[log[1]] || { id: linkedQa.id, definition: linkedQa.definition }));
        return new Response(`Created tag '${versions[log[1]] || '4.2.0'}' at ${sha}`);
      }
      if (path === 'distributedtask/environments') return Response.json({ value: [] });
      throw new Error(`Unexpected path ${path}`);
    },
  });
  return {
    service: createDashboardService(config, client, now ? { now } : undefined), calls,
    setRuns(next) { runs = next; },
    setRetentionPolicy(next) { policy = next; },
    setFailure(path, status = 500) { if (path) failures.set(path, status); else failures.clear(); },
  };
}

function assertOnlyApiRequests(calls) {
  assert.ok(calls.length > 0);
  assert.ok(calls.every(url => url.pathname.includes('/_apis/')));
  assert.equal(calls.some(url => url.pathname.includes('/_build/')), false);
}

test('API status excludes abandoned and canceled creation while genuine candidates awaiting deployment remain visible', async () => {
  const source = fixture([
    createRun(),
    createRun({ id: 502, status: 'abandoned', result: 'succeeded' }),
    createRun({ id: 503, result: 'canceled' }),
  ], { versions: { 502: '2044.2.0', 503: '4.3.0' } });
  const data = await source.service.get();
  assert.deepEqual(data.releases.map(release => release.version), ['4.2.0']);
  assert.ok(data.releases[0].progress.every(item => item.status === 'not-recorded'));
  assert.equal(data.runs.find(run => run.id === 502).result, 'succeeded');
  assert.equal(data.runs.find(run => run.id === 502).abandonment, 'abandoned');
  assert.equal(source.service.run(502).run.abandonment, 'abandoned');
  assert.deepEqual(data.warnings, []);
  assertOnlyApiRequests(source.calls);
});

test('a refresh uses the current summary status even when lastChangedDate stays unchanged', async () => {
  const source = fixture();
  assert.equal((await source.service.get()).releases.length, 1);
  const initialCalls = source.calls.length;
  source.setRuns([createRun({ status: 'abandoned' })]);
  assert.equal((await source.service.get()).releases.length, 1, 'The normal dashboard cache remains bounded by its configured lifetime');
  assert.equal(source.calls.length, initialCalls);
  const refreshed = await source.service.get({ refresh: true });
  assert.deepEqual(refreshed.releases, []);
  assert.equal(refreshed.runs[0].abandonment, 'abandoned');
  assertOnlyApiRequests(source.calls);
});

test('Build summary failures report a safe refresh error and can recover without HTML fallback', async () => {
  const source = fixture();
  source.setFailure('build/builds');
  await assert.rejects(source.service.get(), error => error.code === 'ado_response_error' && !error.message.includes('private-upstream-error'));
  source.setFailure(null);
  const recovered = await source.service.get({ refresh: true });
  assert.equal(recovered.releases.length, 1);
  assert.deepEqual(recovered.warnings, []);
  assertOnlyApiRequests(source.calls);
});

test('unavailable timelines remain explicit and do not fabricate candidate evidence', async () => {
  const source = fixture();
  source.setFailure('build/builds/501/timeline');
  const incomplete = await source.service.get();
  assert.deepEqual(incomplete.releases, []);
  assert.ok(incomplete.warnings.some(warning => warning.code === 'timeline_unavailable'));
  assert.equal(JSON.stringify(incomplete).includes('private-upstream-error'), false);
  source.setFailure(null);
  assert.equal((await source.service.get({ refresh: true })).releases.length, 1);
  assertOnlyApiRequests(source.calls);
});

test('linked QA summaries also retain abandonment instead of displaying their original result as current success', async () => {
  const source = fixture([createRun()], {
    linkedQa: createRun({ id: 701, definition: { id: config.pipelines.qa, name: 'QA' }, status: 'abandoned', result: 'succeeded' }),
  });
  const data = await source.service.get();
  const link = data.runs.find(run => run.id === 501).qaLinks[0];
  assert.equal(link.id, 701);
  assert.equal(link.status, 'abandoned');
  assert.equal(link.result, 'succeeded');
  assert.equal(link.abandonment, 'abandoned');
  assertOnlyApiRequests(source.calls);
});

test('confirmed validation failures with absent timelines do not warn or invent deployment state', async () => {
  for (const kind of ['dev', 'create', 'release']) {
    for (const timeline of [null, { records: [] }]) {
      const source = fixture([createRun({
        definition: { id: config.pipelines[kind], name: `Example ${kind}` },
        result: 'failed', validationResults: [{ result: 'error', message: 'Synthetic pipeline validation error' }],
      })], { timelines: { 501: timeline } });
      const data = await source.service.get();
      assert.deepEqual(data.warnings, [], `${kind}: ${JSON.stringify(timeline)}`);
      assert.equal(data.runs[0].result, 'failed');
      assert.equal(source.service.run(501).note, 'Pipeline validation failed before any deployment started.');
      assert.deepEqual(data.releases, []);
      assert.deepEqual(data.namespaces, []);
      assert.ok(data.environments.every(environment => environment.lastSuccess === null && environment.latestAttempt === null));
      assertOnlyApiRequests(source.calls);
    }
  }
});

test('an empty timeline remains a warning unless a completed failure has explicit validation errors', async () => {
  for (const overrides of [
    { result: 'failed' },
    { result: 'failed', validationResults: [{ result: 'warning' }] },
    { result: 'succeeded', validationResults: [{ result: 'error' }] },
    { status: 'inProgress', result: 'failed', validationResults: [{ result: 'error' }] },
  ]) {
    for (const timeline of [null, { records: [] }]) {
      const source = fixture([createRun(overrides)], { timelines: { 501: timeline } });
      const data = await source.service.get();
      assert.ok(data.warnings.some(warning => warning.code === 'timeline_unavailable'), JSON.stringify(overrides));
      assert.ok(data.warnings.some(warning => warning.code === 'TIMELINE_COVERAGE'));
      assert.deepEqual(data.releases, []);
    }
  }
});

test('validation metadata does not suppress timeline permission, transport or server failures', async () => {
  for (const status of [401, 403, 404, 500, 'network']) {
    const source = fixture([createRun({ result: 'failed', validationResults: [{ result: 'error' }] })]);
    source.setFailure('build/builds/501/timeline', status);
    const data = await source.service.get();
    assert.ok(data.warnings.some(warning => warning.code === 'timeline_unavailable'), String(status));
    assert.ok(data.warnings.some(warning => warning.code === 'TIMELINE_COVERAGE'));
    assert.equal(JSON.stringify(data).includes('private-'), false);
  }
});

test('nonempty deployment evidence takes precedence over validation errors in a failed run', async () => {
  const record = (environment, result) => ({
    id: `stage-${environment}`, type: 'Stage', name: `Deploy ${environment}`,
    identifier: `${environment}_DeployChart`, state: 'completed', result,
    startTime: changedAt, finishTime: changedAt,
  });
  const source = fixture([createRun({
    definition: { id: config.pipelines.release, name: 'Example release' },
    sourceBranch: 'refs/tags/4.2.0', result: 'failed', validationResults: [{ result: 'error' }],
  })], { timelines: { 501: { records: [record('TST', 'succeeded'), record('PRE', 'failed')] } } });
  const data = await source.service.get();
  assert.deepEqual(data.warnings, []);
  assert.equal(data.environments.find(environment => environment.name === 'TST').lastSuccess.runId, 501);
  assert.equal(data.environments.find(environment => environment.name === 'PRE').latestAttempt.status, 'failed');
  assert.equal(source.service.run(501).stages.length, 2);
});

const retentionNow = Date.parse(changedAt);
const retentionPolicy = {
  purgeRuns: { value: 60 }, purgePullRequestRuns: { value: 30 }, retainRunsPerProtectedBranch: { value: 2 },
};
const oldQaEvidence = (overrides = {}) => ({
  id: 701, definition: { id: config.pipelines.qa }, createdDate: '2035-01-01T12:00:00Z', reason: 'manual', ...overrides,
});
const newerQaRuns = () => [702, 703].map(id => createRun({
  id, definition: { id: config.pipelines.qa, name: 'QA' },
  queueTime: '2035-03-01T12:00:00Z', startTime: '2035-03-01T12:01:00Z', finishTime: '2035-03-01T12:02:00Z',
}));
const linkedRequestCount = source => source.calls.filter(url => /\/build\/builds\/701$/.test(url.pathname)).length;
const retentionRequestCount = source => source.calls.filter(url => url.pathname.endsWith('/build/retention')).length;
function missingQaFixture({ evidence = oldQaEvidence(), runs = newerQaRuns(), policy = retentionPolicy, ...options } = {}) {
  const source = fixture([createRun(), ...runs], {
    qaEvidence: { 501: evidence }, retentionPolicy: policy, now: () => retentionNow, ...options,
  });
  source.setFailure('build/builds/701', 404);
  return source;
}
function assertQaUnavailable(data) {
  assert.ok(data.warnings.some(warning => warning.code === 'qa_run_unavailable'));
  assert.equal(data.warnings.some(warning => warning.code === 'qa_run_past_retention'), false);
  assert.equal(data.runs.find(run => run.id === 501).qaLinks[0].availability, undefined);
}

test('missing old QA runs show retention context without inventing their execution result', async () => {
  for (const [metadata, ageBasis, ageDays, label] of [
    [{}, 'queued', 73, 'Likely past retention window'],
    [{ finishedDate: '2035-01-02T12:00:00Z' }, 'finished', 72, 'Past retention window'],
  ]) {
    const source = missingQaFixture({ evidence: oldQaEvidence(metadata) });
    const data = await source.service.get();
    const link = data.runs.find(run => run.id === 501).qaLinks[0];
    assert.equal(link.status, 'unknown');
    assert.equal(link.result, null);
    assert.equal(link.availability.status, 'past-retention');
    assert.equal(link.availability.label, label);
    assert.equal(link.availability.retentionDays, 60);
    assert.equal(link.availability.ageDays, ageDays);
    assert.equal(link.availability.ageBasis, ageBasis);
    assert.equal(link.availability.minimumRuns, 2);
    assert.ok(link.availability.detail.length > 0);
    const notice = data.warnings.find(warning => warning.code === 'qa_run_past_retention');
    assert.equal(notice.severity, 'info');
    assert.equal(data.warnings.some(warning => warning.code === 'qa_run_unavailable'), false);
    assert.equal(retentionRequestCount(source), 1);
    assertOnlyApiRequests(source.calls);
  }
});

test('a missing pull request QA run uses the project pull request retention duration', async () => {
  const source = missingQaFixture({ evidence: oldQaEvidence({ createdDate: '2035-02-01T12:00:00Z', reason: 'pullRequest' }) });
  const data = await source.service.get();
  const availability = data.runs.find(run => run.id === 501).qaLinks[0].availability;
  assert.equal(availability.retentionDays, 30);
  assert.equal(availability.ageDays, 42);
});

test('permission and transport failures never become retention notices', async () => {
  for (const status of [401, 403, 500, 'network']) {
    const source = missingQaFixture();
    source.setFailure('build/builds/701', status);
    const data = await source.service.get();
    assertQaUnavailable(data);
    assert.equal(retentionRequestCount(source), 0);
    assert.equal(JSON.stringify(data).includes('private-'), false);
  }
});

test('retention remains unknown with recent, missing or protected QA evidence', async () => {
  for (const evidence of [
    oldQaEvidence({ createdDate: '2035-03-10T12:00:00Z' }),
    oldQaEvidence({ createdDate: undefined }),
    oldQaEvidence({ createdDate: 'not-a-date' }),
    oldQaEvidence({ keepForever: true }),
    oldQaEvidence({ retainedByRelease: true }),
  ]) {
    const source = missingQaFixture({ evidence });
    assertQaUnavailable(await source.service.get());
  }
});

test('retention requires enough newer successful completed QA runs within the scan', async () => {
  const [first, second] = newerQaRuns();
  for (const runs of [
    [first],
    [first, { ...second, status: 'inProgress', result: null, finishTime: null }],
    [first, { ...second, result: 'failed' }],
    [first, { ...second, finishTime: '2035-04-01T12:00:00Z' }],
    [first, { ...second, queueTime: '2034-12-01T12:00:00Z' }],
    [first, { ...second, definition: { id: config.pipelines.create } }],
  ]) {
    const source = missingQaFixture({ runs });
    assertQaUnavailable(await source.service.get());
  }
});

test('an unavailable project policy preserves the ordinary missing QA warning', async () => {
  for (const status of [403, 500, 'network']) {
    const source = missingQaFixture();
    source.setFailure('build/retention', status);
    const data = await source.service.get();
    assertQaUnavailable(data);
    assert.equal(retentionRequestCount(source), 1);
    assert.equal(JSON.stringify(data).includes('private-'), false);
  }
});

test('available QA results take precedence over age and never request retention policy', async () => {
  const linkedQa = createRun({ id: 701, definition: { id: config.pipelines.qa, name: 'QA' }, result: 'failed' });
  const source = missingQaFixture({ linkedQa });
  source.setFailure(null);
  const data = await source.service.get();
  const link = data.runs.find(run => run.id === 501).qaLinks[0];
  assert.equal(link.result, 'failed');
  assert.equal(link.status, 'completed');
  assert.equal(link.availability, undefined);
  assert.equal(retentionRequestCount(source), 0);
  assert.equal(data.warnings.some(warning => warning.code.startsWith('qa_run_')), false);
});

test('failed QA trigger tasks and other pipeline IDs cannot supply retention evidence', async () => {
  for (const evidence of [oldQaEvidence(), oldQaEvidence({ definition: { id: 999 } })]) {
    const successful = evidence.definition.id !== config.pipelines.qa;
    const source = missingQaFixture({ evidence, timelines: {
      501: { records: [{ id: 'qa-task', type: 'Task', name: 'Trigger QA pipeline', state: 'completed', result: successful ? 'succeeded' : 'failed', log: { id: 18 } }] },
    } });
    const data = await source.service.get();
    assert.equal(linkedRequestCount(source), 0);
    assert.equal(retentionRequestCount(source), 0);
    assert.equal(data.warnings.some(warning => warning.code.startsWith('qa_run_')), false);
  }
});

test('retention policy is fetched once per scan and re-read on refresh', async () => {
  const source = fixture([createRun(), createRun({ id: 502 }), ...newerQaRuns()], {
    qaEvidence: { 501: oldQaEvidence(), 502: oldQaEvidence({ id: 704 }) },
    retentionPolicy, now: () => retentionNow,
  });
  source.setFailure('build/builds/701', 404);
  source.setFailure('build/builds/704', 404);
  const initial = await source.service.get();
  assert.equal(initial.warnings.filter(warning => warning.code === 'qa_run_past_retention').length, 2);
  assert.equal(retentionRequestCount(source), 1);
  const callsBefore = source.calls.length;
  assert.equal((await source.service.get()).cached, true);
  assert.equal(source.calls.length, callsBefore);
  source.setRetentionPolicy({ ...retentionPolicy, purgeRuns: { value: 100 } });
  const refreshed = await source.service.get({ refresh: true });
  assert.equal(refreshed.warnings.filter(warning => warning.code === 'qa_run_unavailable').length, 2);
  assert.equal(refreshed.warnings.some(warning => warning.code === 'qa_run_past_retention'), false);
  assert.equal(retentionRequestCount(source), 2);
});
