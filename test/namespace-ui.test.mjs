import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sampleDashboard } from '../src/sample.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(' '); }
  get childElementCount() { return this.children.filter(child => child instanceof Element).length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
}

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .split("$('refresh').addEventListener('click'")[0];
const descendants = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(descendants)];
const linksIn = element => descendants(element).filter(child => child.tagName === 'a');
const checkedAt = '2035-03-15T09:00:00Z';
const access = () => ({
  runId: 102, observedAt: '2035-03-14T08:00:00Z',
  evidence: [{ label: 'Recorded namespace URLs', url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=102' }],
  links: [{ kind: 'b2c-base', label: 'B2C base', url: 'https://app.example.invalid/' }],
});

function renderer(data = sampleDashboard()) {
  const elements = new Map();
  const context = vm.createContext({ URL, Intl, Node: Element, document: {
    createElement: tag => new Element(tag),
    createTextNode: value => String(value),
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, new Element('div'));
      return elements.get(id);
    },
  } });
  vm.runInContext(source, context);
  context.dashboard = data;
  vm.runInContext('state.data = dashboard', context);
  const drawer = new Element('div');
  context.showDetail = () => { drawer.replaceChildren(); return drawer; };
  return { context, elements, drawer };
}

test('namespace table shows and counts only confirmed existing namespaces while preserving sorting and source history', () => {
  const data = sampleDashboard();
  const existing = (name, kind, finishedAt) => ({
    name, kind, branch: `refs/heads/${name}`,
    runtime: { status: 'exists', checkedAt, detail: 'Confirmed in the cluster.' },
    lastSuccess: { status: 'succeeded', runId: 105, version: `version-${name}`, finishedAt },
    latestAttempt: { status: 'succeeded', runId: 105 },
  });
  data.namespaces.push(
    existing('release-newer', 'release', '2035-03-15T08:00:00Z'),
    existing('release-older', 'release', '2035-03-14T08:00:00Z'),
    existing('branch-z', 'branch', '2035-03-15T09:00:00Z'),
    existing('branch-a', 'branch', '2035-03-15T09:00:00Z'),
    { name: 'without-runtime', lastSuccess: { runId: 106, status: 'succeeded', version: 'retained' } },
    { name: 'unexpected-status', runtime: { status: 'deleted', checkedAt } },
  );
  data.namespaces.forEach(namespace => { namespace.access = access(); });
  data.namespaces.reverse();
  const sourceHistory = JSON.stringify(data.namespaces);
  const { context, elements } = renderer(data);
  context.renderNamespaces();
  const table = elements.get('namespace-table').children[0];
  assert.match(table.children[0].textContent, /Type Last recorded version/);
  assert.match(table.children[0].textContent, /Last success Creator Latest attempt/);
  assert.doesNotMatch(table.children[0].textContent, /Cluster status|Run trigger/);
  const rows = table.children[1].children;
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map(row => row.children[0].children[0].textContent), ['dev', 'release-newer', 'release-older', 'branch-a', 'branch-z']);
  assert.ok(rows.every(row => row.children.length === 6));
  assert.ok(rows.every(row => /Succeeded/.test(row.children[5].textContent)), 'ADO latest attempts remain successful');
  assert.ok(rows.every(row => !/Not recorded/.test(row.children[2].textContent)), 'visible namespaces retain their deployment versions');
  assert.ok(rows.every(row => linksIn(row).length === 1));
  assert.doesNotMatch(table.textContent, /4-2-x|feature-cleanup|feature-unchecked|without-runtime|unexpected-status|Missing|Terminating|Unknown/);
  assert.equal(JSON.stringify(data.namespaces), sourceHistory, 'filtering must not delete or mutate the source deployment history');
  assert.match(elements.get('namespace-count').textContent, /^5\b/);
  assert.match(elements.get('namespace-check-status').textContent, /Some cluster checks were unavailable/);
});

test('namespace table shows the first creator separately from newer deployment requesters', () => {
  const data = sampleDashboard();
  const namespace = data.namespaces[0];
  namespace.creator = {
    status: 'recorded', name: 'Original creator', createdAt: checkedAt, runId: 90,
    url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=90',
    detail: 'The creation log matches the current namespace.', evidence: [],
  };
  namespace.lastSuccess.trigger = { reason: 'manual', requestedBy: 'Later deployer', requestedFor: 'Later beneficiary' };
  namespace.latestAttempt = { ...namespace.lastSuccess, runId: 120,
    trigger: { reason: 'manual', requestedBy: 'Latest deployer', requestedFor: 'Latest beneficiary' } };
  const { context, elements } = renderer(data);
  context.renderNamespaces();
  const table = elements.get('namespace-table').children[0];
  const creatorCell = table.children[1].children[0].children[4];
  assert.match(creatorCell.textContent, /Original creator Created 15 Mar/);
  assert.equal(linksIn(creatorCell).length, 0, 'creator display names are plain text');
  assert.doesNotMatch(table.textContent, /Later deployer|Later beneficiary|Latest deployer|Latest beneficiary/);
});

