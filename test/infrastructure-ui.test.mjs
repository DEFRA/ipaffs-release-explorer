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
}

const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8'))
  .split("$('refresh').addEventListener('click'")[0];
const descendants = element => [element, ...element.children.filter(child => child instanceof Element).flatMap(descendants)];
const evidence = (runId, stage) => ({ runId, stage, at: '2026-11-09T14:00:00Z', runUrl: `https://dev.azure.com/example/Project/_build/results?buildId=${runId}&view=logs&j=10` });

function render(infrastructure, view, environments = []) {
  const content = new Element('div');
  const context = vm.createContext({ URL, Intl, infrastructure, environments, document: {
    createElement: tag => new Element(tag), getElementById: () => content,
  } });
  vm.runInContext(source, context);
  vm.runInContext('state.data = { infrastructure, environments }', context);
  context[view]();
  return content;
}

const renderInfrastructure = infrastructure => render(infrastructure, 'renderInfrastructure');
const environmentVersions = infrastructure => render(infrastructure, 'renderEnvironments',
  ['DEV', 'TST', 'PRE', 'PRD'].map(name => ({ name }))).children.map(card => card.children[2]);

test('infrastructure progression separates the DEV apply from tag promotion and preserves an earlier success', () => {
  const oldSuccess = evidence(201, 'TST_Complete');
  const content = renderInfrastructure({ availability: 'available', devAvailability: 'available', limited: true,
    latestSuccessful: { TST: { ...oldSuccess, tag: '1.1' } },
    releases: [{ tag: '1.1', commit: 'f'.repeat(40), environments: {
      DEV: { ...evidence(101, 'PrivateLink'), status: 'succeeded' },
      TST: { ...evidence(202, 'TST_DeployInfrastructure'), status: 'failed', successful: oldSuccess },
      PRE: { ...evidence(201, 'GateToPRE'), status: 'awaitingApproval' },
      PRD: { status: 'pending' },
    } }],
  });
  const latest = descendants(content).find(child => child.className === 'release-progress infrastructure-latest');
  assert.match(latest.textContent, /TST Tag 1.1 .* Run #201/);
  assert.match(latest.textContent, /PRE No success recorded PRD No success recorded/);
  const progress = descendants(content).find(child => child.tagName === 'ol');
  assert.equal(progress.attributes['aria-label'], 'Recorded progression for infrastructure tag 1.1');
  assert.match(progress.children[0].textContent, /DEV · Main branch Applied.*Run #101/);
  assert.match(progress.children[1].textContent, /TST Failed.*Run #202.*Earlier success.*Run #201/);
  assert.match(progress.children[2].textContent, /PRE Awaiting approval.*Run #201/);
  assert.equal(progress.children[3].textContent, 'PRD Pending');
  const link = descendants(progress.children[2]).find(child => child.tagName === 'a');
  assert.equal(link.href, evidence(201).runUrl);
  assert.match(link.attributes['aria-label'], /GateToPRE/);
  assert.match(content.textContent, /Commit ffffffff/);
  assert.match(content.textContent, /The scan limit was reached/);
});

test('infrastructure scan distinguishes missing runs, unavailable evidence and unknown outcomes', () => {
  assert.match(renderInfrastructure().textContent, /Infrastructure release history unavailable/);
  assert.match(renderInfrastructure({ availability: 'available', releases: [] }).textContent, /No infrastructure releases recorded/);
  const content = renderInfrastructure({ availability: 'available', devAvailability: 'unavailable', releases: [
    { tag: '1', environments: { DEV: { status: 'unavailable' }, TST: { status: 'noEvidence' }, PRE: { status: 'unknown' },
      PRD: { runUrl: 'https://example.invalid/run', status: 'succeeded' } } },
  ] });
  assert.match(content.textContent, /DEV main-branch apply history is unavailable/);
  assert.match(content.textContent, /DEV · Main branch Evidence unavailable TST No evidence recorded PRE Outcome unknown PRD Deployed/);
  assert.equal(descendants(content).filter(child => child.tagName === 'a').length, 0);
});

test('overview cards show the applied DEV main commit and the last successful tag for each promotion environment', () => {
  const commit = '1234567890abcdef'.repeat(2) + '12345678';
  const sections = environmentVersions({ availability: 'available', devAvailability: 'available',
    latestDev: { ...evidence(101, 'PrivateLink'), commit },
    latestSuccessful: {
      TST: { ...evidence(203, 'TST_Complete'), tag: '1.2', commit },
      PRE: { ...evidence(202, 'PRE_Complete'), tag: '1.1', commit },
      PRD: { ...evidence(201, 'PRD_Complete'), tag: '1', commit },
    },
  });
  const environments = ['DEV', 'TST', 'PRE', 'PRD'];
  const versions = ['main · 12345678', 'Tag 1.2', 'Tag 1.1', 'Tag 1'];
  const runs = [101, 203, 202, 201];
  sections.forEach((section, index) => {
    assert.equal(section.className, 'infrastructure-version-summary');
    assert.equal(section.attributes['aria-label'], `Infrastructure version for ${environments[index]}`);
    assert.equal(section.children[0].textContent, 'Infrastructure version');
    assert.equal(section.children[1].textContent, versions[index]);
    assert.equal(section.children[1].title, commit);
    const link = descendants(section).find(element => element.tagName === 'a');
    assert.equal(link.href, evidence(runs[index]).runUrl);
    assert.match(link.attributes['aria-label'], new RegExp(`Infrastructure deployment in ${environments[index]}`));
    assert.equal(descendants(section).find(element => element.tagName === 'time').attributes.datetime, evidence().at);
  });
});

test('overview distinguishes source availability and does not promote an in-flight tag to a deployed version', () => {
  const sections = environmentVersions({ availability: 'available', devAvailability: 'available', devLatestAvailability: 'unavailable',
    latestSuccessful: { TST: { tag: '1.1', runUrl: 'https://example.invalid/unsafe' } },
    releases: [{ tag: '1.2', environments: { PRE: { status: 'awaitingApproval' } } }],
  });
  assert.deepEqual(sections.map(section => section.children[1].textContent),
    ['Unavailable', 'Tag 1.1', 'No version recorded', 'No version recorded']);
  assert.equal(sections.flatMap(descendants).some(element => element.tagName === 'a'), false);

  const independentDev = environmentVersions({ availability: 'unavailable', devAvailability: 'available',
    latestDev: { commit: 'a'.repeat(40) },
  });
  assert.deepEqual(independentDev.map(section => section.children[1].textContent),
    ['main · aaaaaaaa', 'Unavailable', 'Unavailable', 'Unavailable']);

  const boundedDev = environmentVersions({ devLatestAvailability: 'available', devLatestLimited: true });
  assert.equal(boundedDev[0].children[1].textContent, 'No verified apply in scan');
});
