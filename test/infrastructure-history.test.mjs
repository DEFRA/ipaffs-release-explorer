import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient } from '../src/ado-client.mjs';
import { createDashboardService } from '../src/dashboard.mjs';

const config = {
  organization: 'https://dev.azure.com/example', project: 'Example Project',
  pipelines: { dev: 101, create: 102, release: 103, qa: 104 }, environmentNames: ['DEV', 'TST', 'PRE', 'PRD'],
  runsPerPipeline: 20, cacheSeconds: 90,
};
const repository = { type: 'GitHub', name: 'DEFRA/ipaffs-infra' };
const release = { id: 201, name: 'Infrastructure Release Pipeline', path: '\\Infrastructure\\Releasing', repository,
  process: { yamlFilename: 'release-pipeline.yaml' } };
const dev = { id: 202, name: 'infrastructure', path: '\\Infrastructure', repository,
  process: { yamlFilename: '/pipelines/infrastructure.yaml' } };
const build = (id, definition, sourceBranch, sourceVersion, tags = []) => ({
  id, definition: { id: definition }, sourceBranch, sourceVersion, tags,
  status: 'inProgress', queueTime: '2035-02-01T09:00:00Z',
});
const commit = 'a'.repeat(40);
const at = '2035-02-01T10:00:00Z';
const timeline = [
  { type: 'Stage', identifier: 'TST_Complete', state: 'completed', result: 'succeeded', finishTime: at },
  { type: 'Stage', identifier: 'GateToPRE', state: 'inProgress', startTime: at },
];

function fixture({ definitions = [release, dev], denyDev = false, denyTimeline = false } = {}) {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer synthetic-token',
    fetchImpl: async (url, { method }) => {
      const path = url.pathname.split('/_apis/')[1];
      const query = Object.fromEntries(url.searchParams);
      calls.push({ method, path, query });
      if (path === 'build/definitions') return Response.json({ value: definitions.filter(item => item.name === query.name) });
      if (path === 'build/builds') {
        if (query.definitions === '201') return Response.json({ value: [
          build(601, 201, 'refs/tags/1.1', commit),
          build(602, 201, 'refs/heads/1.1', commit),
          build(603, 201, 'refs/tags/ipaffs-infra-pin-123', commit),
          build(604, 203, 'refs/tags/2', commit),
        ] });
        if (query.definitions === '202') {
          if (denyDev) return new Response('', { status: 403 });
          return Response.json({ value: [
            build(701, 202, 'refs/heads/main', commit, ['Environment-DEV']),
            build(702, 202, 'refs/heads/main', 'b'.repeat(40), ['Environment-DEV']),
            build(703, 202, 'refs/heads/main', commit, ['Environment-TST']),
          ] });
        }
        return Response.json({ value: [] });
      }
      if (path === 'build/builds/601/timeline') {
        if (denyTimeline) return new Response('', { status: 403 });
        return Response.json({ records: timeline });
      }
      if (path === 'build/builds/701/timeline') return Response.json({ records: [] });
      if (path === 'distributedtask/environments') return Response.json({ value: [] });
      throw new Error(`Unexpected ADO path ${path}`);
    },
  });
  return { service: createDashboardService(config, client), calls };
}

test('dashboard reads and caches only the scoped infrastructure release and matching DEV timelines', async () => {
  const { service, calls } = fixture();
  const dashboard = await service.get();
  assert.deepEqual(dashboard.infrastructure.releases.map(row => row.tag), ['1.1']);
  assert.equal(dashboard.infrastructure.latestSuccessful.TST.at, at);
  assert.equal(dashboard.infrastructure.releases[0].environments.PRE.status, 'awaitingApproval');
  assert.deepEqual(dashboard.runs, []);
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.deepEqual(calls.filter(call => call.path.endsWith('/timeline')).map(call => call.path).sort(), [
    'build/builds/601/timeline', 'build/builds/701/timeline',
  ]);
  const releaseDefinition = calls.find(call => call.query.name === release.name);
  assert.equal(releaseDefinition.query.path, release.path);
  assert.equal(releaseDefinition.query.includeAllProperties, 'true');
  const devQuery = calls.find(call => call.query.definitions === '202').query;
  assert.equal(devQuery.branchName, 'refs/heads/main');
  assert.equal(devQuery.tagFilters, 'Environment-DEV');
  assert.equal(devQuery.$top, String(config.runsPerPipeline));
  const count = calls.length;
  assert.equal((await service.get()).cached, true);
  assert.equal(calls.length, count);
});

test('infrastructure source ambiguity and partial failures stay local to their evidence', async () => {
  for (const definitions of [
    [dev],
    [{ ...release, process: { yamlFilename: 'pipelines/infrastructure-preview.yaml' } }, dev],
    [{ ...release, repository: { ...repository, name: 'other/ipaffs-infra' } }, dev],
    [release, { ...release, id: 209 }, dev],
  ]) {
    const { service, calls } = fixture({ definitions });
    const dashboard = await service.get();
    assert.equal(dashboard.infrastructure.availability, 'unavailable');
    assert.equal(calls.some(call => call.query.definitions === '201'), false);
    assert.equal(dashboard.readOnly, true);
  }

  const withoutDev = (await fixture({ denyDev: true }).service.get()).infrastructure;
  assert.equal(withoutDev.releases[0].environments.DEV.status, 'unavailable');
  assert.equal(withoutDev.releases[0].environments.TST.status, 'succeeded');

  const withoutTimeline = (await fixture({ denyTimeline: true }).service.get()).infrastructure;
  assert.equal(withoutTimeline.releases[0].environments.TST.status, 'unavailable');
  assert.equal(withoutTimeline.latestSuccessful.TST, null);
});
