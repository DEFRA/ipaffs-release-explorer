import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

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
const descendants = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(descendants)];
const linksIn = element => descendants(element).filter(child => child.tagName === 'a');
const compareUrl = (base, head = '4.2.3') => `https://github.com/DEFRA/ipaffs-manifest/compare/tags/${base}...tags/${head}`;
const comparison = (baseVersion, overrides = {}) => ({
  baseVersion, headVersion: '4.2.3', url: compareUrl(baseVersion),
  detail: 'Compares the last successful deployment from a different major.minor series with this release tag.',
  matchedBy: 'release-tag', ...overrides,
});
const release = () => ({
  version: '4.2.3', commit: 'a'.repeat(40),
  progress: ['DEV', 'TST', 'PRE', 'PRD'].map((environment, index) => ({
    environment, status: 'not-recorded', label: 'No record', detail: 'No matching deployment is recorded.',
    comparison: comparison(['4.1.7', '4.1.8', '4.1.9', '4.0.5'][index]),
  })),
});

function renderer() {
  const context = vm.createContext({ URL, Intl, Node: Element, document: {
    createElement: tag => new Element(tag),
    createTextNode: value => String(value),
  } });
  vm.runInContext(source, context);
  const drawer = new Element('div');
  context.showDetail = () => { drawer.replaceChildren(); return drawer; };
  return { context, drawer };
}

test('each environment compares its own different release series baseline to the exact candidate patch tag', () => {
  const { context } = renderer();
  const candidate = release();
  const rendered = context.releaseProgress(candidate);
  const list = rendered.children[0];
  assert.equal(list.tagName, 'ol');
  assert.equal(list.className, 'release-progress');
  assert.equal(list.children.length, 4);
  assert.equal(linksIn(list).length, 0, 'deployment progress contains only evidence buttons');
  const links = linksIn(rendered);
  assert.equal(links.length, 4);
  list.children.forEach((item, index) => {
    const progress = candidate.progress[index];
    const control = item.children[0];
    const link = links[index];
    assert.equal(control.tagName, 'button');
    assert.equal(linksIn(control).length, 0, 'comparison links must not be nested in evidence buttons');
    assert.equal(link.tagName, 'a');
    assert.equal(link.href, compareUrl(progress.comparison.baseVersion));
    assert.equal(link.textContent, `Compare ${progress.comparison.baseVersion} → 4.2.3 ↗`);
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.match(link.attributes['aria-label'], new RegExp(`${progress.environment} on GitHub \\(opens in a new tab\\)`));
    assert.match(link.title, /last successful recorded deployment from a different major\/minor series/);
    assert.ok(link.title.includes(progress.environment));
  });
});

test('environments sharing a baseline have one comparison below progress while different baselines remain separate', () => {
  const { context } = renderer();
  const candidate = release();
  candidate.progress.slice(1).forEach(progress => { progress.comparison = comparison('4.1.9'); });
  const before = JSON.stringify(candidate);
  const rendered = context.releaseProgress(candidate);
  const links = linksIn(rendered);
  assert.equal(links.length, 2);
  assert.equal(linksIn(rendered.children[0]).length, 0);
  assert.equal(links[0].href, compareUrl('4.1.7'));
  assert.equal(links[0].textContent, 'Compare 4.1.7 → 4.2.3 ↗');
  assert.equal(links[1].href, compareUrl('4.1.9'));
  assert.equal(links[1].textContent, 'Compare 4.1.9 → 4.2.3 ↗');
  assert.match(links[1].attributes['aria-label'], /TST, PRE, PRD on GitHub \(opens in a new tab\)/);
  assert.equal(links[1].target, '_blank');
  assert.equal(links[1].rel, 'noopener noreferrer');
  assert.equal(JSON.stringify(candidate), before, 'grouping must preserve environment-specific comparison evidence');
});

test('GitHub compare URL validation accepts only exact manifest tag comparisons and leaves ADO links restricted', () => {
  const { context } = renderer();
  assert.equal(context.safeGithubCompareUrl(compareUrl('0.0.0')), compareUrl('0.0.0'));
  for (const url of [
    'javascript:alert(1)',
    compareUrl('4.1.9').replace('https:', 'http:'),
    compareUrl('4.1.9').replace('github.com', 'github.com.evil.example'),
    compareUrl('4.1.9').replace('github.com', 'user:password@github.com'),
    compareUrl('4.1.9').replace('github.com', 'github.com:443'),
    compareUrl('4.1.9').replace('github.com', 'github.com:8443'),
    compareUrl('4.1.9').replace('DEFRA', 'other-owner'),
    compareUrl('4.1.9').replace('ipaffs-manifest', 'other-repo'),
    compareUrl('4.1.9').replace('/tags/', '/heads/'),
    compareUrl('4.1.9').replace('/compare/', '/compare/../compare/'),
    `${compareUrl('4.1.9')}?expand=1`,
    `${compareUrl('4.1.9')}#files`,
    `${compareUrl('4.1.9')}/`,
    ` ${compareUrl('4.1.9')}`,
    compareUrl('04.1.9'), compareUrl('4.1'), compareUrl('4.1.x'), compareUrl('4.1.9-beta'),
    compareUrl('4.1.9', '4.02.3'), compareUrl('4.1.9', 'master'),
    null, undefined,
  ]) assert.equal(context.safeGithubCompareUrl(url), null, String(url));
  assert.equal(context.safeUrl(compareUrl('4.1.9')), null);
  assert.equal(context.safeUrl('https://dev.azure.com/example/project/_build/results?buildId=1'), 'https://dev.azure.com/example/project/_build/results?buildId=1');
});

