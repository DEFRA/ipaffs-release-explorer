import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
  querySelectorAll(selector) {
    assert.equal(selector, '.release-expander[open]');
    return matching(this, 'release-expander').filter(element => element.open);
  }
  showModal() { this.open = true; }
}

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .split("$('refresh').addEventListener('click'")[0];
const descendants = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(descendants)];
const matching = (element, className) => descendants(element).filter(child => child.className?.split(' ').includes(className));
const timestamps = element => descendants(element).filter(child => child.tagName === 'time');
const links = element => descendants(element).filter(child => child.tagName === 'a');
const formatted = value => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
}).format(new Date(value));
const queuedAt = '2035-03-15T08:00:00Z';
const startedAt = '2035-03-15T08:01:00Z';
const finishedAt = '2035-03-15T08:30:00Z';
const qaRun = ({ id = 601, ...overrides } = {}) => ({
  id, environment: 'TST', scope: 'environment', status: 'completed', result: 'succeeded',
  queuedAt, startedAt, finishedAt,
  url: `https://dev.azure.com/example/SAMPLE/_build/results?buildId=${id}`,
  resultsUrl: `https://dev.azure.com/example/SAMPLE/_build/results?buildId=${id}&view=ms.vss-test-web.build-test-results-tab`,
  summary: { availability: 'available', passed: 90, failed: 0, skipped: 10, other: 0, executed: 90, passPercentage: 100 },
  ...overrides,
});
const deployment = () => ({
  environment: 'TST', version: '4.2.0', runId: 501, attempt: 1, status: 'succeeded', finishedAt: '2035-03-14T07:00:00Z',
  qa: { state: 'linked', latest: qaRun({ id: 600, scope: undefined, finishedAt: '2035-03-14T08:30:00Z',
    summary: { availability: 'available', passed: 80, failed: 10, skipped: 10, other: 0, executed: 90, passPercentage: 88.9 } }), runs: [] },
});
const environment = (overrides = {}) => ({
  name: 'TST', namespace: 'tst', lastSuccess: deployment(), latestAttempt: null,
  qa: { state: 'recorded', latest: qaRun(), runs: [] }, ...overrides,
});

function renderer(environments = [], releaseData = {}) {
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
  context.data = { environments, ...releaseData };
  vm.runInContext('state.data = data', context);
  return { context, elements };
}

test('environment card shows its latest QA run with finish date, time, timezone and result link', () => {
  const { context, elements } = renderer([environment()]);
  context.renderEnvironments();
  const section = matching(elements.get('environment-grid'), 'qa-summary')[0];
  assert.match(section.textContent, /Latest tests.*100% passed.*90 passed · 0 failed · 10 skipped/);
  assert.match(section.textContent, /Finished/);
  assert.ok(section.textContent.includes(formatted(finishedAt)), 'full date includes the year, time and timezone');
  assert.match(section.textContent, /Latest run against TST/);
  assert.doesNotMatch(section.textContent, /88\.9|4\.2\.0/);
  assert.equal(timestamps(section)[0].attributes.datetime, finishedAt);
  assert.equal(links(section)[0].href, qaRun().resultsUrl);
  assert.match(links(section)[0].attributes['aria-label'], /for TST, QA run 601/);
  assert.doesNotMatch(section.attributes['aria-label'], /4\.2\.0/);
});

test('an environment without deployment history still shows its latest environment tests', () => {
  const { context, elements } = renderer([environment({ lastSuccess: null })]);
  context.renderEnvironments();
  const card = elements.get('environment-grid').children[0];
  assert.match(card.textContent, /No deployment found/);
  const section = matching(card, 'qa-summary')[0];
  assert.match(section.textContent, /100% passed/);
  assert.equal(timestamps(section)[0].attributes.datetime, finishedAt);
});

test('empty or unavailable environment tests never fall back to stale deployment tests', () => {
  for (const state of ['not-recorded', 'unavailable']) {
    const { context, elements } = renderer([environment({ qa: { state, latest: null, runs: [] } })]);
    context.renderEnvironments();
    const section = matching(elements.get('environment-grid'), 'qa-summary')[0];
    assert.match(section.textContent, state === 'unavailable' ? /Tests unavailable.*could not be loaded/ : /No tests recorded.*scanned history/);
    assert.doesNotMatch(section.textContent, /88\.9|No linked tests|View test/);
    assert.equal(links(section).length, 0);
    assert.equal(timestamps(section).length, 0);
  }
});

