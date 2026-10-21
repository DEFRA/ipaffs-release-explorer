import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSecretExpiryReport } from '../src/secret-health-summary.mjs';
import { createSecretHealthService } from '../src/secret-health.mjs';
import { createDashboardService } from '../src/dashboard.mjs';

// All reports, identifiers and dates in this file are synthetic.
const DAY = 86400000;
const checkedAt = '2035-01-02T08:00:00Z';
const now = Date.parse('2035-01-02T10:00:00Z');
const sha = 'a'.repeat(40);
const canonical = ['DEV', 'TST', 'PRE', 'PRD'];
const config = {
  organization: 'https://dev.azure.com/example', project: 'Example Project',
  pipelines: { dev: 101, create: 102, release: 103, qa: 104 }, qaPipelines: {}, scanPipeline: null,
  secretExpiryPipeline: { id: null, name: 'Report OAuth Secret Expiry' },
  runsPerPipeline: 100, cacheSeconds: 90, environmentNames: canonical,
};
const dateAfter = milliseconds => new Date(Date.parse(checkedAt) + milliseconds).toISOString();
const run = (overrides = {}) => ({
  id: 901, definition: { id: 108 }, status: 'completed', result: 'succeeded',
  sourceBranch: 'refs/heads/master', sourceVersion: sha, queueTime: checkedAt,
  templateParameters: { environmentNames: canonical }, ...overrides,
});
const row = (environment, overrides = {}) => ({
  environment, secretName: 'synthetic-oauth', itemType: 'secret', status: 'OK', inUse: true,
  checkedAt, expiresAt: dateAfter(90 * DAY), ...overrides,
});
function report(environments = ['dev', 'tst', 'pre', 'prd']) {
  return {
    schemaVersion: 1, complete: true, sourceCommit: sha, sourceRef: 'refs/heads/master',
    checkedAt: '2035-01-02T08:10:00Z', environments,
    reports: environments.map(environment => ({ environment, complete: true, status: 'AVAILABLE', checkedAt, secretCount: 2 })),
    secrets: environments.flatMap(environment => [row(environment), row(environment, {
      secretName: 'synthetic-certificate', itemType: 'certificate', certificateRole: 'canonical', fingerprintStatus: 'REFERENCE',
    })]),
  };
}
const normalize = (value, options = {}) => normalizeSecretExpiryReport(value, run(), { now, ...options });
const dev = value => normalize(value).environments.DEV;
const dashboard = () => ({ environments: canonical.map(name => ({ name, namespace: name.toLowerCase() })), limits: {},
  namespaces: [{ name: 'feature-example' }], releases: [{ version: '1.2.3' }] });

test('expiry colours use exact 30/60-day instants, independent of configured statuses or rounded days', () => {
  for (const [remaining, expected] of [
    [60 * DAY + 1000, 'green'], [60 * DAY, 'amber'], [60 * DAY - 1000, 'amber'],
    [30 * DAY, 'amber'], [30 * DAY - 1000, 'red'], [-1000, 'red'],
  ]) {
    const value = report(['dev']);
    Object.assign(value.secrets[0], { expiresAt: dateAfter(remaining), status: 'DISABLED', daysToExpiry: 999 });
    assert.equal(dev(value).colour, expected, `${remaining / DAY} days`);
    assert.equal(dev(value).counts[expected], expected === 'green' ? 2 : 1);
  }
});

test('every reported row contributes, including unused credentials', () => {
  const value = report(['dev']);
  Object.assign(value.secrets[0], { inUse: false, expiresAt: dateAfter(10 * DAY) });
  assert.equal(dev(value).colour, 'red');
});

test('missing expiry, unreadable metadata and incomplete coverage cannot show green', () => {
  for (const patch of [{ expiresAt: null, status: 'NO_EXPIRY' },
    ...['READ_ERROR', 'MISSING_SECRET', 'MISSING_CERTIFICATE', 'INVALID_METADATA'].map(status => ({ status }))]) {
    const value = report(['dev']);
    Object.assign(value.secrets[0], patch);
    assert.equal(dev(value).colour, 'amber');
    assert.equal(dev(value).counts.amber, 1);
  }
  const incomplete = report(['dev']);
  incomplete.reports[0].complete = false;
  assert.equal(dev(incomplete).state, 'partial');
  assert.equal(dev(incomplete).colour, 'amber');
  const noCertificates = report(['dev']);
  noCertificates.secrets = noCertificates.secrets.slice(0, 1);
  noCertificates.reports[0].secretCount = 1;
  assert.equal(dev(noCertificates).state, 'partial');
  assert.equal(dev(noCertificates).colour, 'amber');
});

