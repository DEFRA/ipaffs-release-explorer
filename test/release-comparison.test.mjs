import test from 'node:test';
import assert from 'node:assert/strict';
import { attachReleaseComparisons } from '../src/release-comparison.mjs';

const sha = 'a'.repeat(40);
const baselineSha = 'b'.repeat(40);
const otherSha = 'c'.repeat(40);
const compareUrl = (base, head = '4.2.3') => `https://github.com/DEFRA/ipaffs-manifest/compare/${base}...${head}`;
const release = (overrides = {}) => ({
  version: '4.2.3', commit: sha,
  progress: ['DEV', 'TST', 'PRE', 'PRD'].map(environment => ({ environment })),
  ...overrides,
});
const deployment = (version = '4.1.9', overrides = {}) => ({
  version, versionKind: 'release-tag', sourceRef: `refs/tags/${version}`,
  commit: baselineSha, status: 'succeeded', ...overrides,
});
const environment = (name, lastSuccess = deployment(), overrides = {}) => ({
  name, namespace: name.toLowerCase(),
  lastSuccess: lastSuccess && { environment: name, namespace: name.toLowerCase(), finishedAt: '2035-03-09T12:00:00Z', ...lastSuccess },
  ...overrides,
});
const comparison = (candidate, name) => candidate.progress.find(item => item.environment === name).comparison;
const attach = (releases, environments, identities = [], deployments = environments.map(item => item.lastSuccess).filter(Boolean)) =>
  attachReleaseComparisons(releases, environments, identities, deployments);

test('each canonical environment has its own full tag baseline from a different major/minor series', () => {
  const candidate = release();
  const versions = ['4.1.9', '4.0.2', '3.9.6', '3.8.1'];
  attach([candidate], ['DEV', 'TST', 'PRE', 'PRD'].map((name, index) => environment(name, deployment(versions[index]))));
  candidate.progress.forEach((progress, index) => {
    assert.equal(progress.comparison.baseVersion, versions[index]);
    assert.equal(progress.comparison.headVersion, candidate.version);
    assert.equal(progress.comparison.url, compareUrl(versions[index]));
    assert.match(progress.comparison.detail, new RegExp(progress.environment));
  });
});

test('the reported 26.3.1 to 26.4.1 comparison uses the canonical GitHub URL with exact deployed tags', () => {
  const candidate = release({ version: '26.4.1' });
  attach([candidate], [environment('TST', deployment('26.3.1'))]);
  const result = comparison(candidate, 'TST');
  assert.equal(result.baseVersion, '26.3.1');
  assert.equal(result.headVersion, '26.4.1');
  assert.equal(result.url, 'https://github.com/DEFRA/ipaffs-manifest/compare/26.3.1...26.4.1');
});

test('latest failed or in-progress attempts cannot replace the recorded successful baseline', () => {
  for (const status of ['failed', 'inProgress', 'canceled']) {
    const candidate = release();
    attach([candidate], [environment('TST', deployment(), { latestAttempt: deployment('4.2.2', { status }) })]);
    assert.equal(comparison(candidate, 'TST').url, compareUrl('4.1.9'));
  }
});

test('history containing only the candidate series has no comparison, including the exact candidate tag', () => {
  const candidate = release();
  const current = environment('TST', deployment(candidate.version, { commit: candidate.commit }));
  attach([candidate], [current], [], [current.lastSuccess, {
    ...deployment('4.2.0'), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-08T12:00:00Z',
  }]);
  assert.equal(comparison(candidate, 'TST').url, null);
  assert.equal(comparison(candidate, 'TST').detail, 'No successful deployment from a different release series recorded.');
});

test('missing or malformed release identities never become GitHub comparison refs', () => {
  for (const overrides of [
    { version: null }, { version: undefined }, { version: '4.2' }, { version: '4.02.3' },
    { version: '4.2.x' }, { version: '4.2.3-beta' }, { version: '4.2.3?expand=1' },
    { commit: null }, { commit: undefined }, { commit: sha.slice(0, 7) }, { commit: 'g'.repeat(40) },
  ]) {
    const candidate = release(overrides);
    attach([candidate], [environment('TST')]);
    assert.equal(comparison(candidate, 'TST').url, null, JSON.stringify(overrides));
    assert.match(comparison(candidate, 'TST').detail, /identity unavailable/);
  }
});

