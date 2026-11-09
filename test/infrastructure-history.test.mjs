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

const devBuild = (id, sourceVersion, finishTime) => ({
  ...build(id, 202, 'refs/heads/main', sourceVersion, ['Environment-DEV']), status: 'completed', result: 'succeeded', finishTime,
});

function devTimeline(finishTime) {
  return [
    ['DeployResourceGroup', 'Deploy - ResourceGroup'],
    ['DeployNetwork', 'Deploy - Network'],
    ['DeployACR', 'Deploy - ACR'],
    ['DeployClassic', 'Deploy - Classic'],
    ['DeployInfrastructure', 'Deploy - Infrastructure'],
    ['PrivateLink', 'Deploy - PrivateLink'],
  ].flatMap(([identifier, name]) => {
    const completed = { state: 'completed', result: 'succeeded', finishTime };
    return [
      { id: identifier, type: 'Stage', identifier, ...completed },
      { id: `${identifier}-task`, type: 'Task', name, parentId: identifier, ...completed },
    ];
  });
}

function fixture({ definitions = [release, dev], denyDev = false, denyTimeline = false, releaseBuilds, devBuilds, devTimelines = {} } = {}) {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer synthetic-token',
    fetchImpl: async (url, { method }) => {
      const path = url.pathname.split('/_apis/')[1];
      const query = Object.fromEntries(url.searchParams);
      calls.push({ method, path, query });
      if (path === 'build/definitions') return Response.json({ value: definitions.filter(item => item.name === query.name) });
      if (path === 'build/builds') {
        if (query.definitions === '201') return Response.json({ value: releaseBuilds ?? [
          build(601, 201, 'refs/tags/1.1', commit),
          build(602, 201, 'refs/heads/1.1', commit),
          build(603, 201, 'refs/tags/ipaffs-infra-pin-123', commit),
          build(604, 203, 'refs/tags/2', commit),
        ] });
        if (query.definitions === '202') {
          if (denyDev) return new Response('', { status: 403 });
          return Response.json({ value: devBuilds ?? [
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
      const id = path.match(/^build\/builds\/(\d+)\/timeline$/)?.[1];
      if (Object.hasOwn(devTimelines, id)) return devTimelines[id] === null
        ? new Response('', { status: 403 }) : Response.json({ records: devTimelines[id] });
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

test('DEV overview uses verified apply completion and reuses tag-matched timelines', async () => {
  const other = 'b'.repeat(40);
  const taggedAt = '2035-02-01T11:15:00Z';
  const newerAt = '2035-02-01T11:45:00Z';
  const { service, calls } = fixture({
    devBuilds: [
      devBuild(701, commit, '2035-02-01T12:30:00Z'),
      devBuild(702, other, '2035-02-01T12:00:00Z'),
      devBuild(703, other, '2035-02-01T10:59:00Z'),
      devBuild(704, other, '2035-02-01T12:40:00Z'),
      { ...devBuild(705, other, null), status: 'inProgress' },
      { ...devBuild(706, other, '2035-02-01T13:00:00Z'), sourceBranch: 'refs/heads/feature' },
    ],
    devTimelines: { 701: devTimeline(taggedAt), 702: devTimeline(newerAt), 704: devTimeline(newerAt).slice(0, -1) },
  });
  const { infrastructure } = await service.get();
  assert.deepEqual(infrastructure.latestDev, {
    commit: other, at: newerAt, runId: 702, stage: 'PrivateLink',
    runUrl: 'https://dev.azure.com/example/Example%20Project/_build/results?buildId=702&view=logs&j=PrivateLink',
  });
  assert.equal(infrastructure.releases[0].environments.DEV.successful.runId, 701);
  assert.deepEqual(calls.filter(call => call.path.endsWith('/timeline')).map(call => call.path).sort(), [
    'build/builds/601/timeline', 'build/builds/701/timeline', 'build/builds/702/timeline', 'build/builds/704/timeline',
  ]);
});

test('DEV overview remains available without tagged releases or access to their pipeline', async () => {
  for (const definitions of [[dev], [release, dev]]) {
    const { service } = fixture({ definitions, releaseBuilds: [], devBuilds: [devBuild(702, commit, at)],
      devTimelines: { 702: devTimeline(at) } });
    const { infrastructure } = await service.get();
    assert.deepEqual(infrastructure.releases, []);
    assert.equal(infrastructure.latestDev.commit, commit);
    assert.equal(infrastructure.devLatestAvailability, 'available');
    assert.equal(infrastructure.availability, definitions.includes(release) ? 'available' : 'unavailable');
  }
});

test('DEV overview bounds unmatched timeline reads and identifies missing evidence', async () => {
  const devBuilds = Array.from({ length: 12 }, (_, i) => devBuild(710 + i, 'b'.repeat(40), at));
  const devTimelines = Object.fromEntries(devBuilds.map(run => [run.id, null]));
  const { service, calls } = fixture({ devBuilds, devTimelines });
  const { infrastructure } = await service.get();
  assert.equal(infrastructure.latestDev, null);
  assert.equal(infrastructure.devAvailability, 'available');
  assert.equal(infrastructure.devLatestAvailability, 'unavailable');
  assert.equal(infrastructure.devLatestLimited, true);
  assert.equal(infrastructure.releases[0].environments.DEV.status, 'noEvidence');
  assert.equal(calls.filter(call => /\/7\d+\/timeline$/.test(call.path)).length, 5);
});
