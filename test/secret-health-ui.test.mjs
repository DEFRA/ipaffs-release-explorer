import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sampleDashboard } from '../src/sample.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
}

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .split("$('refresh').addEventListener('click'")[0];
function renderer() {
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
  return { context, elements, render: value => context.secretHealthSummary(value, 'DEV') };
}
const descendants = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(descendants)];
const hasGreen = element => descendants(element).some(child => /\bsecret-health-green\b/.test(child.className || ''));
const health = overrides => ({
  state: 'complete', colour: 'green', checkedAt: '2026-10-21T05:35:00Z',
  detail: 'All reported expiry dates are more than 60 days away.',
  counts: { green: 15, amber: 0, red: 0 }, stale: false, runId: 406,
  url: 'https://dev.azure.com/example/SAMPLE/_build/results?buildId=406&view=ms.vss-build-web.run-extensions-tab',
  fingerprintMismatches: 0, fingerprintUnknown: 0, ...overrides,
});

test('environment health uses colour plus words, report timestamp and an accessible report link', () => {
  const result = renderer().render(health());
  assert.equal(result.attributes['aria-label'], 'Secret and certificate health for DEV');
  assert.match(result.textContent, /Secrets & certificates\s+Healthy/);
  assert.match(result.textContent, /15 green/);
  assert.doesNotMatch(result.textContent, /All reported expiry dates/);
  assert.match(result.textContent, /Last updated.*21 Oct 2026/);
  assert.equal(hasGreen(result), true);
  const time = descendants(result).find(child => child.tagName === 'time');
  assert.equal(time.attributes.datetime, health().checkedAt);
  const link = descendants(result).find(child => child.tagName === 'a');
  assert.equal(link.textContent, 'View report ↗');
  assert.equal(link.href, health().url);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.match(link.attributes['aria-label'], /DEV, run 406.*opens in a new tab/);
  const dot = descendants(result).find(child => child.className === 'secret-health-indicator');
  assert.equal(dot.attributes['aria-hidden'], 'true');
});

test('amber and red report results remain explicit when colour is unavailable to the reader', () => {
  const amber = renderer().render(health({ colour: 'amber', counts: { green: 13, amber: 2, red: 0 } }));
  assert.match(amber.textContent, /Attention/);
  assert.match(amber.textContent, /2 amber · 13 green/);
  assert.equal(descendants(amber).some(child => child.className === 'secret-health-metric secret-health-amber'), true);
  const red = renderer().render(health({ colour: 'red', counts: { green: 12, amber: 2, red: 1 } }));
  assert.match(red.textContent, /Action required/);
  assert.match(red.textContent, /1 red · 2 amber · 12 green/);
  assert.equal(hasGreen(red), false);
});

test('incomplete and stale evidence never receives healthy wording or green styling', () => {
  for (const override of [{ state: 'partial' }, { stale: true }, { state: 'partial', stale: true }]) {
    const result = renderer().render(health(override));
    assert.equal(hasGreen(result), false);
    assert.doesNotMatch(result.textContent, /Healthy/);
    if (override.state === 'partial') assert.match(result.textContent, /Incomplete report/);
    if (override.stale) assert.match(result.textContent, /Stale report/);
  }
  const knownRed = renderer().render(health({ state: 'partial', stale: true, colour: 'red', counts: { green: 2, amber: 0, red: 1 } }));
  assert.match(knownRed.textContent, /Action required.*Incomplete report · Stale report/);
});

test('missing, running and malformed health never implies a healthy result', () => {
  for (const value of [null, undefined, {}, health({ state: 'unavailable' }), health({ counts: null }),
    health({ counts: { green: 0, amber: 0, red: 0 } }), health({ checkedAt: 'bad-date' })]) {
    const result = renderer().render(value);
    assert.equal(hasGreen(result), false);
    assert.match(result.textContent, /Unavailable/);
  }
  assert.match(renderer().render(null).textContent, /Last updated: unavailable/);
  const running = renderer().render(health({ state: 'running' }));
  assert.match(running.textContent, /Report running/);
  assert.equal(hasGreen(running), false);
  assert.doesNotMatch(running.textContent, /15 green/);
});

test('fingerprint warnings remain separate from the expiry colour', () => {
  const result = renderer().render(health({ fingerprintMismatches: 1, fingerprintUnknown: 2 }));
  assert.match(result.textContent, /1 certificate fingerprint mismatch · 2 fingerprint comparisons unavailable/);
  assert.equal(hasGreen(result), true);
  assert.match(result.textContent, /Healthy/);
});

test('report links use the existing ADO restriction and detail is rendered as plain text', () => {
  for (const url of ['javascript:alert(1)', 'https://example.com/report', 'http://dev.azure.com/example', 'https://user:password@dev.azure.com/example']) {
    assert.equal(descendants(renderer().render(health({ url }))).some(child => child.tagName === 'a'), false);
  }
  const detail = '<img src=x onerror=alert(1)> & report metadata';
  const result = renderer().render(health({ state: 'unavailable', detail }));
  assert.equal(descendants(result).find(child => child.className === 'secret-health-detail').textContent, detail);
  assert.equal(descendants(result).some(child => ['img', 'script'].includes(child.tagName)), false);
});

test('health is shown once on each environment card and never falls back to deployment or namespace evidence', () => {
  const { context, elements } = renderer();
  context.dashboard = sampleDashboard();
  vm.runInContext('state.data = dashboard', context);
  context.renderEnvironments();
  const cards = elements.get('environment-grid');
  assert.equal(descendants(cards).filter(child => child.className === 'secret-health-summary').length, 4);
  assert.match(cards.children[0].textContent, /Secrets & certificates\s+Healthy/);
  assert.match(cards.children[1].textContent, /Secrets & certificates\s+Attention/);
  assert.match(cards.children[2].textContent, /Secrets & certificates\s+Action required/);
  assert.match(cards.children[3].textContent, /Secrets & certificates\s+Unavailable/);
  for (const namespace of context.dashboard.namespaces) assert.equal(namespace.secretHealth, undefined);
  for (const release of context.dashboard.releases) assert.equal(release.secretHealth, undefined);
  context.dashboard.environments[0].lastSuccess.secretHealth = health();
  delete context.dashboard.environments[0].secretHealth;
  context.renderEnvironments();
  const healthSection = descendants(cards.children[0]).find(child => child.className === 'secret-health-summary');
  assert.match(healthSection.textContent, /Unavailable/);
  assert.equal(hasGreen(healthSection), false);
});
