import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(directory, 'deploy/scripts/check-ingress.sh');

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'explorer-ingress-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const callsFile = join(temp, 'calls.jsonl');
  // Only curl is replaced: real jq must validate the response, and no request is sent.
  await writeFile(join(temp, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CURL_CALLS, JSON.stringify(args) + '\\n');
const output = args[args.indexOf('--output') + 1];
if (!args.includes('--output') || !output) process.exit(97);
fs.writeFileSync(output, process.env.TEST_HEALTH_BODY);
process.exit(Number(process.env.TEST_CURL_EXIT));
`, { mode: 0o755 });
  return async (overrides = {}, shell = null) => {
    await writeFile(callsFile, '');
    const env = {
      PATH: `${temp}:${process.env.PATH}`,
      INGRESS_HOST: 'explorer.example.invalid', DEPLOY_TEMP_DIR: temp,
      TEST_CURL_CALLS: callsFile, TEST_CURL_EXIT: '0',
      TEST_HEALTH_BODY: JSON.stringify({ status: 'ok', readOnly: true }),
      ...overrides,
    };
    let result;
    try {
      const args = shell ? ['-euo', 'pipefail', '-c', shell, 'ingress-test', script] : [script];
      result = { code: 0, ...(await execute('/bin/bash', args, { cwd: directory, env, timeout: 15000 })) };
    } catch (error) {
      result = { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    result.calls = (await readFile(callsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return result;
  };
}

test('ingress certificate verification stays enabled when the optional setting is absent or false', async t => {
  const run = await fixture(t);
  for (const setting of [undefined, '', 'false', '$(ingressSkipTlsVerify)']) {
    const result = await run(setting === undefined ? {} : { INGRESS_SKIP_TLS_VERIFY: setting });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].includes('--insecure'), false);
    assert.equal(result.stdout.includes('##vso['), false);
    assert.match(result.stdout, /passed with certificate verification enabled/);
  }
});

test('explicit true bypasses verification only on the unauthenticated health request and reports it', async t => {
  const run = await fixture(t);
  const result = await run({ INGRESS_SKIP_TLS_VERIFY: 'true' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls.length, 1);
  const call = result.calls[0];
  assert.ok(call.includes('--insecure'));
  assert.ok(call.includes('--fail'));
  assert.ok(call.includes('--retry-all-errors'));
  assert.equal(call[call.indexOf('--connect-timeout') + 1], '10');
  assert.equal(call[call.indexOf('--max-time') + 1], '15');
  assert.equal(call[call.indexOf('--retry') + 1], '6');
  assert.equal(call.at(-1), 'https://explorer.example.invalid/healthz');
  assert.equal(call.some(arg => ['-H', '--header', '-u', '--user', '-L', '--location'].includes(arg)), false);
  assert.match(result.stdout, /##vso\[task\.logissue type=warning\]/);
  assert.match(result.stdout, /passed with certificate verification disabled/);
});

test('invalid TLS options fail during preflight before the health request', async t => {
  const run = await fixture(t);
  for (const setting of ['TRUE', 'yes', '1', 'true ', '$(wrongVariable)']) {
    const result = await run({ INGRESS_SKIP_TLS_VERIFY: setting });
    assert.notEqual(result.code, 0, setting);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr, /must be true or false/);
  }
});

test('the sourceable helper does no I/O until called and can reset the exception', async t => {
  const run = await fixture(t);
  const sourced = await run({}, 'source "$1"');
  assert.equal(sourced.code, 0, sourced.stderr);
  assert.deepEqual(sourced.calls, []);
  assert.equal(sourced.stdout, '');
  const result = await run({ INGRESS_SKIP_TLS_VERIFY: 'true' },
    'source "$1"; configure_ingress_check; INGRESS_SKIP_TLS_VERIFY=false; configure_ingress_check; check_ingress');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.calls[0].includes('--insecure'), false);
  assert.equal(result.stdout.includes('##vso['), false);
});

test('HTTP, DNS and connection failures still fail when certificate checks are skipped', async t => {
  const run = await fixture(t);
  for (const code of [22, 6, 7, 28]) {
    const result = await run({ INGRESS_SKIP_TLS_VERIFY: 'true', TEST_CURL_EXIT: String(code) });
    assert.equal(result.code, code);
    assert.equal(result.stdout.includes('health check passed'), false);
  }
});

test('empty, malformed or unhealthy successful responses fail the health check', async t => {
  const run = await fixture(t);
  for (const body of ['', 'not-json', '{}', '{"status":"ok","readOnly":false}', '{"status":"error","readOnly":true}']) {
    const result = await run({ INGRESS_SKIP_TLS_VERIFY: 'true', TEST_HEALTH_BODY: body });
    assert.notEqual(result.code, 0, body);
    assert.match(result.stderr, /did not reach the release explorer/);
    assert.equal(result.stdout.includes('health check passed'), false);
  }
});
