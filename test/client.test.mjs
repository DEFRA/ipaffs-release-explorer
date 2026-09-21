import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient, createTokenProvider } from '../src/ado-client.mjs';
import { loadConfig } from '../src/config.mjs';

// All identifiers and history in these tests are synthetic.
const config = loadConfig({
  ADO_ORGANIZATION: 'https://dev.azure.com/example-org', ADO_PROJECT: 'example-project',
  ADO_DEV_PIPELINE_ID: '101', ADO_CREATE_RELEASE_PIPELINE_ID: '102',
  ADO_RELEASE_PIPELINE_ID: '103', ADO_QA_PIPELINE_ID: '104',
});

test('ADO client can only call fixed GET history endpoints and never follow redirects', async () => {
  let called = 0;
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture-private-token',
    fetchImpl: async (url, options) => {
      called += 1;
      assert.equal(url.origin, 'https://dev.azure.com');
      assert.equal(url.pathname, '/example-org/example-project/_apis/build/builds');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fixture-private-token');
      return new Response(JSON.stringify({ value: [] }));
    },
  });
  await client.get('build/builds');
  for (const path of ['https://example.invalid/', '//example.invalid/', '../build/builds', 'build/builds?anything', 'git/repositories']) {
    await assert.rejects(client.get(path), /Unsupported ADO API path/);
  }
  assert.equal(called, 1);
});

test('pagination follows continuation tokens and reports a bounded scan', async () => {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async url => {
      calls.push(url);
      return new Response(JSON.stringify({ value: [{ id: calls.length }] }), { headers: { 'x-ms-continuationtoken': `page-${calls.length}` } });
    },
  });
  const list = await client.list('build/builds', { definitions: 103 }, 2);
  assert.deepEqual(list.items, [{ id: 1 }, { id: 2 }]);
  assert.equal(list.limited, true);
  assert.equal(calls[1].searchParams.get('continuationToken'), 'page-1');
  assert.equal(calls[1].searchParams.get('$top'), '1');
  assert.ok(calls.every(url => url.searchParams.get('api-version') === '7.2-preview.8'));
});

test('Environment deployment records use the documented top parameter', async () => {
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async url => {
      assert.equal(url.searchParams.get('top'), '20');
      assert.equal(url.searchParams.has('$top'), false);
      return new Response(JSON.stringify({ value: [] }));
    },
  });
  await client.list('distributedtask/environments/202/environmentdeploymentrecords', {}, 20);
});

test('Azure CLI token is cached in memory and not present in auth failure messages', async () => {
  let calls = 0;
  const provider = createTokenProvider({ env: {}, executeFile: async (file, args) => {
    calls += 1;
    assert.equal(file, 'az');
    assert.deepEqual(args.slice(0, 2), ['account', 'get-access-token']);
    return { stdout: JSON.stringify({ accessToken: 'fixture-private-token', expires_on: Math.floor(Date.now() / 1000) + 3600 }) };
  } });
  assert.deepEqual(await Promise.all([provider(), provider(), provider()]), Array(3).fill('Bearer fixture-private-token'));
  assert.equal(calls, 1);
  const failure = createTokenProvider({ env: {}, executeFile: async () => { throw new Error('fixture-private-token private-account-details'); } });
  await assert.rejects(failure(), error => error.code === 'sign_in_required' && !error.message.includes('fixture-private-token') && !error.message.includes('private-account-details'));
});

test('ADO error response bodies never reach the caller', async () => {
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async () => new Response('private-internal-error-and-token', { status: 403 }),
  });
  await assert.rejects(client.get('build/builds'), error => error.code === 'access_denied' && !error.message.includes('private-internal'));
});

test('an empty timeline response is distinct from a failed request and is not a valid history list', async () => {
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(await client.get('build/builds/501/timeline'), { data: null, continuation: null });
  await assert.rejects(client.list('build/builds'), error => error.code === 'invalid_response');
});

test('organization configuration rejects credential destinations outside ADO', () => {
  for (const value of ['http://dev.azure.com/example', 'https://dev.azure.com.example.invalid/org', 'https://example.invalid/', 'https://user:password@dev.azure.com/org']) {
    assert.throws(() => loadConfig({ ADO_ORGANIZATION: value }));
  }
});


test('only Build summary endpoints use the API version exposing abandoned status', async () => {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname.split('/_apis/')[1], version: url.searchParams.get('api-version'), accept: options.headers.Accept });
      return new Response(JSON.stringify({ value: [] }));
    },
  });
  await client.list('build/builds', { definitions: 102 }, 100);
  await client.get('build/builds/501');
  await client.get('build/builds/501/timeline');
  await client.get('build/builds/501/logs/17', {}, { text: true });
  await client.list('distributedtask/environments', { 'api-version': '7.1-preview.1' });
  await client.list('distributedtask/environments/202/environmentdeploymentrecords', { 'api-version': '7.1-preview.1' }, 20);
  assert.deepEqual(calls, [
    { path: 'build/builds', version: '7.2-preview.8', accept: 'application/json' },
    { path: 'build/builds/501', version: '7.2-preview.8', accept: 'application/json' },
    { path: 'build/builds/501/timeline', version: '7.1', accept: 'application/json' },
    { path: 'build/builds/501/logs/17', version: '7.1', accept: 'text/plain' },
    { path: 'distributedtask/environments', version: '7.1-preview.1', accept: 'application/json' },
    { path: 'distributedtask/environments/202/environmentdeploymentrecords', version: '7.1-preview.1', accept: 'application/json' },
  ]);
});

test('a Build summary error does not fall back to an older API version or an HTML page', async () => {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async url => {
      calls.push(url.href);
      return new Response('private-upstream-details', { status: 400 });
    },
  });
  await assert.rejects(client.list('build/builds'), error => error.code === 'ado_response_error' && !error.message.includes('private-upstream-details'));
  assert.deepEqual(calls, ['https://dev.azure.com/example-org/example-project/_apis/build/builds?api-version=7.2-preview.8&%24top=100']);
});

test('API response size is bounded and malformed responses do not expose their content', async () => {
  for (const [response, code] of [
    [new Response('x'.repeat(12 * 1024 * 1024 + 1)), 'response_too_large'],
    [new Response('private-malformed-response'), 'invalid_response'],
  ]) {
    const client = new AdoClient(config, { authorization: async () => 'Bearer fixture', fetchImpl: async () => response });
    await assert.rejects(client.get('build/builds'), error => error.code === code && !error.message.includes('private-malformed-response'));
  }
});