test('Releases shows the same latest DEV and TST runs as Overview, separate from release-linked QA', () => {
  const record = deployment();
  const progress = { environment: 'TST', status: 'deployed', lastSuccess: record };
  const candidate = { version: record.version, progress: [progress] };
  const previous = { ...candidate, version: '4.1.0', history: true, progress: [{ ...progress, lastSuccess: { ...record, version: '4.1.0' } }] };
  const devRun = qaRun({ id: 602, environment: 'DEV', status: 'notStarted', result: null, startedAt: null, finishedAt: null, summary: null });
  const dev = environment({ name: 'DEV', namespace: 'dev', lastSuccess: null, qa: { state: 'recorded', latest: devRun } });
  const pre = environment({ name: 'PRE', namespace: 'pre', qa: { state: 'not-recorded', latest: null } });
  const { context, elements } = renderer([environment(), pre, dev], { releases: [candidate], previousReleases: [previous] });

  context.renderReleases();
  context.renderEnvironments();

  const summaries = matching(elements.get('release-environment-tests'), 'qa-summary');
  assert.deepEqual(summaries.map(summary => summary.attributes['aria-label']), ['Latest test results for DEV', 'Latest test results for TST']);
  const [devSummary, tstSummary] = summaries;
  assert.match(devSummary.textContent, /DEV latest tests.*Tests queued.*Queued/);
  assert.equal(timestamps(devSummary)[0].attributes.datetime, queuedAt);
  assert.equal(links(devSummary)[0].href, devRun.url);
  const overviewTst = matching(elements.get('environment-grid'), 'qa-summary')[0];
  assert.match(tstSummary.textContent, /TST latest tests.*100% passed.*90 passed · 0 failed · 10 skipped/);
  assert.equal(timestamps(tstSummary)[0].attributes.datetime, timestamps(overviewTst)[0].attributes.datetime);
  assert.equal(links(tstSummary)[0].href, links(overviewTst)[0].href);
  assert.doesNotMatch(tstSummary.textContent, /88\.9|4\.2\.0/);

  for (const id of ['release-list', 'previous-release-list']) {
    const list = elements.get(id);
    assert.ok(matching(list, 'release-patch').length);
    assert.doesNotMatch(list.textContent, /100%|88\.9%|Latest tests|Linked tests/);
  }

  context.openReleaseProgress(candidate, progress);
  const detail = matching(elements.get('detail-content'), 'qa-summary')[0];
  assert.match(detail.textContent, /Linked tests.*88\.9% passed/);
  assert.doesNotMatch(detail.textContent, /Latest tests|100%/);
  assert.equal(timestamps(detail)[0].attributes.datetime, record.qa.latest.finishedAt);
  assert.equal(links(detail)[0].href, record.qa.latest.resultsUrl);
});

test('empty or unavailable latest tests in Releases do not fall back to linked QA', () => {
  const dev = environment({ name: 'DEV', namespace: 'dev', lastSuccess: null, qa: { state: 'not-recorded', latest: null } });
  const tst = environment({ qa: { state: 'unavailable', latest: null } });
  const { context, elements } = renderer([dev, tst]);
  context.renderReleases();

  const container = elements.get('release-environment-tests');
  const [devSummary, tstSummary] = matching(container, 'qa-summary');
  assert.match(devSummary.textContent, /No tests recorded.*scanned history/);
  assert.match(tstSummary.textContent, /Tests unavailable.*could not be loaded/);
  assert.doesNotMatch(container.textContent, /88\.9|No linked tests/);
  assert.equal(links(container).length, 0);
  assert.equal(timestamps(container).length, 0);
});

test('running and queued runs show their own labelled start or queue time', () => {
  for (const [status, start, label, timestamp] of [
    ['inProgress', startedAt, 'Started', startedAt],
    ['notStarted', null, 'Queued', queuedAt],
    ['inProgress', null, 'Queued', queuedAt],
  ]) {
    const { context } = renderer();
    const run = qaRun({ status, result: null, startedAt: start, summary: null });
    const section = context.qaSummary({ environment: 'TST', qa: { latest: run } }, { compact: true, scope: 'environment' });
    assert.match(section.textContent, status === 'notStarted' ? /Tests queued/ : /Tests running/);
    assert.ok(section.textContent.includes(label));
    assert.ok(section.textContent.includes(formatted(timestamp)));
    assert.equal(timestamps(section)[0].attributes.datetime, timestamp);
    assert.doesNotMatch(section.textContent, /Finished|100%/);
  }
});

test('completed runs without a finish date label fallback dates honestly', () => {
  for (const [start, label, timestamp] of [[startedAt, 'Started', startedAt], [null, 'Queued', queuedAt]]) {
    const { context } = renderer();
    const section = context.qaSummary({ environment: 'TST', qa: { latest: qaRun({ finishedAt: null, startedAt: start }) } }, { compact: true, scope: 'environment' });
    assert.ok(section.textContent.includes(label));
    assert.doesNotMatch(section.textContent, /Finished/);
    assert.equal(timestamps(section)[0].attributes.datetime, timestamp);
  }
});

test('missing or invalid run timestamps remain explicit without using the deployment date', () => {
  for (const value of [null, 'not-a-timestamp']) {
    const { context } = renderer();
    const record = deployment();
    record.qa.latest = qaRun({ queuedAt: value, startedAt: value, finishedAt: value });
    const section = context.qaSummary(record, { compact: true });
    assert.match(section.textContent, /Test time not recorded/);
    assert.doesNotMatch(section.textContent, /14 Mar|Invalid Date/);
    assert.equal(timestamps(section).length, 0);
  }
});

test('deployment details retain their linked run, version, timestamp and denominator', () => {
  const { context } = renderer();
  const record = deployment();
  const section = context.deploymentQaDetails(record);
  assert.match(section.textContent, /Tests linked to this deployment.*88\.9% passed/);
  assert.match(section.textContent, /QA run #600/);
  assert.match(section.textContent, /80 passed out of 90 executed tests/);
  assert.equal(timestamps(section)[0].attributes.datetime, record.qa.latest.finishedAt);
  assert.match(links(section)[0].attributes['aria-label'], /TST 4\.2\.0, QA run 600/);
  assert.doesNotMatch(section.textContent, /Latest tests|Latest run against|100%/);
});