test('a tag baseline requires successful status, full source tag ref and full commit identity', () => {
  for (const overrides of [
    { status: 'failed' }, { status: 'inProgress' }, { versionKind: 'build-number' },
    { sourceRef: null }, { sourceRef: '4.1.9' }, { sourceRef: 'refs/heads/4.1.9' },
    { sourceRef: 'refs/tags/4.1.8' }, { version: '4.01.9' },
    { commit: null }, { commit: undefined }, { commit: baselineSha.slice(0, 7) },
  ]) {
    const candidate = release();
    attach([candidate], [environment('TST', deployment('4.1.9', overrides))]);
    assert.equal(comparison(candidate, 'TST').url, null, JSON.stringify(overrides));
  }
});

test('missing successful history yields an explanation and never borrows another environment baseline', () => {
  const candidate = release();
  attach([candidate], [environment('TST'), environment('PRE', null)]);
  for (const name of ['DEV', 'PRE', 'PRD']) {
    assert.equal(comparison(candidate, name).url, null);
    assert.equal(comparison(candidate, name).detail, 'No successful deployment from a different release series recorded.');
  }
  assert.equal(comparison(candidate, 'TST').url, compareUrl('4.1.9'));
});

test('DEV branch builds compare only through a unique recorded tag with the exact full commit', () => {
  const candidate = release();
  const dev = deployment('20990101.8', {
    versionKind: 'build-number', sourceRef: 'refs/heads/master', commit: baselineSha.toUpperCase(),
  });
  attach([candidate], [environment('DEV', dev)], [{ version: '4.1.9', commit: baselineSha }]);
  assert.equal(comparison(candidate, 'DEV').url, compareUrl('4.1.9'));
  assert.equal(comparison(candidate, 'DEV').matchedBy, 'commit');
  assert.match(comparison(candidate, 'DEV').detail, /branch build/);
  assert.doesNotMatch(comparison(candidate, 'DEV').url, /20990101/);
});

test('DEV build numbers and unmatched or ambiguous commit identities do not invent tags', () => {
  for (const [commit, identities] of [
    [baselineSha, []],
    [baselineSha, [{ version: '4.1.9', commit: otherSha }]],
    [baselineSha.slice(0, 7), [{ version: '4.1.9', commit: baselineSha }]],
    [baselineSha, [{ version: '4.1.9', commit: baselineSha }, { version: '4.1.10', commit: baselineSha }]],
    [baselineSha, [{ version: '4.1.x', commit: baselineSha }]],
  ]) {
    const candidate = release();
    attach([candidate], [environment('DEV', deployment('4.1.9', {
      versionKind: 'build-number', sourceRef: 'refs/heads/master', commit,
    }))], identities);
    assert.equal(comparison(candidate, 'DEV').url, null, JSON.stringify({ commit, identities }));
    assert.match(comparison(candidate, 'DEV').detail, /recorded|identity/);
  }
});

test('matching tag identities accept full SHA-256 and normalize commit case', () => {
  const candidate = release({ commit: 'A'.repeat(64) });
  const dev = deployment('20990101.8', { versionKind: 'build-number', sourceRef: 'refs/heads/master', commit: 'B'.repeat(64) });
  attach([candidate], [environment('DEV', dev)], [
    { version: '4.1.9', commit: 'b'.repeat(64) }, { version: '4.2.3', commit: 'a'.repeat(64) },
  ]);
  assert.equal(comparison(candidate, 'DEV').url, compareUrl('4.1.9'));
});

test('conflicting recorded commits suppress either comparison endpoint', () => {
  for (const identity of [{ version: '4.1.9', commit: otherSha }, { version: '4.2.3', commit: otherSha }]) {
    const candidate = release();
    attach([candidate], [environment('TST')], [identity]);
    assert.equal(comparison(candidate, 'TST').url, null, JSON.stringify(identity));
    assert.match(comparison(candidate, 'TST').detail, /Conflicting commits/);
  }
});

test('a deployment contradicting the recorded tag identity also suppresses comparison', () => {
  const candidate = release();
  attach([candidate], [environment('TST', deployment('4.1.9', { commit: otherSha }))], [
    { version: '4.1.9', commit: baselineSha },
  ]);
  assert.equal(comparison(candidate, 'TST').url, null);
  assert.match(comparison(candidate, 'TST').detail, /Conflicting commits/);
});

