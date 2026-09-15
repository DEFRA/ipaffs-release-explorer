import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
const environment = {
  ADO_ORGANIZATION: 'https://dev.azure.com/example-org', ADO_PROJECT: 'example-project',
  ADO_DEV_PIPELINE_ID: '101', ADO_CREATE_RELEASE_PIPELINE_ID: '102',
  ADO_RELEASE_PIPELINE_ID: '103', ADO_QA_PIPELINE_ID: '104',
};

test('Host allowlist defaults to the local port and accepts explicit cluster addresses', () => {
  assert.deepEqual(loadConfig({ ...environment, PORT: '4400' }).allowedHosts, ['localhost:4400', '127.0.0.1:4400']);
  assert.deepEqual(loadConfig({ ...environment, ALLOWED_HOSTS: 'localhost:4317, Explorer.tools.svc:4317,explorer.internal' }).allowedHosts,
    ['localhost:4317', 'explorer.tools.svc:4317', 'explorer.internal']);
});

test('Host allowlist rejects URLs, wildcards and ambiguous authorities', () => {
  for (const ALLOWED_HOSTS of ['*', '*.internal', 'http://explorer', 'user@explorer', 'explorer/path', 'explorer?x', 'explorer#x', 'explorer:0', 'explorer:65536', 'explorer,,localhost', 'explorer..internal', '-explorer', 'explorer_', 'explorer\\internal']) {
    assert.throws(() => loadConfig({ ...environment, ALLOWED_HOSTS }), /ALLOWED_HOSTS/);
  }
});

test('ADO destination and pipeline identifiers must be explicitly configured', () => {
  for (const key of Object.keys(environment)) {
    const missing = { ...environment };
    delete missing[key];
    assert.throws(() => loadConfig(missing), new RegExp(key));
  }
});
