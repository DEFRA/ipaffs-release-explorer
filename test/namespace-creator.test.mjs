import test from 'node:test';
import assert from 'node:assert/strict';
import { attachNamespaceCreators } from '../src/namespace-creator.mjs';

const name = 'feature-example';
const createdAt = '2035-03-15T10:15:22Z';
const uid = '11000000-0000-4000-8000-000000000001';
const run = (id = 101, overrides = {}) => ({ id, url: `https://dev.azure.com/example/SAMPLE/_build/results?buildId=${id}`,
  trigger: { reason: 'manual', requestedBy: 'Original creator', requestedFor: 'Another person' }, ...overrides });
const namespace = (overrides = {}) => ({ name, runtime: { status: 'exists', uid, createdAt }, ...overrides });
const detail = ({ task = {}, job = {}, stage = {}, lines, log = {}, records = [] } = {}) => ({ timeline: { records: [
  { id: 'stage', type: 'Stage', attempt: 1, ...stage },
  { id: 'job', type: 'Job', parentId: 'stage', attempt: 1, ...job },
  { id: 'task', type: 'Task', parentId: 'job', name: 'Resolve namespace', attempt: 1,
    state: 'completed', result: 'succeeded', startTime: '2035-03-15T10:14:58.740Z', finishTime: '2035-03-15T10:15:24.2633333Z', log: { id: 27 }, ...task },
  ...records,
] }, logs: [{ id: 27, recordId: 'task', text: lines ?? `2035-03-15T10:15:22.1010742Z namespace/${name} created\n`, ...log }] });

function attach({ runs = [run()], namespaces = [namespace()], entries = [[101, detail()]], devRunIds = new Set([101]), details } = {}) {
  const dashboard = { namespaces, runs };
  attachNamespaceCreators(dashboard, { details: details ?? new Map(entries), devRunIds });
  return dashboard;
}

function unavailable(data) {
  const creator = data.namespaces[0].creator;
  assert.equal(creator.status, 'unavailable');
  assert.equal(creator.name, null);
  assert.equal(creator.runId, null);
  assert.equal(creator.url, null);
  assert.deepEqual(creator.evidence, []);
}

test('an exact timestamped creation response links the current namespace to its manual run requester', () => {
  const data = attach();
  const creator = data.namespaces[0].creator;
  assert.equal(creator.status, 'recorded');
  assert.equal(creator.name, 'Original creator');
  assert.equal(creator.createdAt, createdAt);
  assert.equal(creator.runId, 101);
  assert.equal(creator.url, run().url);
  assert.equal(creator.evidence[0].url, `${run().url}&view=logs&l=27`);
  assert.equal(creator.evidence[0].type, 'log');
  assert.match(creator.detail, /requester of the manual pipeline run/);
  assert.doesNotMatch(JSON.stringify(creator), /Another person/);
});

test('the older Create namespace task and plain-object details are supported', () => {
  const data = attach({ details: { 101: detail({ task: { name: 'Create namespace' } }) } });
  assert.equal(data.namespaces[0].creator.name, 'Original creator');
});

test('creation survives a subsequent failed task or failed whole run', () => {
  const data = attach({ runs: [run(101, { result: 'failed', status: 'completed' })],
    entries: [[101, detail({ task: { result: 'failed' }, records: [{ id: 'later', type: 'Task', result: 'failed' }] })]] });
  assert.equal(data.namespaces[0].creator.status, 'recorded');
});

test('earliest or latest deployments and owner metadata never substitute for creation output', () => {
  const data = attach({ namespaces: [namespace({ owner: 'Owner label', lastSuccess: { trigger: { requestedBy: 'Latest deployer' } } })],
    entries: [[101, detail({ lines: `2035-03-15T10:15:22.101Z Using namespace: ${name}\n` })]] });
  unavailable(data);
  assert.doesNotMatch(JSON.stringify(data.namespaces[0].creator), /Owner label|Latest deployer/);
});

