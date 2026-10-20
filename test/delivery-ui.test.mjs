import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sampleDashboard } from '../src/sample.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .split("$('refresh').addEventListener('click'")[0];
function render(data) {
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
  vm.runInContext('state.data = dashboard; renderDelivery()', context);
  return { context, content: elements.get('delivery-content'), controls: elements.get('delivery-window') };
}
const descendants = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(descendants)];

test('delivery tab shows the four measures with their definitions and period coverage', () => {
  const { content } = render(sampleDashboard());
  const text = content.textContent;
  for (const label of ['Deployment frequency', 'Lead time', 'Deployment failure rate', 'Time to restore']) assert.match(text, new RegExp(label));
  assert.match(text, /Release tag created → first successful PRD deployment/);
  assert.match(text, /Production incidents are not observed/);
  assert.match(text, /covers the full 30 days/);
  assert.match(text, /Deployments by environment/);
  assert.match(text, /Release lead times/);
  assert.match(text, /Failed PRD deployments/);
});

test('switching to 90 days explains partial history and lists rollbacks', () => {
  const data = sampleDashboard();
  const { context, content, controls } = render(data);
  const ninety = descendants(controls).find(child => child.tagName === 'button' && child.textContent === '90 days');
  assert.equal(ninety.attributes['aria-pressed'], 'false');
  ninety.listeners.click();
  assert.equal(vm.runInContext('state.deliveryWindow', context), 90);
  const text = content.textContent;
  assert.match(text, /covers 81\.\d of 90 days/);
  assert.match(text, /Rollbacks/);
  assert.equal(descendants(controls).find(child => child.textContent === '90 days').attributes['aria-pressed'], 'true');
});

test('evidence dates link only to ADO runs', () => {
  const data = sampleDashboard();
  data.delivery.releases[0].firstPrd.url = 'https://example.invalid/run';
  const links = descendants(render(data).content).filter(child => child.tagName === 'a');
  assert.ok(links.length > 0);
  assert.ok(links.every(link => new URL(link.href).hostname === 'dev.azure.com'));
});

test('missing delivery data renders an explicit unavailable state rather than zeros', () => {
  const data = sampleDashboard();
  delete data.delivery;
  const text = render(data).content.textContent;
  assert.match(text, /Delivery metrics unavailable/);
  assert.doesNotMatch(text, /0%/);
});

test('a period without PRD attempts does not report a 0% failure rate', () => {
  const data = sampleDashboard();
  data.delivery.windows[0] = { ...data.delivery.windows[0],
    prd: { deployments: 0, releases: 0, perWeek: 0 },
    failureRate: { failed: 0, succeeded: 0, rate: null, rollbacks: 0 },
    leadTime: { count: 0, notRecorded: 0, medianMs: null, minMs: null, maxMs: null },
    recovery: { count: 0, unresolved: 0, medianMs: null } };
  const text = render(data).content.textContent;
  assert.match(text, /No attempts/);
  assert.match(text, /No failed PRD deployments in this period/);
});