test('same-series patches are skipped and the previous series follows deployment completion rather than version order', () => {
  const candidate = release();
  const newest = environment('TST', deployment('4.2.2', { commit: 'd'.repeat(40) }));
  attach([candidate], [newest], [], [
    { ...deployment('4.1.9'), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-05T12:00:00Z' },
    { ...deployment('4.0.2', { commit: otherSha }), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-07T12:00:00Z' },
    { ...newest.lastSuccess, finishedAt: '2035-03-09T12:00:00Z' },
    { ...deployment('4.2.1', { commit: 'e'.repeat(40) }), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-08T12:00:00Z' },
    { ...deployment('3.8.0', { commit: 'f'.repeat(40), status: 'failed' }), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-10T12:00:00Z' },
  ]);
  assert.equal(comparison(candidate, 'TST').url, compareUrl('4.0.2'));
});

test('the excluded major/minor series belongs to each candidate rather than the latest deployment', () => {
  const candidates = [release(), release({ version: '4.1.8', commit: 'e'.repeat(40) })];
  const newest = environment('TST', deployment('4.2.0', { commit: otherSha }));
  attach(candidates, [newest], [], [
    newest.lastSuccess,
    { ...deployment('4.1.9'), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-07T12:00:00Z' },
  ]);
  assert.equal(comparison(candidates[0], 'TST').url, compareUrl('4.1.9'));
  assert.equal(comparison(candidates[1], 'TST').url, compareUrl('4.2.0', '4.1.8'));
});

test('canonical DEV history skips the candidate series and excludes newer feature namespace deployments', () => {
  const candidate = release();
  const dev = (commit, finishedAt, namespace = 'dev') => ({
    ...deployment('20990101.8', { commit, versionKind: 'build-number', sourceRef: 'refs/heads/master' }),
    environment: 'DEV', namespace, finishedAt,
  });
  const current = dev(sha, '2035-03-09T12:00:00Z');
  attach([candidate], [environment('DEV', current)], [
    { version: '4.1.9', commit: baselineSha }, { version: '3.9.6', commit: otherSha },
  ], [
    dev(otherSha, '2035-03-10T12:00:00Z', 'feature-example'),
    current,
    dev(baselineSha, '2035-03-07T12:00:00Z'),
  ]);
  assert.equal(comparison(candidate, 'DEV').url, compareUrl('4.1.9'));
  assert.equal(comparison(candidate, 'DEV').matchedBy, 'commit');
});

test('a newer different-series deployment with missing or abbreviated commit blocks fallback to older history', () => {
  for (const commit of [undefined, baselineSha.slice(0, 7)]) {
    const candidate = release();
    const newest = environment('TST', deployment('4.0.2', { commit }));
    attach([candidate], [newest], [], [
      { ...deployment('4.1.9'), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-07T12:00:00Z' },
      newest.lastSuccess,
    ]);
    assert.equal(comparison(candidate, 'TST').url, null, String(commit));
    assert.equal(comparison(candidate, 'TST').detail, 'A newer successful deployment has no reliable release tag identity.');
  }
});

test('a known same-series tag can be skipped despite missing or abbreviated commit identity', () => {
  for (const commit of [undefined, sha.slice(0, 7)]) {
    const candidate = release();
    const newest = environment('TST', deployment('4.2.0', { commit }));
    attach([candidate], [newest], [], [
      { ...deployment('4.1.9'), environment: 'TST', namespace: 'tst', finishedAt: '2035-03-07T12:00:00Z' },
      newest.lastSuccess,
    ]);
    assert.equal(comparison(candidate, 'TST').url, compareUrl('4.1.9'), String(commit));
  }
});

test('a newer ambiguous DEV commit blocks older unique tag history unless every possible tag is in the candidate series', () => {
  for (const [versions, expectedUrl] of [
    [['4.0.2', '4.1.8'], null],
    [['4.2.0', '4.1.8'], null],
    [['4.2.0', '4.2.1'], compareUrl('4.1.9')],
  ]) {
    const candidate = release();
    const dev = (commit, finishedAt) => ({
      ...deployment('20990101.8', { commit, versionKind: 'build-number', sourceRef: 'refs/heads/master' }),
      environment: 'DEV', namespace: 'dev', finishedAt,
    });
    const newest = dev(otherSha, '2035-03-09T12:00:00Z');
    attach([candidate], [environment('DEV', newest)], [
      { version: '4.1.9', commit: baselineSha },
      ...versions.map(version => ({ version, commit: otherSha })),
    ], [
      dev(baselineSha, '2035-03-07T12:00:00Z'),
      newest,
    ]);
    assert.equal(comparison(candidate, 'DEV').url, expectedUrl, versions.join(', '));
    if (!expectedUrl) assert.equal(comparison(candidate, 'DEV').detail, 'A newer successful deployment has no reliable release tag identity.');
  }
});
