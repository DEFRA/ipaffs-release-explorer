import { attachReleaseComparisons } from './release-comparison.mjs';
import { deliveryMetrics } from './delivery.mjs';

// Deliberate demonstration data, used only after an explicit sample-mode request.
export function sampleDashboard() {
  const organization = 'https://dev.azure.com/example';
  const project = 'SAMPLE';
  const now = new Date();
  const at = hours => new Date(now.getTime() - hours * 3600000).toISOString();
  const url = id => `${organization}/${project}/_build/results?buildId=${id}`;
  const evidence = id => [{ label: 'Sample pipeline timeline', url: url(id), type: 'sample' }];
  const qaRun = (id, environment, result, hours, counts = null) => ({
    id, environment, pipelineId: environment === 'DEV' ? 201 : 202,
    status: result ? 'completed' : 'inProgress', result,
    queuedAt: at(hours + 0.5), finishedAt: result ? at(hours) : null,
    url: url(id), resultsUrl: `${url(id)}&view=ms.vss-test-web.build-test-results-tab`,
    summary: counts ? { availability: 'available', ...counts, total: counts.passed + counts.failed + counts.skipped + counts.other,
      executed: counts.passed + counts.failed + counts.other, passPercentage: 100 * counts.passed / (counts.passed + counts.failed + counts.other) } : null,
  });
  const linkedQa = (...runs) => ({ state: 'linked', latest: runs[0], runs });
  const vulnerability = (id, state, hours, counts = null, images = null, distinct = null) => ({
    state, counts, distinct, images, scannedAt: ['complete', 'partial'].includes(state) ? at(hours) : null,
    runId: id, url: id ? `${url(id)}&view=results` : null,
    detail: 'Illustrative registry image scan for this manifest commit, covering references from all environments.',
  });
  const currentScan = vulnerability(401, 'complete', 0.5,
    { critical: 2, high: 18, medium: 83, low: 24, unknown: 1 }, { total: 12, scanned: 12, failed: 0 },
    { critical: 1, high: 7, medium: 31, low: 12, unknown: 1 });
  const masterScan = {
    ...vulnerability(405, 'complete', 0.1,
      { critical: 1, high: 12, medium: 70, low: 20, unknown: 0 }, { total: 12, scanned: 12, failed: 0 },
      { critical: 1, high: 5, medium: 28, low: 10, unknown: 0 }),
    matchedBy: 'assumed-master', sourceRef: 'refs/heads/master', sourceCommit: 'e'.repeat(40),
    detail: 'Illustrative latest master scan, used for current DEV under the assumption that DEV follows master.',
  };
  const previousScan = vulnerability(402, 'partial', 118,
    { critical: 0, high: 0, medium: 21, low: 5, unknown: 0 }, { total: 10, scanned: 8, failed: 2 },
    { critical: 0, high: 0, medium: 9, low: 3, unknown: 0 });
  const failedScan = vulnerability(403, 'failed', 140);
  const secretHealth = (colour, counts, detail) => ({
    state: 'complete', colour, counts, detail, checkedAt: at(6), stale: false,
    runId: 406, url: `${url(406)}&view=ms.vss-build-web.run-extensions-tab`,
    fingerprintMismatches: 0, fingerprintUnknown: 0,
  });
  const deploy = (id, environment, version, status, hours, namespace = environment.toLowerCase()) => ({
    runId: id, environment, namespace, version, status, commit: 'a'.repeat(40), attempt: 1,
    startedAt: status === 'pending' ? null : at(hours + 0.2), finishedAt: status === 'succeeded' ? at(hours) : null,
    url: url(id), evidence: evidence(id), qa: { state: 'not-linked', latest: null, runs: [] },
    vulnerability: vulnerability(null, 'not-scanned', 0),
  });
  const tst = deploy(100, 'TST', '4.2.0', 'succeeded', 24);
  const pre = deploy(100, 'PRE', '4.2.0', 'succeeded', 12);
  for (const deployment of [tst, pre]) {
    deployment.versionKind = 'release-tag';
    deployment.sourceRef = `refs/tags/${deployment.version}`;
  }
  const dev = deploy(101, 'DEV', 'master', 'succeeded', 1);
  for (const deployment of [dev, tst, pre]) deployment.vulnerability = currentScan;
  dev.qa = linkedQa(qaRun(301, 'DEV', 'succeeded', 0.3, { passed: 374, failed: 0, skipped: 18, other: 0 }));
  tst.qa = linkedQa(qaRun(302, 'TST', 'failed', 23, { passed: 372, failed: 4, skipped: 16, other: 0 }));
  dev.trigger = { reason: 'batchedCI', requestedBy: 'Example build service', requestedFor: 'Example build service' };
  const previousPrd = { ...deploy(99, 'PRD', '4.1.3', 'succeeded', 120), commit: 'b'.repeat(40), versionKind: 'release-tag', sourceRef: 'refs/tags/4.1.3' };
  previousPrd.vulnerability = previousScan;
  const dashboard = {
    readOnly: true, mode: 'sample', organization, project, fetchedAt: now.toISOString(),
    namespaceChecks: { enabled: true, checkedAt: now.toISOString(), status: 'partial' },
    limits: { runCount: 3, retrievedRuns: 3, runsPerPipeline: 100, limited: true, scope: 'Illustrative sample data; no live ADO requests.' },
    warnings: [{ code: 'sample', message: 'Sample data is illustrative. Switch to live data to read your ADO project.' }],
    coverage: [
      { label: 'Deployment history', status: 'available', detail: 'Recorded stage outcomes, including releases waiting for approval.' },
      { label: 'DEV namespace presence', status: 'partial', detail: 'Only namespaces confirmed to exist appear in the list. One sample namespace check is unavailable. Application health and running versions are not checked.' },
      { label: 'Revision-specific QA', status: 'partial', detail: 'A linked QA run does not prove the exact revision tested.' },
    ],
    environments: [
      { name: 'DEV', namespace: 'dev', lastSuccess: dev, latestAttempt: dev, vulnerability: masterScan,
        secretHealth: secretHealth('green', { green: 15, amber: 0, red: 0 }, 'All reported expiry dates are more than 60 days away.') },
      { name: 'TST', namespace: 'tst', lastSuccess: tst, latestAttempt: tst,
        secretHealth: secretHealth('amber', { green: 13, amber: 2, red: 0 }, 'Two reported expiry dates are within 30–60 days.') },
      { name: 'PRE', namespace: 'pre', lastSuccess: pre, latestAttempt: pre,
        secretHealth: secretHealth('red', { green: 13, amber: 1, red: 1 }, 'One item expires in fewer than 30 days.') },
      { name: 'PRD', namespace: 'prd', lastSuccess: previousPrd, latestAttempt: deploy(100, 'PRD', '4.2.0', 'pending', 0),
        secretHealth: { state: 'unavailable', colour: 'grey', counts: null, checkedAt: null, stale: false,
          detail: 'The environment report could not be read.', runId: 406,
          url: `${url(406)}&view=ms.vss-build-web.run-extensions-tab`, fingerprintMismatches: 0, fingerprintUnknown: 0 } },
    ],
    namespaces: [
      { name: 'dev', kind: 'canonical', branch: 'refs/heads/master', lastSuccess: dev, latestAttempt: dev,
        creator: { status: 'recorded', name: 'Example operator', createdAt: at(168), runId: 90, url: url(90),
          detail: 'Sample: this manual pipeline run created the namespace. Its creation log matches the current namespace creation time.',
          evidence: [{ label: 'Sample namespace creation log', url: `${url(90)}&view=logs&l=7`, type: 'sample' }] },
        runtime: { status: 'exists', checkedAt: now.toISOString(), createdAt: at(168), uid: '11111111-2222-4333-8444-555555555555', detail: 'Sample: the DEV namespace exists in the cluster.' } },
      { name: '4-2-x', kind: 'release', branch: 'refs/heads/RELEASE/4.2.x', lastSuccess: deploy(102, 'DEV', 'RELEASE/4.2.x', 'succeeded', 4, '4-2-x'), latestAttempt: deploy(102, 'DEV', 'RELEASE/4.2.x', 'succeeded', 4, '4-2-x'),
        runtime: { status: 'missing', checkedAt: now.toISOString(), detail: 'Sample: the cluster returned Not Found for this namespace.' } },
      { name: 'feature-cleanup', kind: 'branch', branch: 'refs/heads/feature/cleanup', lastSuccess: deploy(103, 'DEV', 'feature/cleanup', 'succeeded', 2, 'feature-cleanup'), latestAttempt: deploy(103, 'DEV', 'feature/cleanup', 'succeeded', 2, 'feature-cleanup'),
        runtime: { status: 'terminating', checkedAt: now.toISOString(), detail: 'Sample: this namespace has a deletion timestamp and is terminating.' } },
      { name: 'feature-unchecked', kind: 'branch', branch: 'refs/heads/feature/unchecked', lastSuccess: deploy(104, 'DEV', 'feature/unchecked', 'succeeded', 3, 'feature-unchecked'), latestAttempt: deploy(104, 'DEV', 'feature/unchecked', 'succeeded', 3, 'feature-unchecked'),
        creator: { status: 'unavailable', name: null, createdAt: null, runId: null, url: null,
          detail: 'Sample: creator attribution is unavailable because the current namespace metadata could not be checked.', evidence: [] },
        runtime: { status: 'unknown', checkedAt: now.toISOString(), detail: 'Sample: the cluster request timed out, so namespace presence is unknown.' } },
    ],
    releases: [
      { version: '4.2.0', series: '4.2', commit: 'a'.repeat(40), branch: 'RELEASE/4.2.x', observedAt: at(25), outcome: 'created', runId: 100, url: url(100), confidence: 'recorded', evidence: evidence(100) },
      { version: '4.1.3', series: '4.1', commit: 'b'.repeat(40), branch: 'RELEASE/4.1.x', observedAt: at(125), outcome: 'created', runId: 99, url: url(99), confidence: 'recorded', evidence: evidence(99) },
      { version: '4.1.2', series: '4.1', commit: 'c'.repeat(40), branch: 'RELEASE/4.1.x', observedAt: at(145), outcome: 'created', runId: 98, url: url(98), confidence: 'recorded', evidence: evidence(98) },
    ],
    runs: [
      { id: 101, pipeline: 'Deploy DEV', buildNumber: 'sample-dev', sourceRef: 'refs/heads/master', commit: 'a'.repeat(40), status: 'completed', result: 'succeeded', queuedAt: at(1.3), startedAt: at(1.2), finishedAt: at(1), url: url(101) },
      { id: 100, pipeline: 'Release Pipeline', buildNumber: '4.2.0', sourceRef: 'refs/tags/4.2.0', commit: 'a'.repeat(40), status: 'inProgress', result: null, queuedAt: at(24.3), startedAt: at(24.2), finishedAt: null, url: url(100) },
      { id: 99, pipeline: 'Release Pipeline', buildNumber: '4.1.3', sourceRef: 'refs/tags/4.1.3', commit: 'b'.repeat(40), status: 'completed', result: 'succeeded', queuedAt: at(121), startedAt: at(120.2), finishedAt: at(120), url: url(99) },
      { id: 98, pipeline: 'Release Pipeline', buildNumber: '4.1.2', sourceRef: 'refs/tags/4.1.2', commit: 'c'.repeat(40), status: 'completed', result: 'succeeded', queuedAt: at(145), startedAt: at(144.2), finishedAt: at(144), url: url(98) },
      { id: 97, pipeline: 'Release Pipeline', buildNumber: '4.1.3', sourceRef: 'refs/tags/4.1.3', commit: 'b'.repeat(40), status: 'completed', result: 'succeeded', queuedAt: at(130), startedAt: at(128.2), finishedAt: at(128), url: url(97) },
    ],
  };
  for (const deployment of [dashboard.namespaces[1].lastSuccess, dashboard.namespaces[1].latestAttempt]) {
    deployment.trigger = { reason: 'manual', requestedBy: 'Example operator', requestedFor: 'Example operator' };
    deployment.commit = 'd'.repeat(40);
    deployment.vulnerability = vulnerability(404, 'running', 0);
  }
  dashboard.environments[3].latestAttempt.vulnerability = currentScan;
  dashboard.releases.forEach((release, index) => { release.vulnerability = [currentScan, previousScan, failedScan][index]; });
  dashboard.namespaces[1].access = {
    runId: 102, observedAt: at(4), evidence: evidence(102),
    links: [
      { kind: 'b2c-base', label: 'B2C base', url: 'https://app.example.invalid/' },
      { kind: 'b2b-base', label: 'B2B base', url: 'https://internal.example.invalid/' },
      { kind: 'b2c-notifications', label: 'B2C notifications', url: 'https://app.example.invalid/notifications' },
      { kind: 'b2b-notifications', label: 'B2B notifications', url: 'https://internal.example.invalid/notifications' },
    ],
  };
  const progress = (environment, deployment, status = 'deployed', label = environment === 'DEV' ? 'Commit deployed' : 'Deployed') => ({
    environment, status, label,
    detail: environment === 'DEV'
      ? 'Sample evidence: the same manifest commit was deployed to this DEV namespace.'
      : 'Sample evidence: the release tag and commit match this deployment.',
    lastSuccess: deployment.status === 'succeeded' ? deployment : null,
    latestAttempt: deployment,
    matchedBy: environment === 'DEV' ? 'commit' : 'tag-and-commit',
    runId: deployment.runId, url: deployment.url, evidence: deployment.evidence,
  });
  const missing = environment => ({
    environment, status: 'not-recorded', label: 'No record',
    detail: 'No matching deployment is included in this illustrative sample.',
    lastSuccess: null, latestAttempt: null, matchedBy: null, evidence: [],
  });
  dashboard.releases[0].progress = [
    progress('DEV', dev), progress('TST', tst), progress('PRE', pre),
    { ...progress('PRD', dashboard.environments[3].latestAttempt, 'awaiting-approval', 'Awaiting approval'), detail: 'Sample evidence: the PRD approval stage is waiting; deployment has not started.' },
  ];
  dashboard.releases[1].progress = [missing('DEV'), missing('TST'), missing('PRE'), progress('PRD', previousPrd)];
  dashboard.releases[2].progress = ['DEV', 'TST', 'PRE', 'PRD'].map(missing);
  const historicalDeployment = (id, environment, version, hours, commit) => ({
    ...deploy(id, environment, version, 'succeeded', hours), commit,
    vulnerability: version === '4.1.3' ? previousScan : failedScan,
    versionKind: 'release-tag', sourceRef: `refs/tags/${version}`,
    trigger: { reason: 'manual', requestedBy: 'Example operator', requestedFor: 'Example operator' },
  });
  const historicalProgress = (environment, deployments) => ({
    ...(deployments.length ? progress(environment, deployments[0]) : missing(environment)), deployments,
    evidence: deployments.flatMap(deployment => deployment.evidence),
  });
  dashboard.previousReleases = [
    { ...dashboard.releases[1], history: true, observedAt: at(120), progress: [
      historicalProgress('DEV', []),
      historicalProgress('TST', [historicalDeployment(97, 'TST', '4.1.3', 130, 'b'.repeat(40))]),
      historicalProgress('PRE', [historicalDeployment(97, 'PRE', '4.1.3', 129, 'b'.repeat(40))]),
      historicalProgress('PRD', [historicalDeployment(99, 'PRD', '4.1.3', 120, 'b'.repeat(40)), historicalDeployment(97, 'PRD', '4.1.3', 128, 'b'.repeat(40))]),
    ] },
    { ...dashboard.releases[2], history: true, observedAt: at(144), progress: [
      historicalProgress('DEV', []), historicalProgress('TST', []), historicalProgress('PRE', []),
      historicalProgress('PRD', [historicalDeployment(98, 'PRD', '4.1.2', 144, 'c'.repeat(40))]),
    ] },
  ].map(({ outcome, ...release }) => release);
  dashboard.limits.runCount = dashboard.runs.length;
  dashboard.limits.retrievedRuns = dashboard.runs.length;
  const previousTst = dashboard.previousReleases[0].progress.find(item => item.environment === 'TST').lastSuccess;
  previousTst.qa = linkedQa(
    qaRun(303, 'TST', null, 0.1),
    qaRun(304, 'TST', 'succeeded', 129, { passed: 376, failed: 0, skipped: 16, other: 0 }),
  );
  attachReleaseComparisons(dashboard.releases, dashboard.environments, [],
    dashboard.previousReleases.flatMap(release => release.progress.flatMap(progress => progress.deployments)));
  // A longer illustrative history so each delivery measure has values.
  const record = (id, environment, version, status, hours, commit, attemptNumber = 1) => ({
    runId: id, environment, namespace: environment.toLowerCase(), version, status, commit, attempt: attemptNumber,
    versionKind: environment === 'DEV' ? 'build-number' : 'release-tag', sourceRef: environment === 'DEV' ? 'refs/heads/master' : `refs/tags/${version}`,
    startedAt: at(hours + 0.2), finishedAt: at(hours), url: url(id),
  });
  const history = [
    ['4.0.0', '1', 60, 1900, [['TST', 1890], ['PRE', 1870], ['PRD', 1850]]],
    ['4.0.1', '2', 61, 1500, [['TST', 1495], ['PRE', 1480], ['PRD', 1460, 'failed'], ['PRD', 1456, 'succeeded', 2]]],
    ['4.0.2', '5', 58, 1210, [['TST', 1205]]],
    ['4.1.0', '3', 62, 900, [['TST', 880, 'failed'], ['TST', 878, 'succeeded', 2], ['PRE', 860], ['PRD', 820]]],
    ['4.1.1', '4', 63, 400, [['TST', 390], ['PRE', 380], ['PRD', 300]]],
    ['4.1.0', '3', 64, null, [['PRD', 296]]],
    ['4.1.2', 'c', 98, 160, [['TST', 152], ['PRE', 148], ['PRD', 144]]],
    ['4.1.3', 'b', 97, 135, [['TST', 130], ['PRE', 129], ['PRD', 128]]],
    ['4.1.3', 'b', 99, null, [['PRD', 120.4, 'failed'], ['PRD', 120, 'succeeded', 2]]],
    ['4.2.0', 'a', 100, 25, [['TST', 24], ['PRE', 12]]],
  ];
  const deliveryDeployments = history.flatMap(([version, digit, id, , steps]) => steps.map(([environment, hours, status = 'succeeded', attemptNumber]) =>
    record(id, environment, version, status, hours, digit.repeat(40), attemptNumber)));
  for (let hours = 2, id = 500; hours < 1950; hours += 46, id += 1) {
    deliveryDeployments.push(record(id, 'DEV', `sample-${id}`, id % 9 === 4 ? 'failed' : 'succeeded', hours, 'e'.repeat(40)));
  }
  dashboard.delivery = deliveryMetrics({
    deployments: deliveryDeployments, now: now.getTime(), coverageStart: at(1950),
    releases: history.filter(([, , , created]) => created !== null).map(([version, digit, id, created]) => ({
      version, commit: digit.repeat(40), outcome: 'created', observedAt: at(created), runId: id, url: url(id), evidence: evidence(id),
    })),
  });
  return dashboard;
}