test('stale and incomplete evidence retains known red expiry findings', () => {
  const value = report(['dev']);
  const atLimit = Date.parse(checkedAt) + 48 * 60 * 60 * 1000;
  assert.equal(normalize(value, { now: atLimit }).environments.DEV.stale, false);
  const stale = normalize(value, { now: atLimit + 1000 }).environments.DEV;
  assert.equal(stale.stale, true);
  assert.equal(stale.colour, 'amber');
  value.reports[0].complete = false;
  value.secrets[0].expiresAt = dateAfter(10 * DAY);
  const red = normalize(value, { now: atLimit + 1000 }).environments.DEV;
  assert.equal(red.colour, 'red');
  assert.equal(red.state, 'partial');
  assert.equal(red.stale, true);
});

test('environment timestamps and coverage remain independent of aggregation time and other environments', () => {
  const value = report(['dev', 'tst']);
  value.complete = false;
  value.reports[1].complete = false;
  value.reports[1].checkedAt = '2035-01-02T07:00:00Z';
  for (const item of value.secrets.filter(item => item.environment === 'tst')) item.checkedAt = value.reports[1].checkedAt;
  const result = normalize(value).environments;
  assert.equal(result.DEV.colour, 'green');
  assert.equal(result.DEV.checkedAt, checkedAt);
  assert.equal(result.TST.colour, 'amber');
  assert.equal(result.TST.checkedAt, value.reports[1].checkedAt);
  const offset = report(['dev']);
  offset.reports[0].checkedAt = '2035-01-02T09:00:00+01:00';
  offset.secrets[0].expiresAt = '2035-02-01T09:00:00+01:00';
  assert.equal(dev(offset).colour, 'amber', 'Equivalent timezone offsets must preserve the exact 30-day boundary');
});

test('fingerprint mismatches are separate expiry warnings; unknown comparisons make coverage incomplete', () => {
  const value = report(['dev']);
  Object.assign(value.secrets[1], { certificateRole: 'application', fingerprintStatus: 'MISMATCH' });
  assert.equal(dev(value).colour, 'green');
  assert.equal(dev(value).fingerprintMismatches, 1);
  value.secrets[1].fingerprintStatus = 'UNKNOWN';
  assert.equal(dev(value).state, 'partial');
  assert.equal(dev(value).colour, 'amber');
  assert.equal(dev(value).fingerprintUnknown, 1);
});