test('a newer deployment cannot replace the creating run and input order is irrelevant', () => {
  for (const reverse of [false, true]) {
    const runs = [run(), run(102, { trigger: { reason: 'manual', requestedBy: 'Latest deployer' } })];
    const entries = [[101, detail()], [102, detail({ lines: `2035-03-15T11:15:22.101Z Using namespace: ${name}\n` })]];
    const data = attach({ runs: reverse ? runs.reverse() : runs, entries: reverse ? entries.reverse() : entries, devRunIds: new Set([101, 102]) });
    assert.equal(data.namespaces[0].creator.runId, 101);
    assert.equal(data.namespaces[0].creator.name, 'Original creator');
  }
});

test('a creation record for an older namespace incarnation is not attributed to its replacement', () => {
  const data = attach({ namespaces: [namespace({ runtime: { status: 'exists', uid: '22000000-0000-4000-8000-000000000002', createdAt: '2035-03-16T10:15:22Z' } })] });
  unavailable(data);
  assert.equal(data.namespaces[0].creator.createdAt, '2035-03-16T10:15:22Z');
});

test('false markers, echoed commands, dry-run output and another namespace do not establish creation', () => {
  for (const line of [
    `namespace/${name} created`,
    `2035-03-15T10:15:22.101Z echo namespace/${name} created`,
    `2035-03-15T10:15:22.101Z ##[command]echo namespace/${name} created`,
    `2035-03-15T10:15:22.101Z namespace/${name} created (dry run)`,
    `2035-03-15T10:15:22.101Z namespace/${name} configured`,
    `2035-03-15T10:15:22.101Z Error from server (AlreadyExists): namespaces "${name}" already exists`,
    '2035-03-15T10:15:22.101Z namespace/another-namespace created',
    `2035-03-15T10:15:22.101Z prefix namespace/${name} created`,
  ]) unavailable(attach({ entries: [[101, detail({ lines: `${line}\n` })]] }));
});

test('timestamps must be valid and within the creating task bounds and five seconds of creation', () => {
  for (const lines of [
    `2035-03-15T10:15:21.999Z namespace/${name} created`,
    `2035-03-15T10:15:27.001Z namespace/${name} created`,
    `2035-02-31T10:15:22Z namespace/${name} created`,
    `2035-03-15T10:14:59Z namespace/${name} created`,
  ]) unavailable(attach({ entries: [[101, detail({ lines })]] }));
  for (const task of [
    { startTime: undefined }, { finishTime: null },
    { startTime: '2035-03-15T10:15:23Z' }, { finishTime: '2035-03-15T10:15:22Z' },
    { startTime: '2035-03-15T10:15:24Z', finishTime: '2035-03-15T10:15:23Z' },
  ]) unavailable(attach({ entries: [[101, detail({ task })]] }));
});

test('second-precision cluster creation timestamps permit rounding at the task start', () => {
  const data = attach({ entries: [[101, detail({ task: { startTime: '2035-03-15T10:15:22.050Z' } })]] });
  assert.equal(data.namespaces[0].creator.status, 'recorded');
});

test('the five-second creation window is inclusive and still bounded by the task', () => {
  const options = { task: { finishTime: '2035-03-15T10:15:30Z' } };
  const atLimit = attach({ entries: [[101, detail({ ...options, lines: `2035-03-15T10:15:27Z namespace/${name} created` })]] });
  assert.equal(atLimit.namespaces[0].creator.status, 'recorded');
  unavailable(attach({ entries: [[101, detail({ ...options, lines: `2035-03-15T10:15:27.001Z namespace/${name} created` })]] }));
});

test('a phase in the normal ADO ancestry preserves the first-attempt check', () => {
  const data = attach({ entries: [[101, detail({ job: { parentId: 'phase' }, records: [{ id: 'phase', type: 'Phase', parentId: 'stage' }] })]] });
  assert.equal(data.namespaces[0].creator.status, 'recorded');
});