test('unavailable, same-tag and absent comparisons preserve progress without summary links or caveats', () => {
  const { context } = renderer();
  const candidate = release();
  candidate.progress[0].comparison = { url: null, detail: 'No uniquely matching release tag was found for this DEV commit.' };
  candidate.progress[1].comparison = comparison('4.2.3', { url: null, detail: 'This tag is already the last successful recorded deployment.' });
  candidate.progress[2].comparison = { url: null, detail: 'No successful release deployment was found in the scanned history.' };
  delete candidate.progress[3].comparison;
  const rendered = context.releaseProgress(candidate);
  assert.equal(linksIn(rendered).length, 0);
  const list = rendered.children[0];
  assert.equal(list.children.length, 4);
  list.children.forEach(item => { assert.equal(item.children.length, 1); });
  assert.equal(rendered.children.length, 1, 'no comparison area is rendered when every comparison is unavailable');
  candidate.progress.slice(0, 3).forEach(progress => {
    assert.equal(rendered.textContent.includes(progress.comparison.detail), false);
  });
});

test('missing and unsafe comparisons are omitted from summaries without joining a valid comparison', () => {
  const { context } = renderer();
  const candidate = release();
  const detail = 'No earlier successful deployment from a different release series was found.';
  candidate.progress[0].comparison = { url: null, detail };
  candidate.progress[1].comparison = comparison('4.1.9');
  candidate.progress[2].comparison = { url: null, detail };
  candidate.progress[3].comparison = comparison('4.1.9', { url: 'https://evil.example/compare', detail });
  const rendered = context.releaseProgress(candidate);
  const links = linksIn(rendered);
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, 'Compare 4.1.9 → 4.2.3 ↗');
  assert.match(links[0].attributes['aria-label'], /for TST on GitHub/);
  assert.doesNotMatch(links[0].attributes['aria-label'], /DEV|PRE|PRD/);
  assert.equal(rendered.textContent.includes(detail), false);
});

test('mismatched comparison links are omitted from summaries and unsafe drawer details remain plain text', () => {
  const { context, drawer } = renderer();
  const detail = '<img src=x onerror=alert(1)> No comparison';
  for (const overrides of [
    { url: 'https://evil.example/compare' },
    { url: compareUrl('4.1.9') },
    { baseVersion: '4.2.3', headVersion: '4.2.3', url: compareUrl('4.2.3') },
  ]) {
    const candidate = release();
    candidate.progress[0].comparison = comparison('4.2.0', { ...overrides, detail });
    candidate.progress.slice(1).forEach(progress => { delete progress.comparison; });
    const rendered = context.releaseProgress(candidate);
    assert.equal(linksIn(rendered).length, 0);
    assert.equal(rendered.textContent.includes(detail), false);
    assert.equal(descendants(rendered).some(element => element.tagName === 'img'), false);
    context.openReleaseProgress(candidate, candidate.progress[0]);
    assert.equal(linksIn(drawer).length, 0);
    assert.ok(drawer.textContent.includes(detail));
    assert.equal(descendants(drawer).some(element => element.tagName === 'img'), false);
  }
});

test('environment drawer repeats the comparison with its deployment evidence context', () => {
  const { context, drawer } = renderer();
  const candidate = release();
  const progress = candidate.progress[2];
  context.openReleaseProgress(candidate, progress);
  const section = descendants(drawer).find(element => element.className === 'drawer-section release-comparison');
  assert.ok(section);
  assert.match(section.textContent, /Compare with last different release series/);
  assert.match(section.textContent, /Compares the last successful deployment from a different major.minor series/);
  assert.equal(linksIn(section)[0].href, compareUrl('4.1.9'));
  assert.match(drawer.textContent, /No matching deployment is recorded/);
  assert.match(drawer.textContent, /No matching deployment record was found/);
});

test('environment drawer explains unavailable comparisons and supports older responses without comparisons', () => {
  const { context, drawer } = renderer();
  const candidate = release();
  const progress = candidate.progress[0];
  progress.comparison = { url: null, detail: 'No uniquely matching release tag was found for this DEV commit.' };
  context.openReleaseProgress(candidate, progress);
  assert.match(drawer.textContent, /Compare with last different release series/);
  assert.match(drawer.textContent, /No uniquely matching release tag/);
  assert.equal(linksIn(drawer).length, 0);
  delete progress.comparison;
  context.openReleaseProgress(candidate, progress);
  assert.doesNotMatch(drawer.textContent, /Compare with last different release series/);
});
