import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createNamespaceClient, attachNamespaceChecks } from '../src/kubernetes.mjs';

const checkedAt = '2026-10-15T10:00:00.000Z';
const now = () => Date.parse(checkedAt);
const privateValue = 'fixture-private-token-and-upstream-details';
const namespace = (name = 'dev-fixture', overrides = {}) => ({
  apiVersion: 'v1', kind: 'Namespace', metadata: { name }, status: { phase: 'Active' }, ...overrides,
});
const missing = (name = 'dev-fixture') => ({
  apiVersion: 'v1', kind: 'Status', reason: 'NotFound', details: { name, kind: 'namespaces' },
});
const dashboard = names => ({ namespaces: names.map(name => ({ name })), coverage: [], warnings: [] });

// Exercise the Node HTTPS request contract without network access or credentials.
// Responses are emitted after end(), as with a real request, and AbortSignal and
// destroy() produce request errors so timeout and size handling are observable.
function fixture(responses = [{ status: 200, body: namespace() }], overrides = {}) {
  const requests = [];
  const reads = [];
  let destroyed = 0;
  const readFileImpl = async (path, encoding) => {
    reads.push({ path, encoding });
    return path.endsWith('/token') ? ` ${privateValue}\n` : 'fixture-ca-certificate';
  };
  const requestImpl = (url, options, callback) => {
    const responseFixture = responses[requests.length];
    requests.push({ url, options });
    const req = new EventEmitter();
    req.destroy = error => {
      destroyed += 1;
      queueMicrotask(() => req.emit('error', error));
      return req;
    };
    req.end = () => {
      queueMicrotask(() => {
        if (responseFixture.error) {
          req.emit('error', responseFixture.error);
          return;
        }
        if (responseFixture.waitForAbort) {
          const keepAlive = setTimeout(() => {}, 1000);
          options.signal.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            req.emit('error', options.signal.reason);
          }, { once: true });
          return;
        }
        const response = new EventEmitter();
        response.statusCode = responseFixture.status;
        callback(response);
        if (responseFixture.responseError) {
          response.emit('error', responseFixture.responseError);
          return;
        }
        const body = responseFixture.raw ?? JSON.stringify(responseFixture.body);
        response.emit('data', Buffer.from(body));
        response.emit('end');
      });
      return req;
    };
    return req;
  };
  return {
    client: createNamespaceClient({ readFileImpl, requestImpl, now, ...overrides }),
    requests, reads, destroyed: () => destroyed,
  };
}

function assertUnknown(result) {
  assert.equal(result.status, 'unknown');
  assert.equal(result.checkedAt, checkedAt);
  assert.match(result.detail, /unknown/);
  assert.equal(JSON.stringify(result).includes(privateValue), false);
}

test('namespace checks use only an exact in-cluster GET with the mounted CA and token', async () => {
  const { client, requests, reads } = fixture();
  const result = await client.check('dev-fixture');
  assert.equal(result.status, 'exists');
  assert.equal(result.checkedAt, checkedAt);
  assert.match(result.detail, /does not establish workload health/);
  assert.equal(JSON.stringify(result).includes(privateValue), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.href, 'https://kubernetes.default.svc/api/v1/namespaces/dev-fixture');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.ca, 'fixture-ca-certificate');
  assert.equal(requests[0].options.rejectUnauthorized, true);
  assert.deepEqual(requests[0].options.headers, { Authorization: `Bearer ${privateValue}`, Accept: 'application/json' });
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.deepEqual(reads, [
    { path: '/var/run/secrets/kubernetes.io/serviceaccount/token', encoding: 'utf8' },
    { path: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt', encoding: 'utf8' },
  ]);
});

test('each namespace check rereads rotated service-account credentials', async () => {
  let token = 'first-token';
  let ca = 'first-ca';
  const { client, requests } = fixture([
    { status: 200, body: namespace() }, { status: 200, body: namespace() },
  ], { readFileImpl: async path => path.endsWith('/token') ? token : ca });
  await client.check('dev-fixture');
  token = 'rotated-token';
  ca = 'rotated-ca';
  await client.check('dev-fixture');
  assert.deepEqual(requests.map(({ options }) => [options.headers.Authorization, options.ca]), [
    ['Bearer first-token', 'first-ca'], ['Bearer rotated-token', 'rotated-ca'],
  ]);
});

