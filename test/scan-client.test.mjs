import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient } from '../src/ado-client.mjs';

// All artifact identifiers and reports are synthetic.
const config = { organization: 'https://dev.azure.com/example-org', project: 'example-project' };
const artifact = () => ({ name: 'scan-baseline', resource: { type: 'Container', data: '#/3001/scan-baseline' } });
const report = { schemaVersion: 1, complete: true, sourceCommit: 'a'.repeat(40), totals: { critical: 1, high: 2 } };
const json = data => new Response(JSON.stringify(data));
function clientWithArtifact(value, response = () => json(report)) {
  const calls = [];
  const client = new AdoClient(config, {
    authorization: async () => 'Bearer fixture-private-token',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return calls.length === 1 ? json({ value }) : response(url, options);
    },
  });
  return { client, calls };
}

test('scan report downloads only the exact JSON file from its configured ADO organization', async () => {
  const item = artifact();
  item.resource.downloadUrl = 'https://untrusted.invalid/full-archive';
  item.resource.url = 'https://untrusted.invalid/arbitrary-content';
  const { client, calls } = clientWithArtifact([item, { name: 'container-scans', resource: { type: 'Container', data: '#/9001/container-scans' } }]);
  assert.deepEqual(await client.getScanReport(501), report);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.href, 'https://dev.azure.com/example-org/example-project/_apis/build/builds/501/artifacts?api-version=7.1');
  const download = calls[1];
  assert.equal(download.url.origin, 'https://dev.azure.com');
  assert.equal(download.url.pathname, '/example-org/_apis/resources/Containers/3001');
  assert.deepEqual(Object.fromEntries(download.url.searchParams), {
    'api-version': '7.1-preview.4', itemPath: 'scan-baseline/report.json', preferRedirect: 'false',
  });
  assert.equal(download.options.headers.Accept, 'application/octet-stream');
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-private-token');
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test('missing scan artifacts do not fetch other archives', async () => {
  const { client, calls } = clientWithArtifact([{ name: 'container-scans' }]);
  assert.equal(await client.getScanReport(501), null);
  assert.equal(calls.length, 1);
});

test('scan build IDs cannot change the request path or query', async () => {
  const { client, calls } = clientWithArtifact([artifact()]);
  for (const id of ['../502', '501?x=1', '501/../../git', '//untrusted.invalid', 0, -1, NaN, null, {}, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.getScanReport(id), /Invalid scan build ID/);
  }
  assert.equal(calls.length, 0);
});

test('unexpected or ambiguous artifact locations are rejected before downloading', async () => {
  const bad = [
    { name: 'scan-baseline', resource: { type: 'PipelineArtifact', data: '#/3001/scan-baseline' } },
    { name: 'scan-baseline', resource: { type: 'Container', data: 'https://untrusted.invalid/report.json' } },
    { name: 'scan-baseline', resource: { type: 'Container', data: '#/3001/../other-artifact' } },
    { name: 'scan-baseline', resource: { type: 'Container', data: '#/3001/container-scans' } },
    { name: 'scan-baseline', resource: { type: 'Container', data: '#/3001/scan-baseline?url=other' } },
    { name: 'scan-baseline', resource: { type: 'Container', data: '#/9007199254740992/scan-baseline' } },
    { name: 'scan-baseline' },
  ];
  for (const values of [...bad.map(item => [item]), [artifact(), artifact()]]) {
    const { client, calls } = clientWithArtifact(values);
    await assert.rejects(client.getScanReport(501), error => error.code === 'invalid_response');
    assert.equal(calls.length, 1);
  }
});

test('artifact metadata must be a list, not a failed or malformed payload', async () => {
  const client = new AdoClient(config, { authorization: async () => 'Bearer fixture', fetchImpl: async () => json({ artifacts: [artifact()] }) });
  await assert.rejects(client.getScanReport(501), error => error.code === 'invalid_response');
});

test('scan file responses are bounded and must contain a JSON object', async () => {
  for (const [response, code] of [
    [() => new Response('x'.repeat(12 * 1024 * 1024 + 1)), 'response_too_large'],
    [() => new Response('private-malformed-report'), 'invalid_response'],
    [() => json(null), 'invalid_response'],
    [() => json([]), 'invalid_response'],
    [() => json('private-string-payload'), 'invalid_response'],
    [() => new Response(null, { status: 204 }), 'invalid_response'],
  ]) {
    const { client } = clientWithArtifact([artifact()], response);
    await assert.rejects(client.getScanReport(501), error => error.code === code && !error.message.includes('private-'));
  }
});

test('scan artifact redirects are never followed or exposed', async () => {
  const { client, calls } = clientWithArtifact([artifact()], () => new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/private-ticket' } }));
  await assert.rejects(client.getScanReport(501), error => error.code === 'ado_response_error' && !error.message.includes('private-ticket'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.redirect, 'error');
});

test('scan artifact permission and retention failures preserve safe error codes', async () => {
  for (const [status, code] of [[403, 'access_denied'], [404, 'ado_response_error']]) {
    const { client } = clientWithArtifact([artifact()], () => new Response('private-upstream-data', { status }));
    await assert.rejects(client.getScanReport(501), error => error.code === code && error.status === status && !error.message.includes('private-'));
  }
});

test('Container API access is not exposed as a generic arbitrary-path proxy', async () => {
  const { client, calls } = clientWithArtifact([artifact()]);
  await assert.rejects(client.get('resources/Containers/3001', { itemPath: 'anything' }), /Unsupported ADO API path/);
  assert.equal(calls.length, 0);
});