test('missing or unavailable creator data never falls back to deployment requester identities', () => {
  for (const creator of [undefined, { status: 'unavailable', name: 'Unverified person' }, { status: 'recorded', name: ' ' }, { status: 'unexpected', name: 'Unverified person' }]) {
    const data = sampleDashboard();
    data.namespaces[0].creator = creator;
    data.namespaces[0].lastSuccess.trigger = { reason: 'manual', requestedBy: 'Latest requester', requestedFor: 'Requested beneficiary' };
    const { context, elements } = renderer(data);
    context.renderNamespaces();
    const table = elements.get('namespace-table').children[0];
    const creatorCell = table.children[1].children[0].children[4];
    assert.equal(creatorCell.textContent, 'Not recorded');
    assert.doesNotMatch(table.textContent, /Latest requester|Requested beneficiary|Unverified person/);
  }
});

test('namespace creation drawer shows creator evidence and retains the last deployment trigger', () => {
  const namespace = sampleDashboard().namespaces[0];
  namespace.creator = {
    status: 'recorded', name: 'Original creator', createdAt: checkedAt, runId: 90,
    url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=90',
    detail: 'A successful creation message matches the current namespace creation time.',
    evidence: [{ label: 'Exact namespace creation log', url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=90&view=logs&l=7' }],
  };
  namespace.lastSuccess.trigger = { reason: 'manual', requestedBy: 'Later deployer', requestedFor: 'Different beneficiary' };
  const { context, drawer } = renderer();
  context.openNamespace(namespace);
  assert.match(drawer.textContent, /Namespace creation Creator Original creator Created.*15 Mar 2035.*Creation run #90/);
  assert.match(drawer.textContent, /A successful creation message matches the current namespace creation time/);
  assert.ok(linksIn(drawer).some(link => link.textContent.includes('Exact namespace creation log')));
  assert.ok(linksIn(drawer).some(link => link.textContent.includes('View namespace creation run in ADO')));
  assert.match(drawer.textContent, /Last successful deployment trigger Pipeline run #101 Run trigger Manual Run requested by Later deployer Run requested for Different beneficiary/);
});

test('unavailable creator details preserve a known creation date and render plain text safely', () => {
  const namespace = sampleDashboard().namespaces[0];
  namespace.creator = {
    status: 'unavailable', name: 'Unverified person', createdAt: checkedAt, runId: 90,
    url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=90',
    detail: 'The original creation log is outside the retained scan.', evidence: [],
  };
  const { context, drawer } = renderer();
  context.openNamespace(namespace);
  assert.match(drawer.textContent, /Namespace creation Creator Not recorded Created.*15 Mar 2035/);
  assert.match(drawer.textContent, /The original creation log is outside the retained scan/);
  assert.doesNotMatch(drawer.textContent, /Unverified person|Creation run #90/);
  assert.equal(linksIn(drawer).some(link => /buildId=90/.test(link.href)), false);
  namespace.creator = { ...namespace.creator, status: 'recorded', name: '<img src=x onerror=alert(1)>', detail: '<script>alert(1)</script>' };
  context.openNamespace(namespace);
  assert.ok(drawer.textContent.includes(namespace.creator.name));
  assert.ok(drawer.textContent.includes(namespace.creator.detail));
  assert.equal(descendants(drawer).some(child => ['img', 'script'].includes(child.tagName)), false);
});

test('refreshing an existing namespace to unknown removes its row and closes its stale drawer', () => {
  const data = sampleDashboard();
  const { context, elements } = renderer(data);
  context.renderNamespaces();
  assert.match(elements.get('namespace-count').textContent, /^1\b/);
  assert.equal(descendants(elements.get('namespace-table')).filter(element => element.tagName === 'tbody').length, 1);
  context.openNamespace(data.namespaces[0]);
  const dialog = new Element('dialog');
  dialog.open = true;
  let closeCount = 0;
  dialog.close = () => { closeCount += 1; dialog.open = false; };
  elements.set('detail-dialog', dialog);
  context.renderNamespaces();
  assert.equal(closeCount, 0, 'a namespace that still exists keeps its drawer open');
  data.namespaces[0].runtime = { status: 'unknown', checkedAt, detail: 'The cluster check timed out.' };
  data.namespaceChecks.status = 'unavailable';
  context.renderNamespaces();
  assert.equal(closeCount, 1, 'an unverified namespace must no longer remain visible in its drawer');
  assert.equal(dialog.open, false);
  assert.equal(vm.runInContext('state.namespaceDetail', context), null);
  assert.match(elements.get('namespace-count').textContent, /^0\b/);
  assert.equal(descendants(elements.get('namespace-table')).filter(element => element.tagName === 'tr').length, 0);
  assert.equal(descendants(elements.get('namespace-table')).filter(element => element.tagName === 'button').length, 0);
  assert.equal(data.namespaces.length, 4, 'source history is retained after the refresh');
  assert.equal(data.namespaces[0].lastSuccess.status, 'succeeded');
});

test('missing and terminating namespaces hide launch links in shortcuts and detail while retaining ADO evidence', () => {
  for (const status of ['missing', 'terminating']) {
    const namespace = {
      name: 'feature-example', kind: 'branch', access: access(),
      runtime: { status, checkedAt, detail: `Cluster says ${status}.` },
      lastSuccess: { runId: 102, status: 'succeeded', version: 'historical-version', finishedAt: checkedAt },
    };
    const { context, drawer } = renderer();
    assert.equal(linksIn(context.namespaceLaunchShortcuts(namespace)).length, 0);
    context.openNamespace(namespace);
    assert.equal(linksIn(drawer).filter(link => link.href.startsWith('https://app.example.invalid/')).length, 0);
    assert.match(drawer.textContent, /Application launch links are hidden because/);
    assert.match(drawer.textContent, /historical-version/);
    assert.match(drawer.textContent, /Inspect last successful deployment/);
    assert.ok(linksIn(drawer).some(link => link.textContent.includes('Recorded namespace URLs')));
    assert.match(drawer.textContent, /Cluster checked.*15 Mar 2035/);
    assert.match(drawer.textContent, new RegExp(`Cluster says ${status}\\.`));
    if (status === 'missing') assert.match(drawer.textContent, /does not establish whether or when it was deleted/);
  }
});

test('existing, unknown and unchecked namespaces keep valid application launch links', () => {
  for (const status of ['exists', 'unknown', undefined]) {
    const namespace = { name: 'feature-example', access: access(), runtime: status ? { status, checkedAt, detail: 'Example cluster detail.' } : undefined };
    const { context, drawer } = renderer();
    assert.equal(linksIn(context.namespaceLaunchShortcuts(namespace))[0].href, 'https://app.example.invalid/');
    context.openNamespace(namespace);
    assert.ok(linksIn(drawer).some(link => link.href === 'https://app.example.invalid/'));
    assert.doesNotMatch(drawer.textContent, /links are hidden/);
    assert.match(drawer.textContent, /application health and the running version are not checked/);
    if (status === undefined) {
      assert.match(drawer.textContent, /Cluster status Unknown Cluster checked Not checked/);
      assert.match(drawer.textContent, /Cluster presence has not been checked/);
    }
  }
});

test('cluster status details remain plain text and unexpected status values display as unknown', () => {
  const { context, drawer } = renderer();
  const namespace = { name: 'example', runtime: { status: 'deleted', checkedAt, detail: '<img src=x onerror=alert(1)>' } };
  context.openNamespace(namespace);
  assert.match(drawer.textContent, /Cluster status Unknown/);
  assert.ok(drawer.textContent.includes(namespace.runtime.detail));
  assert.equal(descendants(drawer).some(child => child.tagName === 'img'), false);
});

test('disabled and unavailable cluster checks show an honest empty state without listing unverified namespaces', () => {
  for (const [namespaceChecks, label] of [
    [{ enabled: false, checkedAt: null, status: 'unavailable' }, 'Cluster checks disabled.'],
    [{ enabled: true, checkedAt, status: 'unavailable' }, 'Cluster checks unavailable.'],
    [{ enabled: true, checkedAt, status: 'available' }, 'Cluster presence checked.'],
  ]) {
    const { context, elements } = renderer({ namespaces: [{ name: 'unchecked-dev' }], namespaceChecks });
    context.renderNamespaces();
    assert.ok(elements.get('namespace-check-status').textContent.startsWith(label));
    assert.match(elements.get('namespace-count').textContent, /^0\b/);
    assert.equal(descendants(elements.get('namespace-table')).filter(element => element.tagName === 'tr').length, 0);
    assert.match(elements.get('namespace-table').textContent, /No.*(?:confirmed|existing).*namespaces/i);
    assert.doesNotMatch(elements.get('namespace-table').textContent, /unchecked-dev|Missing|Deleted|Unknown Not checked/);
    assert.match(elements.get('namespace-table').textContent, /check|confirm/i);
  }
});

test('sample data explicitly demonstrates each namespace presence state', () => {
  const sample = sampleDashboard();
  assert.deepEqual(sample.namespaces.map(namespace => namespace.runtime.status), ['exists', 'missing', 'terminating', 'unknown']);
  assert.equal(sample.namespaceChecks.enabled, true);
  assert.equal(sample.namespaceChecks.status, 'partial');
  assert.ok(sample.namespaces.every(namespace => namespace.runtime.checkedAt));
  assert.equal(sample.namespaces[0].creator.status, 'recorded');
  assert.equal(sample.namespaces[0].creator.name, 'Example operator');
  assert.equal(sample.namespaces[0].creator.createdAt, sample.namespaces[0].runtime.createdAt);
  assert.ok(sample.namespaces[0].creator.evidence.length);
  assert.equal(sample.namespaces.at(-1).creator.status, 'unavailable');
});
