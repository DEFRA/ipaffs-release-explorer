import test from 'node:test';
import assert from 'node:assert/strict';
import { AdoClient } from '../src/ado-client.mjs';

const config = { organization: 'https://dev.azure.com/example-org', project: 'example project' };
const artifact = () => ({ name: 'secret-expiry-all', resource: { type: 'PipelineArtifact', data: 'a'.repeat(66),
  downloadUrl: 'https://untrusted.invalid/archive', url: 'https://untrusted.invalid/content' } });
const manifest = () => ({ manifestFormat: '1.1.0', items: [
  { path: '/report.json', blob: { id: 'b'.repeat(66), size: 1000 } },
  { path: '/report.html', blob: { id: 'c'.repeat(66), size: 5000 } },
], manifestReferences: [] });
const report = { schemaVersion: 1, complete: true };
function fixture(responses = [{ value: [artifact()] }, manifest(), report]) {
  const calls = [];
  const client = new AdoClient(config, { authorization: async () => 'Bearer fixture-token', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const response = responses[calls.length - 1];
    return response instanceof Response ? response : Response.json(response);
  } });
  return { client, calls };
}

test('expiry report reads only manifest and exact report blob through authenticated project GETs', async () => {
  const { client, calls } = fixture();
  assert.deepEqual(await client.getSecretExpiryReport(501), report);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.pathname, '/example-org/example%20project/_apis/build/builds/501/artifacts');
  for (const [index, { url, options }] of calls.entries()) {
    assert.equal(url.origin, 'https://dev.azure.com');
    assert.equal(url.pathname, calls[0].url.pathname);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    if (index) {
      assert.equal(options.headers.Accept, 'application/octet-stream');
      assert.equal(url.searchParams.get('artifactName'), 'secret-expiry-all');
      assert.equal(url.searchParams.get('fileName'), index === 1 ? 'manifest' : 'report.json');
      assert.equal(url.searchParams.get('fileId'), (index === 1 ? 'a' : 'b').repeat(66));
    }
  }
});

test('missing report artifact is not replaced with unrelated files', async () => {
  const { client, calls } = fixture([{ value: [{ name: 'secret-expiry-dev' }] }]);
  assert.equal(await client.getSecretExpiryReport(501), null);
  assert.equal(calls.length, 1);
});

test('ambiguous artifacts and malformed manifest entries fail before file reads', async () => {
  for (const artifacts of [[artifact(), artifact()], [{ ...artifact(), resource: { type: 'Container', data: '#/10/secret-expiry-all' } }],
    [{ ...artifact(), resource: { type: 'PipelineArtifact', data: '../report' } }]]) {
    const { client, calls } = fixture([{ value: artifacts }]);
    await assert.rejects(client.getSecretExpiryReport(501), error => error.code === 'invalid_response');
    assert.equal(calls.length, 1);
  }
  for (const value of [null, {}, { ...manifest(), manifestFormat: '2.0' },
    { ...manifest(), manifestReferences: [{ id: 'c'.repeat(66) }] }, { ...manifest(), items: [] },
    { ...manifest(), items: [manifest().items[0], manifest().items[0]] },
    { ...manifest(), items: [{ path: '/report.json', blob: { id: 'https://untrusted.invalid', size: 1000 } }] },
    { ...manifest(), items: [{ path: '/report.json', blob: { id: 'b'.repeat(66), size: 4 * 1024 * 1024 + 1 } }] }]) {
    const { client, calls } = fixture([{ value: [artifact()] }, value]);
    await assert.rejects(client.getSecretExpiryReport(501), error => error.code === 'invalid_response');
    assert.equal(calls.length, 2);
  }
});

test('expiry report build IDs cannot alter the path or query', async () => {
  for (const id of ['1/../../2', '1?other=true', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const { client, calls } = fixture();
    await assert.rejects(client.getSecretExpiryReport(id), /Invalid report build ID/);
    assert.equal(calls.length, 0);
  }
});

test('expiry API access, malformed JSON and oversized file failures stay sanitized', async () => {
  for (const response of [new Response('private upstream error', { status: 403 }), new Response('not json'),
    new Response('x'.repeat(4 * 1024 * 1024 + 1)), Response.json([])]) {
    const { client } = fixture([{ value: [artifact()] }, manifest(), response]);
    await assert.rejects(client.getSecretExpiryReport(501), error => !error.message.includes('private')
      && ['access_denied', 'invalid_response', 'response_too_large'].includes(error.code));
  }
});