test('namespace deletion is confirmed only by the matching Kubernetes NotFound Status', async () => {
  const { client } = fixture([{ status: 404, body: missing() }]);
  const result = await client.check('dev-fixture');
  assert.equal(result.status, 'missing');
  assert.equal(result.checkedAt, checkedAt);
  assert.match(result.detail, /historical record/);
  assert.match(result.detail, /deletion time is not available/);
});

test('either a deletion timestamp or Terminating phase means deletion is in progress', async () => {
  for (const body of [
    namespace('dev-fixture', { metadata: { name: 'dev-fixture', deletionTimestamp: checkedAt } }),
    namespace('dev-fixture', { status: { phase: 'Terminating' } }),
  ]) {
    const { client } = fixture([{ status: 200, body }]);
    assert.equal((await client.check('dev-fixture')).status, 'terminating');
  }
});

test('denials, server errors, redirects and ambiguous 404 responses never imply deletion', async () => {
  const responses = [
    ...[401, 403, 429, 500, 503, 302].map(status => ({ status, body: { message: privateValue } })),
    { status: 404, raw: privateValue },
    { status: 404, body: { message: privateValue } },
    { status: 404, body: missing('another-namespace') },
    { status: 404, body: { ...missing(), reason: 'Forbidden' } },
    { status: 404, body: { ...missing(), kind: 'Namespace' } },
    { status: 404, body: { ...missing(), details: { name: 'dev-fixture', kind: 'pods' } } },
  ];
  const { client, requests } = fixture(responses);
  for (const response of responses) {
    const result = await client.check('dev-fixture');
    assertUnknown(result);
    if ([401, 403].includes(response.status)) assert.match(result.detail, /authorize/);
  }
  assert.equal(requests.length, responses.length, 'no redirect, retry or alternate destination is followed');
});

test('a 200 response must identify the exact namespace and a recognized phase', async () => {
  for (const body of [
    null, {}, namespace('another-namespace'), namespace('dev-fixture', { kind: 'Status' }),
    namespace('dev-fixture', { apiVersion: 'v2' }), namespace('dev-fixture', { status: {} }),
    namespace('dev-fixture', { status: { phase: 'Unexpected' } }),
  ]) {
    const { client } = fixture([{ status: 200, body }]);
    assertUnknown(await client.check('dev-fixture'));
  }
});

