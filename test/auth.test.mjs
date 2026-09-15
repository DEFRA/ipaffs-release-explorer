import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTokenProvider } from '../src/ado-client.mjs';

const identity = {
  AZURE_TENANT_ID: '11111111-2222-3333-4444-555555555555',
  AZURE_CLIENT_ID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  AZURE_FEDERATED_TOKEN_FILE: '/var/run/secrets/azure/tokens/azure-identity-token',
  AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com/',
};
const noCli = async () => { assert.fail('Pod identity must never fall back to Azure CLI'); };
const tokenResponse = (token = 'fixture-private-access-token', extra = {}) => new Response(JSON.stringify({
  access_token: token, token_type: 'Bearer', expires_in: 3600, ...extra,
}));

test('workload identity exchanges only for the fixed ADO scope and shares one cached renewal', async () => {
  let reads = 0;
  let exchanges = 0;
  const authorization = createTokenProvider({
    env: identity,
    executeFile: noCli,
    readTokenFile: async (file, options) => {
      reads += 1;
      assert.equal(file, identity.AZURE_FEDERATED_TOKEN_FILE);
      assert.equal(options.encoding, 'utf8');
      assert.ok(options.signal instanceof AbortSignal);
      return 'fixture-private-assertion\n';
    },
    fetchImpl: async (url, options) => {
      exchanges += 1;
      assert.equal(url, `https://login.microsoftonline.com/${identity.AZURE_TENANT_ID}/oauth2/v2.0/token`);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
      assert.deepEqual(Object.fromEntries(options.body), {
        client_id: identity.AZURE_CLIENT_ID,
        scope: '499b84ac-1321-427f-aa17-267ca6975798/.default',
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: 'fixture-private-assertion',
      });
      return tokenResponse();
    },
  });
  assert.deepEqual(await Promise.all([authorization(), authorization(), authorization()]), Array(3).fill('Bearer fixture-private-access-token'));
  assert.equal(await authorization(), 'Bearer fixture-private-access-token');
  assert.equal(reads, 1);
  assert.equal(exchanges, 1);
});

test('renewal reopens the projected token file and uses the rotated assertion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ipaffs-auth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'token');
  await writeFile(path, 'first-private-assertion');
  let currentTime = 1_000_000;
  const assertions = [];
  const authorization = createTokenProvider({
    env: { ...identity, AZURE_FEDERATED_TOKEN_FILE: path },
    executeFile: noCli,
    now: () => currentTime,
    fetchImpl: async (url, options) => {
      assertions.push(options.body.get('client_assertion'));
      return tokenResponse(`access-token-${assertions.length}`);
    },
  });
  assert.equal(await authorization(), 'Bearer access-token-1');
  await writeFile(path, 'rotated-private-assertion');
  currentTime += 3_481_000; // Enter the two-minute renewal window.
  assert.deepEqual(await Promise.all([authorization(), authorization()]), ['Bearer access-token-2', 'Bearer access-token-2']);
  assert.deepEqual(assertions, ['first-private-assertion', 'rotated-private-assertion']);
});

test('partial or invalid workload configuration fails before reading credentials or falling back', async () => {
  for (const env of [
    { AZURE_TENANT_ID: identity.AZURE_TENANT_ID },
    { AZURE_CLIENT_ID: identity.AZURE_CLIENT_ID },
    { AZURE_FEDERATED_TOKEN_FILE: identity.AZURE_FEDERATED_TOKEN_FILE },
    { AZURE_FEDERATED_TOKEN_FILE: '' },
    { ...identity, AZURE_TENANT_ID: '../other-tenant' },
    { ...identity, AZURE_CLIENT_ID: '' },
    { ...identity, AZURE_FEDERATED_TOKEN_FILE: 'relative-token-file' },
    { ...identity, AZURE_AUTHORITY_HOST: 'https://login.microsoftonline.com.attacker.invalid/' },
  ]) {
    const authorization = createTokenProvider({ env, executeFile: noCli,
      readTokenFile: async () => assert.fail('Must validate first'),
      fetchImpl: async () => assert.fail('Must validate first'),
    });
    await assert.rejects(authorization(), error => error.code === 'workload_identity_configuration' && error.status === 503);
  }
});

test('explicit PAT and bearer settings retain precedence without reading workload credentials', async () => {
  for (const [env, expected] of [
    [{ ...identity, ADO_PAT: 'fixture-pat', ADO_BEARER_TOKEN: 'unused' }, `Basic ${Buffer.from(':fixture-pat').toString('base64')}`],
    [{ AZURE_CLIENT_ID: 'partial-configuration', ADO_BEARER_TOKEN: 'fixture-bearer' }, 'Bearer fixture-bearer'],
  ]) {
    const authorization = createTokenProvider({ env, executeFile: noCli,
      readTokenFile: async () => assert.fail('Explicit credentials take precedence'),
      fetchImpl: async () => assert.fail('Explicit credentials take precedence'),
    });
    assert.equal(await authorization(), expected);
  }
});

test('failed workload exchange is retried next time without leaking errors or using CLI', async () => {
  let exchanges = 0;
  const authorization = createTokenProvider({
    env: identity, executeFile: noCli,
    readTokenFile: async () => 'fixture-private-assertion',
    fetchImpl: async () => {
      exchanges += 1;
      if (exchanges === 1) return new Response('fixture-private-assertion private-account-details', { status: 400 });
      return tokenResponse();
    },
  });
  await assert.rejects(authorization(), error => error.code === 'workload_identity_unavailable'
    && error.status === 503 && !error.message.includes('private') && !error.cause);
  assert.equal(await authorization(), 'Bearer fixture-private-access-token');
  assert.equal(exchanges, 2);
});

test('file, timeout and malformed token responses remain generic and never cache credentials', async () => {
  const failureCases = [
    { readTokenFile: async () => { throw new Error('private-token-file-path'); } },
    { readTokenFile: async () => '' },
    { readTokenFile: async () => 'private'.repeat(20000) },
    { fetchImpl: async () => { throw new DOMException('private-token-request', 'TimeoutError'); } },
    { fetchImpl: async () => new Response('private-invalid-json') },
    { fetchImpl: async () => new Response('private'.repeat(200000)) },
    ...[
      { access_token: '' }, { access_token: 42 }, { access_token: 'private\r\ninjection' },
      { token_type: 'Basic' }, { expires_in: 0 }, { expires_in: -1 },
      { expires_in: 'private-not-a-number' }, { expires_in: 1e308 },
    ].map(extra => ({ fetchImpl: async () => tokenResponse(undefined, extra) })),
  ];
  for (const failure of failureCases) {
    const authorization = createTokenProvider({ env: identity, executeFile: noCli,
      readTokenFile: async () => 'fixture-private-assertion', fetchImpl: async () => tokenResponse(), ...failure,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(authorization(), error => error.code === 'workload_identity_unavailable'
        && error.status === 503 && !error.message.includes('private') && !error.cause);
    }
  }
});

test('an expired response cannot be cached or returned after a slow token exchange', async () => {
  let currentTime = 1000;
  const authorization = createTokenProvider({ env: identity, executeFile: noCli,
    now: () => currentTime, readTokenFile: async () => 'fixture-private-assertion',
    fetchImpl: async () => { currentTime += 2000; return tokenResponse(undefined, { expires_in: 1 }); },
  });
  await assert.rejects(authorization(), error => error.code === 'workload_identity_unavailable');
});