test('invalid schema, source identity, dates and duplicated environment entries reject the combined report', () => {
  const mutations = [
    value => { value.schemaVersion = 2; }, value => { value.complete = 'true'; },
    value => { value.sourceCommit = 'b'.repeat(40); }, value => { value.sourceCommit = 'short'; },
    value => { value.sourceRef = 'refs/heads/feature'; }, value => { value.checkedAt = 'not-a-date'; },
    value => { value.checkedAt = '2035-01-02T08:00:00'; }, value => { value.checkedAt = '2035-01-03T08:00:00Z'; },
    value => { value.checkedAt = '2034-02-30T08:00:00Z'; },
    value => { value.environments.push('dev'); }, value => { value.environments[0] = 'DEV'; },
    value => { value.reports.push({ ...value.reports[0] }); },
    value => { value.secrets[0].environment = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const value = report(['dev']);
    mutate(value);
    assert.equal(normalize(value), null);
  }
  assert.equal(normalizeSecretExpiryReport(report(), run({ sourceVersion: 'b'.repeat(40) }), { now }), null);
});

test('malformed, duplicate, empty or timestamp-inconsistent rows fail closed for their environment', () => {
  const mutations = [
    value => { value.secrets[0].status = 'UNKNOWN_STATUS'; }, value => { value.secrets[0].inUse = 'true'; },
    value => { value.secrets[0].expiresAt = 'not-a-date'; }, value => { value.secrets[0].secretName = ''; },
    value => { value.secrets[0].expiresAt = '2035-02-30T08:00:00Z'; },
    value => { value.secrets[0].itemType = 'unknown'; }, value => { value.secrets[0].checkedAt = '2035-01-02T07:00:00Z'; },
    value => { value.secrets[1].certificateRole = 'unknown'; }, value => { value.secrets[1].fingerprintStatus = 'unknown'; },
    value => { value.secrets.push({ ...value.secrets[0] }); value.reports[0].secretCount++; },
    value => { value.secrets = []; value.reports[0].secretCount = 0; },
    value => { value.reports[0].secretCount = 999; }, value => { value.reports[0].checkedAt = '2035-01-02T09:00:00Z'; },
  ];
  for (const mutate of mutations) {
    const value = report(['dev']);
    mutate(value);
    const result = dev(value);
    assert.equal(result.state, 'unavailable');
    assert.equal(result.colour, 'grey');
    assert.equal(result.counts, null);
  }
});

test('normalization strips raw credential metadata and reporting errors', () => {
  const value = report(['dev']);
  value.errors = ['private-error'];
  Object.assign(value.reports[0], { vaultName: 'private-vault' });
  Object.assign(value.secrets[0], { secretName: 'private-secret', references: [{ clientId: 'private-client' }],
    fingerprintSha256: 'private-fingerprint', sourceStore: 'private-store', error: 'private-error' });
  const normalized = normalize(value);
  assert.equal(normalized.environments.DEV.state, 'complete');
  assert.doesNotMatch(JSON.stringify(normalized), /private/);
});

function fixture({ runs = [run()], artifacts = {}, definitions, definitionsLimited = false, fail, overrides = {} } = {}) {
  const calls = [];
  const client = {
    requests: 0,
    async list(path, query, limit) {
      this.requests++;
      calls.push({ path, query, limit });
      if (fail === path) throw new Error('private-upstream-error');
      if (path === 'build/definitions') return { items: definitions ?? [{ id: 108, name: config.secretExpiryPipeline.name, path: '\\QA' }], limited: definitionsLimited };
      if (path === 'build/builds') return { items: Number(query.definitions) === 108 ? runs : [], limited: false };
      if (path === 'distributedtask/environments') return { items: [], limited: false };
      throw new Error(`Unexpected list ${path}`);
    },
    async getSecretExpiryReport(id) {
      this.requests++;
      calls.push({ artifact: id });
      if (fail === 'artifact' || artifacts[id] instanceof Error) throw new Error('private-artifact-error');
      return Object.hasOwn(artifacts, id) ? artifacts[id] : report();
    },
  };
  const settings = { ...config, ...overrides };
  return { calls, client, settings, service: createSecretHealthService(settings, client, { now: () => now }) };
}

test('discovery requires one exact unbounded name match; explicit ID bypasses discovery', async () => {
  const definition = { id: 108, name: config.secretExpiryPipeline.name, path: '\\QA' };
  for (const options of [{ definitions: [definition, { ...definition, id: 109 }] },
    { definitions: [{ ...definition, name: `${definition.name} copy` }] }, { definitions: [definition], definitionsLimited: true }]) {
    const source = fixture(options), data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.state, 'unavailable');
    assert.equal(source.calls.some(call => call.path === 'build/builds' || call.artifact), false);
  }
  const source = fixture({ overrides: { secretExpiryPipeline: { id: 108 } } }), data = dashboard();
  await source.service.attach(data);
  assert.equal(data.environments[0].secretHealth.colour, 'green');
  assert.equal(source.calls.some(call => call.path === 'build/definitions'), false);
});

test('report pipeline collisions with deployment, QA and vulnerability pipelines fail before report history', async () => {
  for (const overrides of [{ pipelines: { dev: 108 } }, { qaPipelines: { qaDev: { id: 108 } } }, { scanPipeline: { id: 108 } }]) {
    const source = fixture({ overrides }), data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.state, 'unavailable');
    assert.equal(source.calls.some(call => call.path === 'build/builds'), false);
  }
});

