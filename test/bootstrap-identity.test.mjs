import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(directory, 'deploy/scripts/bootstrap-identity.sh');
// Synthetic deployment configuration. The stub never delegates to a real Azure CLI.
const subscription = '11111111-1111-1111-1111-111111111111';
const clientId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const tenantId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const principalObjectId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const issuer = 'https://example.oic.prod-aks.azure.com/example/issuer/';
const cluster = { oidcIssuerProfile: { enabled: true, issuerUrl: issuer }, securityProfile: { workloadIdentity: { enabled: true } } };
const resourceId = name => `/subscriptions/${subscription}/resourceGroups/example-dev-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}`;
const outputs = (name = 'ipaffs-release-explorer-dev') => ({
  identityResourceId: { type: 'String', value: resourceId(name) },
  identityClientId: { type: 'String', value: clientId },
  identityTenantId: { type: 'String', value: tenantId },
  identityPrincipalObjectId: { type: 'String', value: principalObjectId },
});
const argument = (call, name) => call[call.indexOf(name) + 1];
const deploymentCall = calls => calls.find(call => call[0] === 'deployment');

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'explorer-bootstrap-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const callsFile = join(temp, 'calls.jsonl');
  await writeFile(join(temp, 'az'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_AZ_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'account' && args[1] === 'show') {
  process.stdout.write(process.env.TEST_SUBSCRIPTION + '\\n');
} else if (args[0] === 'aks' && args[1] === 'show') {
  process.stdout.write(process.env.TEST_CLUSTER);
} else if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'what-if') {
  process.stdout.write('Synthetic preview; no changes applied.\\n');
} else if (args[0] === 'deployment' && args[1] === 'group' && args[2] === 'create') {
  process.stdout.write(process.env.TEST_OUTPUTS);
} else {
  process.stderr.write('Unexpected Azure command in offline fixture.\\n');
  process.exit(97);
}
`, { mode: 0o755 });
  return async (args = [], overrides = {}) => {
    await writeFile(callsFile, '');
    const env = {
      PATH: `${temp}:${process.env.PATH}`,
      AKS_RESOURCE_GROUP: 'example-dev-rg', AKS_NAME: 'example-dev-aks', AZURE_SUBSCRIPTION: subscription,
      TEST_AZ_CALLS: callsFile, TEST_SUBSCRIPTION: subscription,
      TEST_CLUSTER: JSON.stringify(cluster), TEST_OUTPUTS: JSON.stringify(outputs()),
      ...overrides,
    };
    let result;
    try {
      result = { code: 0, ...(await execute('/bin/bash', [script, ...args], { cwd: directory, env, timeout: 15000 })) };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    result.calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return result;
  };
}

test('identity bootstrap defaults to preview with only the dedicated Bicep parameters', async t => {
  const run = await fixture(t);
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => call.slice(0, 3)), [
    ['aks', 'show', '--subscription'], ['deployment', 'group', 'what-if'],
  ]);
  const call = deploymentCall(result.calls);
  assert.equal(argument(call, '--subscription'), subscription);
  assert.equal(argument(call, '--resource-group'), 'example-dev-rg');
  assert.equal(argument(call, '--name'), 'release-explorer-identity');
  assert.equal(argument(call, '--mode'), 'Incremental');
  assert.equal(resolve(argument(call, '--template-file')), join(directory, 'infrastructure/workload-identity.bicep'));
  for (const parameter of ['identityName=ipaffs-release-explorer-dev', 'namespace=ipaffs-release-explorer', `oidcIssuerUrl=${issuer}`]) {
    assert.ok(call.includes(parameter), `Missing parameter ${parameter}`);
  }
  assert.equal(result.stdout.includes('##vso['), false);
});

test('apply can resolve the current subscription and scopes identity and deployment names', async t => {
  const run = await fixture(t);
  const result = await run(['--apply'], {
    AZURE_SUBSCRIPTION: '', NAMESPACE: 'explorer-tools', IDENTITY_DEPLOYMENT_NAME: 'release-explorer-501',
    TEST_OUTPUTS: JSON.stringify(outputs('explorer-tools-dev')),
  });
  assert.equal(result.code, 0, result.stderr);
  const account = result.calls.find(call => call[0] === 'account');
  assert.deepEqual(account.slice(0, 2), ['account', 'show']);
  assert.equal(argument(account, '--query'), 'id');
  assert.equal(argument(account, '--output'), 'tsv');
  const call = deploymentCall(result.calls);
  assert.equal(call[2], 'create');
  assert.equal(argument(call, '--mode'), 'Incremental');
  assert.equal(argument(call, '--subscription'), subscription);
  assert.equal(argument(call, '--name'), 'release-explorer-501');
  assert.ok(call.includes('identityName=explorer-tools-dev'));
  assert.ok(call.includes('namespace=explorer-tools'));
  assert.equal(argument(call, '--query'), 'properties.outputs');
  assert.equal(result.stdout.includes('##vso['), false);
});

test('pipeline apply emits four validated immutable output variables', async t => {
  const run = await fixture(t);
  const result = await run(['--apply', '--pipeline'], { IDENTITY_NAME: 'example-custom-identity', TEST_OUTPUTS: JSON.stringify(outputs('example-custom-identity')) });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(deploymentCall(result.calls).includes('identityName=example-custom-identity'));
  const expected = { identityResourceId: resourceId('example-custom-identity'), clientId, tenantId, principalObjectId };
  const commands = result.stdout.split('\n').filter(line => line.startsWith('##vso['));
  assert.equal(commands.length, 4);
  const actual = {};
  for (const command of commands) {
    const match = /^##vso\[task\.setvariable ([^\]]+)\](.+)$/.exec(command);
    assert.ok(match, 'Expected only output variable commands');
    const properties = Object.fromEntries(match[1].split(';').filter(Boolean).map(value => value.split('=')));
    assert.equal(properties.isOutput, 'true');
    assert.equal(properties.isReadOnly, 'true');
    assert.equal(Object.hasOwn(actual, properties.variable), false, 'Each output must be emitted once');
    actual[properties.variable] = match[2];
  }
  assert.deepEqual(actual, expected);
});

test('malformed or missing identity outputs fail before emitting any pipeline variable', async t => {
  const run = await fixture(t);
  const badOutputs = ['not-json', '{}', 'null'];
  for (const key of Object.keys(outputs())) {
    const missing = outputs();
    delete missing[key];
    badOutputs.push(JSON.stringify(missing));
    const malformed = outputs();
    malformed[key].value = key === 'identityResourceId' ? '/subscriptions/example/resourceGroups/example/providers/Other/type/name' : 'not-a-uuid';
    badOutputs.push(JSON.stringify(malformed));
    const missingValue = outputs();
    missingValue[key] = { type: 'String' };
    badOutputs.push(JSON.stringify(missingValue));
  }
  for (const TEST_OUTPUTS of badOutputs) {
    const result = await run(['--apply', '--pipeline'], { TEST_OUTPUTS });
    assert.notEqual(result.code, 0, 'Unverifiable deployment output must fail');
    assert.equal(result.stdout.includes('##vso['), false, 'No output may escape before all outputs are validated');
  }
});

test('reserved or malformed namespaces fail before any Azure deployment command', async t => {
  const run = await fixture(t);
  for (const NAMESPACE of ['dev', 'tst', 'pre', 'prd', 'default', 'kube-system', 'UPPERCASE', '../outside', 'a'.repeat(64)]) {
    const result = await run(['--apply', '--pipeline'], { NAMESPACE });
    assert.notEqual(result.code, 0, NAMESPACE);
    assert.equal(deploymentCall(result.calls), undefined, NAMESPACE);
    assert.equal(result.stdout.includes('##vso['), false);
  }
});

test('missing cluster configuration or disabled federation fails before provisioning', async t => {
  const run = await fixture(t);
  for (const overrides of [
    { AKS_RESOURCE_GROUP: '' }, { AKS_NAME: '' },
    { TEST_CLUSTER: JSON.stringify({ ...cluster, oidcIssuerProfile: { ...cluster.oidcIssuerProfile, enabled: false } }) },
    { TEST_CLUSTER: JSON.stringify({ ...cluster, securityProfile: { workloadIdentity: { enabled: false } } }) },
    { TEST_CLUSTER: JSON.stringify({ ...cluster, oidcIssuerProfile: { enabled: true, issuerUrl: 'http://issuer.example.invalid/' } }) },
  ]) {
    const result = await run(['--apply', '--pipeline'], overrides);
    assert.notEqual(result.code, 0);
    assert.equal(deploymentCall(result.calls), undefined);
    assert.equal(result.stdout.includes('##vso['), false);
  }
});

test('pipeline mode requires explicit apply and rejects unknown options before Azure calls', async t => {
  const run = await fixture(t);
  for (const args of [['--pipeline'], ['--what-if', '--pipeline'], ['--apply', '--unknown'], ['--destroy']]) {
    const result = await run(args);
    assert.notEqual(result.code, 0, args.join(' '));
    assert.deepEqual(result.calls, [], args.join(' '));
    assert.equal(result.stdout.includes('##vso['), false);
  }
});
