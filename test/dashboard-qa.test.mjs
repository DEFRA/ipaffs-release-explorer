import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient } from '../src/ado-client.mjs';
import { createDashboardService } from '../src/dashboard.mjs';
import { loadConfig } from '../src/config.mjs';

// Synthetic IDs, timestamps and project only; no captured project data.
const config = loadConfig({ ADO_ORGANIZATION: 'https://dev.azure.com/example-org', ADO_PROJECT: 'example-project',
  ADO_DEV_PIPELINE_ID: '101', ADO_CREATE_RELEASE_PIPELINE_ID: '102', ADO_RELEASE_PIPELINE_ID: '103', ADO_QA_PIPELINE_ID: '104' });
const parent = { id: 501, definition: { id: 101 }, sourceBranch: 'refs/heads/master', sourceVersion: 'a'.repeat(40),
  buildNumber: '20350101.1', status: 'completed', result: 'succeeded', queueTime: '2035-01-01T09:00:00Z' };
const child = { id: 601, definition: { id: 105 }, sourceBranch: 'refs/heads/main', sourceVersion: 'b'.repeat(40),
  reason: 'resourceTrigger', status: 'completed', result: 'failed', queueTime: '2035-01-01T09:12:00Z', finishTime: '2035-01-01T09:40:00Z',
  triggerInfo: { alias: 'deployment', artifactType: 'Pipeline', pipelineTriggerType: 'PipelineCompletion', pipelineId: '501', branch: 'refs/heads/master' } };
const records = [
  { id: 'deploy', type: 'Stage', identifier: 'DEV_DeployChart', state: 'completed', result: 'succeeded', startTime: '2035-01-01T09:01:00Z', finishTime: '2035-01-01T09:10:00Z' },
  { id: 'marker', type: 'Stage', identifier: 'QA_DEV_Ready', state: 'completed', result: 'succeeded', startTime: '2035-01-01T09:11:00Z', finishTime: '2035-01-01T09:11:59Z' },
];

function fixture({ qa = child, summaryStatus = 200, discovery = 'ok', listFails = false, extraConfig = {} } = {}) {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer synthetic-token',
    fetchImpl: async (url, options) => {
      assert.equal(options.method, 'GET');
      const path = url.pathname.split('/_apis/')[1];
      calls.push({ path, query: Object.fromEntries(url.searchParams) });
      if (path === 'build/definitions') {
        if (discovery === 'denied') return new Response('', { status: 403 });
        const name = url.searchParams.get('name');
        const definitions = [{ id: name === 'Test DEV' ? 105 : 106, name, path: '\\QA' }];
        if (discovery === 'ambiguous') definitions.push({ ...definitions[0], id: 107 });
        return Response.json({ value: definitions });
      }
      if (path === 'build/builds') {
        const id = Number(url.searchParams.get('definitions'));
        if (listFails && id === 105) return new Response('', { status: 403 });
        return Response.json({ value: id === 101 ? [parent] : id === 105 ? [qa] : [] });
      }
      if (path === 'build/builds/501/timeline') return Response.json({ records });
      if (path === 'test/ResultSummaryByBuild') {
        assert.equal(url.searchParams.get('buildId'), '601');
        assert.equal(url.searchParams.get('api-version'), '7.1-preview.1');
        if (summaryStatus !== 200) return new Response('private-error-body', { status: summaryStatus });
        return Response.json({ aggregatedResultsAnalysis: { totalTests: 100,
          resultsByOutcome: { Passed: { count: 81 }, Failed: { count: 9 }, NotExecuted: { count: 10 } } } });
      }
      if (path === 'distributedtask/environments') return Response.json({ value: [] });
      throw new Error(`Unexpected path: ${path}`);
    },
  });
  return { service: createDashboardService({ ...config, ...extraConfig }, client), calls };
}

test('discovers separate QA pipelines and publishes native results on the matching deployment', async () => {
  const source = fixture();
  const data = await source.service.get();
  const qa = data.environments.find(env => env.name === 'DEV').lastSuccess.qa.latest;
  assert.equal(qa.id, 601);
  assert.equal(qa.summary.passPercentage, 90);
  assert.equal(qa.summary.skipped, 10);
  assert.match(qa.resultsUrl, /buildId=601&view=ms.vss-test-web.build-test-results-tab/);
  assert.equal(source.calls.filter(call => call.path === 'test/ResultSummaryByBuild').length, 1);
  assert.equal(source.calls.some(call => call.path.includes('/601/timeline')), false);
  const count = source.calls.length;
  await source.service.get();
  assert.equal(source.calls.length, count, 'The dashboard cache also covers result lookups');
});

test('selected resource metadata on manual and scheduled runs never attaches or fetches results', async () => {
  for (const reason of ['manual', 'schedule']) {
    const source = fixture({ qa: { ...child, reason } });
    const data = await source.service.get();
    assert.equal(data.environments[0].lastSuccess.qa.latest, null);
    assert.equal(source.calls.some(call => call.path.startsWith('test/')), false);
  }
});

test('denied or expired summaries preserve the QA link without invented percentages', async () => {
  for (const summaryStatus of [403, 404, 500]) {
    const source = fixture({ summaryStatus });
    const data = await source.service.get();
    const qa = data.environments[0].lastSuccess.qa.latest;
    assert.equal(qa.id, 601);
    assert.deepEqual(qa.summary, { availability: 'unavailable' });
    assert.equal(JSON.stringify(data).includes('private-error-body'), false);
  }
});

test('missing or ambiguous QA definitions do not prevent deployment history loading', async () => {
  for (const discovery of ['denied', 'ambiguous']) {
    const source = fixture({ discovery });
    const data = await source.service.get();
    assert.equal(data.environments[0].lastSuccess.runId, 501);
    assert.equal(data.environments[0].lastSuccess.qa.latest, null);
    assert.ok(data.warnings.some(warning => warning.code === 'qa_pipeline_unavailable'));
  }
});

test('QA history read failures are local to QA and configured overrides bypass discovery', async () => {
  const source = fixture({ listFails: true, extraConfig: { qaPipelines: { qaDev: { id: 105 } } } });
  const data = await source.service.get();
  assert.equal(data.environments[0].lastSuccess.runId, 501);
  assert.ok(data.warnings.some(warning => warning.code === 'qa_history_unavailable'));
  assert.equal(source.calls.some(call => call.path === 'build/definitions'), false);
});

test('overlapping QA pipeline overrides are rejected rather than guessing an environment', async () => {
  const source = fixture({ extraConfig: { qaPipelines: { qaDev: { id: 105 }, qaTst: { id: 105 } } } });
  const data = await source.service.get();
  assert.equal(data.environments[0].lastSuccess.qa.latest, null);
  assert.ok(data.warnings.some(warning => warning.code === 'qa_pipeline_conflict'));
});
