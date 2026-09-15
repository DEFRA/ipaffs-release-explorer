import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createAppServer } from '../src/server.mjs';
import { AdoError } from '../src/ado-client.mjs';

test('local server rejects write methods and cross-site reads; live errors never silently become samples', async t => {
  let reads = 0;
  const service = {
    async get() { reads += 1; throw new AdoError('sign_in_required', 'Sign in required', 503); },
    run() { return null; },
  };
  const config = { port: 0 };
  const server = createAppServer(config, service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  config.port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${config.port}`;
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await fetch(`${base}/api/dashboard`, { method });
    assert.equal(response.status, 405);
    assert.equal((await response.json()).error.code, 'read_only');
  }
  assert.equal(reads, 0);
  const crossSite = await fetch(`${base}/api/dashboard`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  // fetch normalizes Host; use the HTTP client to exercise a forged header.
  const reboundStatus = await new Promise((resolve, reject) => {
    get(`${base}/api/dashboard`, { headers: { Host: `example.invalid:${config.port}` } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  const live = await fetch(`${base}/api/dashboard`);
  assert.equal(live.status, 503);
  assert.equal((await live.json()).mode, 'live');
  const sample = await fetch(`${base}/api/dashboard?mode=sample`);
  assert.equal(sample.status, 200);
  assert.equal((await sample.json()).mode, 'sample');
  assert.equal(reads, 1);
  const health = await fetch(`${base}/healthz`);
  assert.deepEqual(await health.json(), { status: 'ok', readOnly: true });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.ok(health.headers.get('content-security-policy').includes("connect-src 'self'"));
});

test('cluster server allows configured hosts and probe headers without trusting forwarded hosts', async t => {
  let reads = 0;
  const config = { port: 4317, allowedHosts: ['127.0.0.1:4317', 'explorer.tools.svc:4317'] };
  const server = createAppServer(config, { async get() { reads++; return { mode: 'live' }; } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const status = (path, headers) => new Promise((resolve, reject) => {
    get(`http://127.0.0.1:${server.address().port}${path}`, { headers }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(await status('/healthz', { Host: '127.0.0.1:4317' }), 200);
  assert.equal(reads, 0);
  assert.equal(await status('/api/dashboard', { Host: 'EXPLORER.tools.svc:4317' }), 200);
  assert.equal(await status('/api/dashboard', { Host: 'other.tools.svc:4317', 'X-Forwarded-Host': 'explorer.tools.svc:4317' }), 403);
  assert.equal(await status('/api/dashboard', { Host: 'explorer.tools.svc:80' }), 403);
  assert.equal(reads, 1);
});