test('a missing or retried task, Job or Stage cannot invent the retry initiator', () => {
  for (const overrides of [
    { task: { attempt: 2 } }, { job: { attempt: 2 } }, { stage: { attempt: 2 } },
    { task: { attempt: undefined } }, { job: { attempt: undefined } }, { stage: { attempt: undefined } },
    { task: { parentId: 'missing' } }, { job: { parentId: 'task' } }, { task: { parentId: 'stage' } },
  ]) unavailable(attach({ entries: [[101, detail(overrides)]] }));
});

test('nonmanual runs and missing requesters never fall back to requestedFor or other identities', () => {
  for (const trigger of [
    { reason: 'individualCI', requestedBy: 'Build service', requestedFor: 'Commit author' },
    { reason: 'manual', requestedFor: 'Beneficiary' },
    { reason: 'manual', requestedBy: '  ', requestedFor: 'Beneficiary' },
    { reason: 'manual', requestedBy: 123, requestedFor: 'Beneficiary' },
    { requestedBy: 'Someone' },
  ]) unavailable(attach({ runs: [run(101, { trigger, lastChangedBy: 'Editor', author: 'Author' })] }));
});

test('missing or invalid namespace lifecycle metadata and unconfirmed namespaces remain unavailable', () => {
  for (const runtime of [
    undefined, {}, { status: 'exists', createdAt }, { status: 'exists', uid },
    { status: 'exists', uid: 'invalid-uid', createdAt }, { status: 'exists', uid, createdAt: 'yesterday' },
    ...['missing', 'terminating', 'unknown'].map(status => ({ status, uid, createdAt })),
  ]) unavailable(attach({ namespaces: [namespace({ runtime })] }));
  for (const invalidName of ['', 'Feature', '../feature', 'a'.repeat(64), 'feature-']) {
    unavailable(attach({ namespaces: [namespace({ name: invalidName })] }));
  }
});

test('only configured DEV runs and matching actual task log IDs or record IDs are evidence', () => {
  unavailable(attach({ devRunIds: new Set() }));
  for (const options of [
    { task: { name: 'Deploy Helm Charts' } }, { task: { type: 'Job' } }, { task: { result: 'skipped' } },
    { task: { state: 'inProgress' } }, { log: { recordId: 'another-task' } }, { log: { id: 99 } },
    { log: { id: undefined, recordId: undefined } },
    { records: [{ id: 'duplicate', type: 'Task', log: { id: 27 }, name: 'Resolve namespace' }], log: { recordId: undefined } },
  ]) unavailable(attach({ entries: [[101, detail(options)]] }));
  assert.equal(attach({ entries: [[101, detail({ log: { recordId: undefined } })]] }).namespaces[0].creator.status, 'recorded');
  assert.equal(attach({ entries: [[101, detail({ log: { id: undefined } })]] }).namespaces[0].creator.status, 'recorded');
});

test('conflicting matching create records or actors are unavailable even if one is manual', () => {
  for (const trigger of [
    { reason: 'manual', requestedBy: 'Second creator' },
    { reason: 'individualCI', requestedBy: 'Build service' },
  ]) {
    const data = attach({ runs: [run(), run(102, { trigger })], entries: [[101, detail()], [102, detail()]], devRunIds: new Set([101, 102]) });
    unavailable(data);
  }
  unavailable(attach({ entries: [[101, detail({ lines: `2035-03-15T10:15:22.101Z namespace/${name} created\n2035-03-15T10:15:23.101Z namespace/${name} created\n` })]] }));
});

test('duplicate identical log delivery does not create a false ambiguity', () => {
  const duplicated = detail();
  duplicated.logs.push({ ...duplicated.logs[0] });
  const data = attach({ entries: [[101, duplicated]] });
  assert.equal(data.namespaces[0].creator.status, 'recorded');
});

test('refresh clears an earlier creator when current lifecycle evidence disappears', () => {
  const data = attach();
  data.namespaces[0].runtime = { status: 'unknown' };
  attachNamespaceCreators(data, { details: new Map([[101, detail()]]), devRunIds: new Set([101]) });
  unavailable(data);
  assert.equal(data.namespaces[0].creator.createdAt, null);
});
