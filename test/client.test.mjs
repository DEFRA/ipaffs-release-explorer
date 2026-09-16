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

test('organization configuration rejects credential destinations outside ADO', () => {
  for (const value of ['http://dev.azure.com/example', 'https://dev.azure.com.example.invalid/org', 'https://example.invalid/', 'https://user:password@dev.azure.com/org']) {
    assert.throws(() => loadConfig({ ADO_ORGANIZATION: value }));
  }
});

const runPage = (run = {}, { asObject = false, attributes = 'id="dataProviders" type="application/json"' } = {}) => {
  const provider = { id: 501, pipeline: { id: 102 }, status: 16, result: 2, headerPills: ['Abandoned'], privateData: 'must-not-be-returned', ...run };
  return `<html><script>throw new Error('must-not-execute')</script><script ${attributes}>${JSON.stringify({ data: { 'ms.vss-build-web.run-details-data-provider': asObject ? provider : JSON.stringify(provider) } })}</script></html>`;
};

test('current run status uses a fixed authenticated GET and returns only verified identifiers and state', async () => {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture-private-token',
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(url.href, 'https://dev.azure.com/example-org/example-project/_build/results?buildId=501');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Accept, 'text/html');
      assert.equal(options.headers.Authorization, 'Bearer fixture-private-token');
      return new Response(runPage());
    },
  });
  // The page's Abandoned state takes precedence even though its result remains success (2).
  assert.deepEqual(await client.getRunStatus(501, 102), { id: 501, pipelineId: 102, status: 16 });
  assert.equal(client.requests, 1);
  for (const [id, pipeline] of [['https://example.invalid', 102], [0, 102], [501, '../123'], [501, NaN]]) {
    await assert.rejects(client.getRunStatus(id, pipeline), /Invalid ADO run identifiers/);
  }
  assert.equal(calls.length, 1);
});

test('run status accepts a JSON object provider and supported attribute order without reading display pills', async () => {
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture',
    fetchImpl: async () => new Response(runPage({ status: 2, headerPills: ['Abandoned'] }, { asObject: true, attributes: "type='application/json' nonce='fixture' id='dataProviders'" })),
  });
  assert.deepEqual(await client.getRunStatus(501, 102), { id: 501, pipelineId: 102, status: 2 });
});

test('unmatched, malformed, or unknown run-page data cannot establish a run state', async () => {
  const pages = [
    runPage({ id: 502 }), runPage({ pipeline: { id: 103 } }),
    runPage({ status: '16' }), runPage({ status: 3 }), runPage({ status: 0 }), runPage({ status: 63 }),
    runPage({}, { attributes: 'id="dataProviders" type="text/javascript"' }),
    runPage({}, { attributes: 'data-id="dataProviders" type="application/json"' }),
    runPage() + runPage(),
    '<script id="dataProviders" type="application/json">private-malformed-page</script>',
    '<html><p>Abandoned</p></html>',
    '<script id="dataProviders" type="application/json">{"data":{"ms.vss-build-web.run-details-data-provider":"not-json-private"}}</script>',
  ];
  for (const page of pages) {
    const client = new AdoClient(config, {
      authorization: async () => 'Bearer fixture', fetchImpl: async () => new Response(page),
    });
    await assert.rejects(client.getRunStatus(501, 102), error => error.code === 'invalid_run_state' && !error.message.includes('private'));
  }
});

test('run-page response size is bounded and access errors never expose HTML', async () => {
  for (const [response, code] of [
    [new Response('private-page'.repeat(200000)), 'response_too_large'],
    [new Response('private-page', { status: 403 }), 'access_denied'],
  ]) {
    const client = new AdoClient(config, { authorization: async () => 'Bearer fixture', fetchImpl: async () => response });
    await assert.rejects(client.getRunStatus(501, 102), error => error.code === code && !error.message.includes('private-page'));
  }
});