test('invalid namespace names cannot cause credential reads or HTTP requests', async () => {
  const { client, reads, requests } = fixture([]);
  for (const name of ['', undefined, null, 123, 'DEV', '-dev', 'dev-', 'a'.repeat(64),
    'dev/name', '../dev', 'dev?watch=true', 'dev#fragment', 'https://example.invalid', 'dev\n']) {
    const result = await client.check(name);
    assert.equal(result.status, 'unknown');
    assert.match(result.detail, /invalid/);
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(requests, []);
});

test('missing or unreadable credentials give a sanitized unknown without a request', async () => {
  for (const readFileImpl of [
    async () => '',
    async path => path.endsWith('/token') ? privateValue : ' ',
    async () => { throw new Error(privateValue); },
  ]) {
    const { client, requests } = fixture([], { readFileImpl });
    assertUnknown(await client.check('dev-fixture'));
    assert.deepEqual(requests, []);
  }
});

test('network, TLS, stream and timeout failures are sanitized and remain unknown', async () => {
  const { client } = fixture([
    { error: Object.assign(new Error(privateValue), { code: 'ECONNREFUSED' }) },
    { error: Object.assign(new Error(privateValue), { code: 'CERT_HAS_EXPIRED' }) },
    { responseError: new Error(privateValue) },
    { waitForAbort: true },
  ], { timeoutMs: 10 });
  for (let index = 0; index < 4; index += 1) assertUnknown(await client.check('dev-fixture'));
});

test('malformed and oversized bodies remain unknown and oversized requests are destroyed', async () => {
  const { client, destroyed } = fixture([
    { status: 200, raw: privateValue },
    { status: 200, body: { ...namespace(), message: privateValue.repeat(5000) } },
  ]);
  assertUnknown(await client.check('dev-fixture'));
  assertUnknown(await client.check('dev-fixture'));
  assert.equal(destroyed(), 1);
});

test('disabled checks replace stale namespace evidence without any cluster I/O', async () => {
  const data = dashboard(['dev-fixture']);
  data.namespaces[0].runtime = { status: 'exists', checkedAt };
  let calls = 0;
  await attachNamespaceChecks(data, {
    enabled: false, client: { check: async () => { calls += 1; } },
    now: () => { throw new Error('disabled checks should not read the clock'); },
  });
  assert.equal(calls, 0);
  assert.deepEqual(data.namespaceChecks, { enabled: false, checkedAt: null, status: 'unavailable' });
  assert.deepEqual(data.namespaces[0].runtime, {
    status: 'unknown', checkedAt: null, detail: 'Kubernetes namespace checks are disabled.',
  });
});

test('attachment deduplicates names and reports partial evidence without leaking a failed check', async () => {
  const data = dashboard(['dev-present', 'dev-absent', 'dev-present', 'dev-denied', 'dev-error']);
  const calls = [];
  await attachNamespaceChecks(data, { enabled: true, now, client: {
    check: async name => {
      calls.push(name);
      if (name === 'dev-error') throw new Error(privateValue);
      return { status: { 'dev-present': 'exists', 'dev-absent': 'missing', 'dev-denied': 'unknown' }[name], checkedAt };
    },
  } });
  assert.deepEqual(calls.sort(), ['dev-absent', 'dev-denied', 'dev-error', 'dev-present']);
  assert.deepEqual(data.namespaces.map(row => row.runtime.status), ['exists', 'missing', 'exists', 'unknown', 'unknown']);
  assert.equal(data.namespaceChecks.status, 'partial');
  assert.equal(data.namespaceChecks.checkedAt, checkedAt);
  assert.equal(data.coverage.at(-1).status, 'partial');
  assert.equal(data.warnings.at(-1).code, 'namespace_checks_unavailable');
  assert.equal(JSON.stringify(data).includes(privateValue), false);
});

test('all verified namespace states produce available coverage, including confirmed absences', async () => {
  const data = dashboard(['dev-present', 'dev-absent', 'dev-deleting']);
  const statuses = ['exists', 'missing', 'terminating'];
  await attachNamespaceChecks(data, { enabled: true, now, client: {
    check: async () => ({ status: statuses.shift(), checkedAt }),
  } });
  assert.equal(data.namespaceChecks.status, 'available');
  assert.equal(data.coverage.at(-1).status, 'available');
  assert.deepEqual(data.warnings, []);
});

test('empty retained history probes dev to establish whether cluster checks are available', async () => {
  for (const status of ['exists', 'missing', 'unknown']) {
    const data = dashboard([]);
    const calls = [];
    await attachNamespaceChecks(data, { enabled: true, now, client: {
      check: async name => { calls.push(name); return { status, checkedAt }; },
    } });
    assert.deepEqual(calls, ['dev']);
    assert.deepEqual(data.namespaces, []);
    assert.equal(data.namespaceChecks.status, status === 'unknown' ? 'unavailable' : 'available');
  }
});

test('a failed refresh replaces the previous exists result with unknown', async () => {
  const data = dashboard(['dev-fixture']);
  let failed = false;
  const client = { check: async () => {
    if (failed) throw new Error(privateValue);
    return { status: 'exists', checkedAt };
  } };
  await attachNamespaceChecks(data, { enabled: true, client, now });
  assert.equal(data.namespaces[0].runtime.status, 'exists');
  failed = true;
  await attachNamespaceChecks(data, { enabled: true, client, now });
  assertUnknown(data.namespaces[0].runtime);
  assert.equal(data.namespaceChecks.status, 'unavailable');
  assert.equal(JSON.stringify(data).includes(privateValue), false);
});