test('latest completed master report wins regardless of build result, with no deployment or release mutation', async () => {
  for (const result of ['succeeded', 'failed', 'partiallySucceeded', 'canceled']) {
    const newer = run({ id: 902, result, queueTime: '2035-01-02T09:00:00Z' });
    const red = report();
    red.secrets[0].expiresAt = dateAfter(10 * DAY);
    const source = fixture({ runs: [run(), newer, run({ id: 903, sourceBranch: 'refs/heads/feature', queueTime: '2035-01-02T09:30:00Z' })], artifacts: { 902: red } });
    const data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.runId, 902);
    assert.equal(data.environments[0].secretHealth.colour, 'red');
    assert.match(data.environments[0].secretHealth.url, /Example%20Project\/_build\/results\?buildId=902&view=ms.vss-build-web.run-extensions-tab$/);
    assert.equal(source.calls.filter(call => call.artifact).length, 1);
    assert.equal(data.namespaces[0].secretHealth, undefined);
    assert.equal(data.releases[0].secretHealth, undefined);
    const history = source.calls.find(call => call.path === 'build/builds');
    assert.equal(history.query.branchName, 'refs/heads/master');
    assert.equal(history.query.resultFilter, undefined);
    assert.equal(history.limit, 20);
  }
});

test('unreadable or invalid latest report blocks older green fallback and does not leak upstream errors', async () => {
  for (const artifact of [null, new Error('private-error'), { ...report(), sourceCommit: 'b'.repeat(40) }]) {
    const source = fixture({ runs: [run(), run({ id: 902, queueTime: '2035-01-02T09:00:00Z' })], artifacts: { 902: artifact } });
    const data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.runId, 902);
    assert.equal(data.environments[0].secretHealth.state, 'unavailable');
    assert.equal(data.environments[0].secretHealth.counts, null);
    assert.equal(source.calls.some(call => call.artifact === 901), false);
    assert.doesNotMatch(JSON.stringify(data), /private/);
  }
});

test('manual subsets retain the latest report for other environments and support JSON/YAML parameters', async () => {
  for (const environmentNames of [['DEV'], '["DEV"]', '- DEV\n']) {
    const latest = run({ id: 902, queueTime: '2035-01-02T09:00:00Z', templateParameters: { environmentNames } });
    const source = fixture({ runs: [latest, run()], artifacts: { 902: report(['dev']) } }), data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.runId, 902);
    for (const env of data.environments.slice(1)) assert.equal(env.secretHealth.runId, 901);
    assert.deepEqual(source.calls.filter(call => call.artifact).map(call => call.artifact), [902, 901]);
  }
});

test('abandoned report runs block older healthy evidence for their selected environments', async () => {
  for (const status of ['abandoned', 16]) {
    const source = fixture({ runs: [run(), run({ id: 902, status, queueTime: '2035-01-02T09:00:00Z' })] });
    const data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.runId, 902);
    assert.equal(data.environments[0].secretHealth.state, 'unavailable');
    assert.equal(source.calls.some(call => call.artifact), false);
  }
});

test('running first report is visible without provisional values, while completed evidence remains usable during a refresh', async () => {
  const running = run({ id: 902, status: 'inProgress', result: null, queueTime: '2035-01-02T09:00:00Z' });
  const first = fixture({ runs: [running] }), initial = dashboard();
  await first.service.attach(initial);
  assert.equal(initial.environments[0].secretHealth.state, 'running');
  assert.equal(initial.environments[0].secretHealth.counts, null);
  assert.equal(first.calls.some(call => call.artifact), false);
  const next = fixture({ runs: [running, run()] }), data = dashboard();
  await next.service.attach(data);
  assert.equal(data.environments[0].secretHealth.runId, 901);
  assert.equal(data.environments[0].secretHealth.colour, 'green');
});

test('report history errors remain local to the optional indicator', async () => {
  for (const fail of ['build/definitions', 'build/builds']) {
    const source = fixture({ fail }), data = dashboard();
    await source.service.attach(data);
    assert.equal(data.environments[0].secretHealth.state, 'unavailable');
    assert.equal(data.environments[0].secretHealth.runId, null);
    assert.doesNotMatch(JSON.stringify(data), /private/);
  }
});

test('dashboard cache preserves report evidence until refresh and explicit refresh rereads it', async () => {
  const source = fixture({ overrides: { secretExpiryPipeline: { id: 108 } } });
  const service = createDashboardService(source.settings, source.client, { now: () => now });
  const initial = await service.get();
  assert.equal(initial.environments[0].secretHealth.colour, 'green');
  const cached = await service.get();
  assert.equal(cached.cached, true);
  assert.equal(source.calls.filter(call => call.artifact).length, 1);
  await service.get({ refresh: true });
  assert.equal(source.calls.filter(call => call.artifact).length, 2);
});
