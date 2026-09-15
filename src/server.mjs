import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { AdoClient, AdoError } from './ado-client.mjs';
import { createDashboardService } from './dashboard.mjs';
import { sampleDashboard } from './sample.mjs';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

export function createAppServer(config, service) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader('Cache-Control', 'no-store');
    const json = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    const host = (request.headers.host || '').toLowerCase();
    const allowedHosts = config.allowedHosts || [`localhost:${config.port}`, `127.0.0.1:${config.port}`];
    if (!allowedHosts.includes(host)) return json(403, { error: { code: 'host_not_allowed', message: 'Open this application through its configured address.' } });
    if (request.headers['sec-fetch-site'] === 'cross-site') return json(403, { error: { code: 'local_only', message: 'Cross-site requests are not supported.' } });
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return json(405, { error: { code: 'read_only', message: 'This application accepts read-only GET requests only.' } });
    }
    try {
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname === '/healthz') return json(200, { status: 'ok', readOnly: true });
      if (url.pathname === '/api/dashboard') {
        if (url.searchParams.get('mode') === 'sample') return json(200, sampleDashboard());
        return json(200, await service.get({ refresh: url.searchParams.get('refresh') === '1' }));
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
      if (runMatch) {
        if (url.searchParams.get('mode') === 'sample') {
          const run = sampleDashboard().runs.find(run => run.id === Number(runMatch[1]));
          return run ? json(200, { run, stages: [], evidence: [], note: 'Illustrative sample run; no live ADO history was read.' }) : json(404, { error: { code: 'sample_run_missing', message: 'No additional details exist for this sample item.' } });
        }
        const detail = service.run(Number(runMatch[1]));
        return detail ? json(200, detail) : json(404, { error: { code: 'not_in_scan', message: 'This run is outside the current history scan.' } });
      }
      if (files.has(url.pathname)) {
        const [filename, contentType] = files.get(url.pathname);
        const body = await readFile(resolve(publicDirectory, filename));
        response.writeHead(200, { 'Content-Type': contentType });
        return response.end(body);
      }
      return json(404, { error: { code: 'not_found', message: 'Page not found.' } });
    } catch (error) {
      const safe = error instanceof AdoError ? error : new AdoError('request_failed', 'The history request could not be completed. Try refreshing.');
      return json(safe.status, { error: { code: safe.code, message: safe.message }, mode: 'live' });
    }
  });
  server.requestTimeout = 180000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const client = new AdoClient(config);
  const service = createDashboardService(config, client);
  const server = createAppServer(config, service);
  server.listen(config.port, config.host, () => {
    console.log(`IPAFFS Release Explorer: http://127.0.0.1:${config.port}`);
    console.log('Read-only ADO history. Authentication stays on this server.');
  });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to another local port.` : 'Could not start the local server.');
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 25000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
