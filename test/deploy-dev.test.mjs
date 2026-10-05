import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(directory, 'deploy/scripts/deploy-dev.sh');
const optionalIds = ['ADO_QA_DEV_PIPELINE_ID', 'ADO_QA_TST_PIPELINE_ID', 'ADO_SCAN_PIPELINE_ID'];
const clientId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const issuer = 'https://example.oic.prod-aks.azure.com/example/issuer/';
const healthyDashboard = () => ({
  mode: 'live', limits: { pipelines: [
    { kind: 'dev', count: 1 }, { kind: 'create', count: 1 }, { kind: 'release', count: 1 },
    { kind: 'qa', count: 0 },
  ] }, warnings: [],
});

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'explorer-deploy-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const callsFile = join(temp, 'calls.jsonl');
  const valuesFile = join(temp, 'captured-values.json');
  const artifacts = join(temp, 'artifacts');
  await mkdir(artifacts);
  await writeFile(join(artifacts, 'image.json'), JSON.stringify({
    repository: 'example.azurecr.io/ipaffs/ipaffs-release-explorer', digest: `sha256:${'a'.repeat(64)}`,
  }));
  await writeFile(join(artifacts, 'ipaffs-release-explorer-0.1.0.tgz'), 'Synthetic chart fixture');
  // Real Bash, jq and the embedded Node smoke check execute. Every external
  // command is an offline stub that rejects unknown calls; none delegates to Azure.
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({command, args}) + '\\n');
const output = value => process.stdout.write(JSON.stringify(value));
if (command === 'az' && args[0] === 'aks' && args[1] === 'show') {
  output({oidcIssuerProfile:{enabled:true,issuerUrl:process.env.TEST_ISSUER},securityProfile:{workloadIdentity:{enabled:true}},currentKubernetesVersion:'1.34.0'});
} else if (command === 'az' && args[0] === 'identity' && args[1] === 'show') {
  output({clientId:process.env.IDENTITY_CLIENT_ID,tenantId:process.env.IDENTITY_TENANT_ID,name:'example-identity',resourceGroup:'example-rg'});
} else if (command === 'az' && args[0] === 'identity' && args[1] === 'federated-credential' && args[2] === 'list') {
  output([{issuer:process.env.TEST_ISSUER,subject:'system:serviceaccount:'+process.env.NAMESPACE+':ipaffs-release-explorer',audiences:['api://AzureADTokenExchange']}]);
} else if (command === 'az' && args[0] === 'acr' && args[1] === 'show') {
  output({loginServer:'example.azurecr.io',id:'/subscriptions/example/resourceGroups/example/providers/Microsoft.ContainerRegistry/registries/example'});
} else if (command === 'az' && args[0] === 'aks' && ['install-cli','get-credentials'].includes(args[1])) {
  // No installation or cluster access.
} else if (command === 'kubelogin' && args[0] === 'convert-kubeconfig') {
  // No authentication.
} else if (command === 'helm' && args[0] === 'upgrade') {
  const values = args.filter((value,index) => args[index-1] === '--values').at(-1);
  fs.writeFileSync(process.env.TEST_VALUES, fs.readFileSync(values));
} else if (command === 'curl' && args.includes('--output')) {
  fs.writeFileSync(args[args.indexOf('--output')+1], JSON.stringify({status:'ok',readOnly:true}));
  process.stdout.write('200');
} else if (command === 'kubectl' && args.includes('exec') && args.includes('--input-type=module') && args.includes('-e')) {
  const prelude = 'globalThis.fetch = async () => ({ok: process.env.TEST_DASHBOARD_OK === "true", json: async () => JSON.parse(process.env.TEST_DASHBOARD)});\\n';
  const result = spawnSync(process.execPath, ['--input-type=module','-e',prelude+args[args.indexOf('-e')+1]], {env:process.env,encoding:'utf8'});
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exit(result.status ?? 97);
} else {
  process.stderr.write('Unexpected external command in offline fixture.\\n');
  process.exit(97);
}
`;
  for (const command of ['az', 'kubelogin', 'helm', 'curl', 'kubectl']) {
    await writeFile(join(temp, command), stub, { mode: 0o755 });
  }
  return async (overrides = {}) => {
    await writeFile(callsFile, '');
    await rm(valuesFile, { force: true });
    const env = {
      PATH: `${temp}:${process.env.PATH}`,
      AKS_NAME: 'example-aks', AKS_RESOURCE_GROUP: 'example-rg', ACR_NAME: 'example',
      NAMESPACE: 'ipaffs-release-explorer', IDENTITY_RESOURCE_ID: '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/example-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/example-identity',
      IDENTITY_CLIENT_ID: clientId, IDENTITY_TENANT_ID: tenantId,
      ADO_ORGANIZATION: 'https://dev.azure.com/example', ADO_PROJECT: 'Example Project',
      ADO_DEV_PIPELINE_ID: '101', ADO_CREATE_RELEASE_PIPELINE_ID: '102', ADO_RELEASE_PIPELINE_ID: '103', ADO_QA_PIPELINE_ID: '104',
      INGRESS_HOST: 'explorer.example.invalid', ARTIFACT_DIR: artifacts, DEPLOY_TEMP_DIR: join(temp, 'deployment'),
      TEST_CALLS: callsFile, TEST_VALUES: valuesFile, TEST_ISSUER: issuer,
      TEST_DASHBOARD_OK: 'true', TEST_DASHBOARD: JSON.stringify(healthyDashboard()), ...overrides,
    };
    let result;
    try {
      result = { code: 0, ...(await execute('/bin/bash', [script], { cwd: directory, env, timeout: 15000 })) };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    result.calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    result.values = await readFile(valuesFile, 'utf8').then(JSON.parse, () => null);
    return result;
  };
}

test('private library evidence IDs reach Helm as numbers and legacy QA may have no history', async t => {
  const run = await fixture(t);
  const result = await run({ ADO_QA_DEV_PIPELINE_ID: '105', ADO_QA_TST_PIPELINE_ID: '106', ADO_SCAN_PIPELINE_ID: '107' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.values.ado.pipelines, { dev: 101, createRelease: 102, release: 103, qa: 104, qaDev: 105, qaTst: 106, scan: 107 });
  assert.match(result.stdout, /ADO read smoke check passed/);
  const pipeline = await readFile(join(directory, 'pipeline.yaml'), 'utf8');
  for (const name of optionalIds) assert.ok(pipeline.includes(`${name}: $(${name})`), `${name} must be forwarded from the library`);
});

test('absent, empty and exact unresolved optional macros become null Helm values', async t => {
  const run = await fixture(t);
  for (const overrides of [{}, Object.fromEntries(optionalIds.map(name => [name, ''])), Object.fromEntries(optionalIds.map(name => [name, `$(${name})`]))]) {
    const result = await run(overrides);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.values.ado.pipelines, { dev: 101, createRelease: 102, release: 103, qa: 104, qaDev: null, qaTst: null, scan: null });
  }
});

test('configured optional IDs accept bounds and reject malformed values before external commands', async t => {
  const run = await fixture(t);
  const bounded = await run({ ADO_QA_DEV_PIPELINE_ID: '1', ADO_QA_TST_PIPELINE_ID: '100000000', ADO_SCAN_PIPELINE_ID: '107' });
  assert.equal(bounded.code, 0, bounded.stderr);
  assert.equal(bounded.values.ado.pipelines.qaDev, 1);
  assert.equal(bounded.values.ado.pipelines.qaTst, 100000000);
  for (const name of optionalIds) {
    for (const value of ['0', '-1', '1.5', '100000001', '01', ' 105', '105 ', '$(otherVariable)', `$(${name})suffix`, 'null']) {
      const result = await run({ [name]: value });
      assert.notEqual(result.code, 0, `${name}=${value}`);
      assert.match(result.stderr, new RegExp(`${name} must be a positive pipeline ID`));
      assert.deepEqual(result.calls, [], 'Invalid configuration must fail before accessing Azure or Helm');
    }
  }
});

test('smoke check still rejects HTTP errors, invalid dashboard mode, ADO errors and missing core history', async t => {
  const run = await fixture(t);
  const cases = [
    { TEST_DASHBOARD_OK: 'false' },
    { TEST_DASHBOARD: JSON.stringify({ ...healthyDashboard(), mode: 'sample' }) },
    { TEST_DASHBOARD: JSON.stringify({ error: { code: 'access_denied' } }) },
  ];
  for (const kind of ['dev', 'create', 'release']) {
    const dashboard = healthyDashboard();
    dashboard.limits.pipelines.find(pipeline => pipeline.kind === kind).count = 0;
    cases.push({ TEST_DASHBOARD: JSON.stringify(dashboard) });
  }
  for (const overrides of cases) {
    const result = await run(overrides);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /ADO read smoke check failed/);
    assert.doesNotMatch(result.stdout, /ADO read smoke check passed/);
  }
});

test('smoke check still fails when environment access is unavailable', async t => {
  const run = await fixture(t);
  for (const code of ['environments_unavailable', 'environment_history_unavailable']) {
    const result = await run({ TEST_DASHBOARD: JSON.stringify({ ...healthyDashboard(), warnings: [{ code }] }) });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Environment history could not be verified/);
  }
});
