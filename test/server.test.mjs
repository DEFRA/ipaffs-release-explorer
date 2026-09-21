import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get, request } from 'node:http';
import { createAppServer } from '../src/server.mjs';
import { AdoError } from '../src/ado-client.mjs';

// Use raw HTTP requests because fetch supplies its own Sec-Fetch-Mode value.
const sendRequest = (url, options) => new Promise((resolve, reject) => {
  const req = request(url, options, response => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    response.on('error', reject);
  });
  req.on('error', reject);
  req.end();
});

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

test('external document links load the static dashboard before same-origin assets and live data', async t => {
  let reads = 0;
  const privateData = { mode: 'live', release: 'private-deployment-evidence' };
  const config = { port: 4317, allowedHosts: ['explorer.dev.example.invalid'] };
  const server = createAppServer(config, { async get() { reads++; return privateData; } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const navigationHeaders = {
    Host: 'explorer.dev.example.invalid',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };

  for (const path of ['/', '/?from=external-link']) {
    const page = await sendRequest(`${base}${path}`, { headers: navigationHeaders });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.body, /<title>IPAFFS Release Explorer<\/title>/);
    assert.doesNotMatch(page.body, /private-deployment-evidence/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(reads, 0, 'opening the static shell must not read deployment data');
  }

  for (const [path, mode, destination] of [['/app.js', 'no-cors', 'script'], ['/styles.css', 'no-cors', 'style']]) {
    const asset = await sendRequest(`${base}${path}`, { headers: {
      Host: navigationHeaders.Host,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': mode,
      'Sec-Fetch-Dest': destination,
    } });
    assert.equal(asset.status, 200);
  }
  assert.equal(reads, 0);
  const dashboard = await sendRequest(`${base}/api/dashboard`, { headers: {
    Host: navigationHeaders.Host,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  } });
  assert.equal(dashboard.status, 200);
  assert.deepEqual(JSON.parse(dashboard.body), privateData);
  assert.equal(reads, 1);
});

test('external navigation does not allow cross-site APIs, embedded requests, writes or unconfigured hosts', async t => {
  let reads = 0;
  const service = {
    async get() { reads++; return { mode: 'live' }; },
    run() { reads++; return { run: { id: 123 } }; },
  };
  const config = { port: 4317, allowedHosts: ['explorer.dev.example.invalid'] };
  const server = createAppServer(config, service);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    Host: 'explorer.dev.example.invalid',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Dest': 'document',
  };

  for (const path of ['/api/dashboard', '/api/dashboard?mode=sample', '/api/runs/123', '/app.js', '/styles.css', '/healthz']) {
    const response = await sendRequest(`${base}${path}`, { headers });
    assert.equal(response.status, 403, path);
    assert.equal(JSON.parse(response.body).error.code, 'local_only');
  }
  for (const [mode, destination] of [
    ['navigate', 'iframe'], ['navigate', 'frame'], ['no-cors', 'image'],
    ['cors', 'empty'], ['cors', 'document'], ['navigate', 'empty'],
    ['navigate', ''], ['', 'document'], ['', ''],
  ]) {
    const requestHeaders = { ...headers };
    if (mode) requestHeaders['Sec-Fetch-Mode'] = mode;
    else delete requestHeaders['Sec-Fetch-Mode'];
    if (destination) requestHeaders['Sec-Fetch-Dest'] = destination;
    else delete requestHeaders['Sec-Fetch-Dest'];
    const response = await sendRequest(`${base}/`, { headers: requestHeaders });
    assert.equal(response.status, 403, `${mode || 'missing mode'} / ${destination || 'missing destination'}`);
    assert.equal(JSON.parse(response.body).error.code, 'local_only');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await sendRequest(`${base}/`, { method, headers });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET');
    assert.equal(JSON.parse(response.body).error.code, 'read_only');
  }
  const wrongHost = await sendRequest(`${base}/`, { headers: {
    ...headers,
    Host: 'other.example.invalid',
    'X-Forwarded-Host': headers.Host,
  } });
  assert.equal(wrongHost.status, 403);
  assert.equal(JSON.parse(wrongHost.body).error.code, 'host_not_allowed');
  assert.equal(reads, 0, 'blocked requests must not read deployment data');
});
