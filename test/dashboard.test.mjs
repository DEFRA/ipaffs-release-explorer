import test from 'node:test';
import assert from 'node:assert/strict';
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

function fixture(initialRuns = [createRun()]) {
  let runs = initialRuns;
  let status = 16;
  let failure = false;
  let calls = 0;
  const client = {
    requests: 0,
    async list(path, query) {
      this.requests += 1;
      return { items: path === 'build/builds' ? runs.filter(run => run.definition.id === query.definitions) : [], limited: false };
    },
    async get(path) {
      this.requests += 1;
      if (path.endsWith('/timeline')) return { data: { records: [{ id: 'create-task', type: 'Task', name: 'Create release branch or next patch tag', state: 'completed', result: 'succeeded', finishTime: changedAt, log: { id: 17 } }] } };
      if (path.endsWith('/logs/17')) return { data: `Created tag '2044.2.0' at ${sha}` };
      throw new Error(`Unexpected path ${path}`);
    },
    async getRunStatus(id, pipelineId) {
      this.requests += 1;
      calls += 1;
      if (failure) throw new Error('private upstream detail');
      return { id, pipelineId, status };
    },
  };
  return {
    service: createDashboardService(config, client),
    setRuns(next) { runs = next; },
    setStatus(next) { status = next; },
    setFailure(next) { failure = next; },
    get calls() { return calls; },
  };
}

test('current abandonment is passed into the model even when Build history and tag task succeeded', async () => {
  const { service } = fixture();
  const data = await service.get();
  assert.equal(data.runs[0].result, 'succeeded');
  assert.equal(data.runs[0].abandonment, 'abandoned');
  assert.deepEqual(data.releases, []);
  assert.equal(service.run(501).run.abandonment, 'abandoned');
});

test('verified run states are reused until lastChangedDate changes', async () => {
  const source = fixture();
  source.setStatus(2);
  assert.equal((await source.service.get()).releases.length, 1);
  assert.equal(source.calls, 1);
  await source.service.get({ refresh: true });
  assert.equal(source.calls, 1);
  source.setStatus(16);
  source.setRuns([createRun({ lastChangedDate: '2035-03-15T13:00:00Z' })]);
  const abandoned = await source.service.get({ refresh: true });
  assert.equal(source.calls, 2);
  assert.deepEqual(abandoned.releases, []);
  assert.equal(abandoned.runs[0].abandonment, 'abandoned');
});

test('missing change timestamps skip state caching and states outside the snapshot are pruned', async () => {
  const source = fixture([createRun({ lastChangedDate: undefined })]);
  await source.service.get();
  await source.service.get({ refresh: true });
  assert.equal(source.calls, 2);
  source.setRuns([createRun()]);
  await source.service.get({ refresh: true });
  assert.equal(source.calls, 3);
  source.setRuns([]);
  await source.service.get({ refresh: true });
  source.setRuns([createRun()]);
  await source.service.get({ refresh: true });
  assert.equal(source.calls, 4);
});

test('state failures are explicit and are retried instead of caching uncertainty', async () => {
  const source = fixture();
  source.setFailure(true);
  const uncertain = await source.service.get();
  assert.equal(uncertain.runs[0].abandonment, 'unknown');
  assert.deepEqual(uncertain.releases, []);
  assert.ok(uncertain.warnings.some(warning => warning.code === 'run_state_unavailable'));
  assert.equal(JSON.stringify(uncertain).includes('private upstream detail'), false);
  source.setFailure(false);
  source.setStatus(2);
  const recovered = await source.service.get({ refresh: true });
  assert.equal(source.calls, 2);
  assert.equal(recovered.runs[0].abandonment, 'not-abandoned');
  assert.equal(recovered.releases.length, 1);
  assert.equal(recovered.warnings.some(warning => warning.code === 'run_state_unavailable'), false);
});

test('QA, active runs, and runs already canceled do not make supplemental page requests', async () => {
  const source = fixture([
    createRun({ id: 1, status: 'inProgress', result: null }),
    createRun({ id: 2, result: 'canceled' }),
    createRun({ id: 3, definition: { id: config.pipelines.qa, name: 'QA' } }),
  ]);
  const data = await source.service.get();
  assert.equal(source.calls, 0);
  assert.equal(data.runs.length, 3);
});
