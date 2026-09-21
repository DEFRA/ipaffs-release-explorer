// Deliberate demonstration data, used only after an explicit sample-mode request.
export function sampleDashboard() {
  const organization = 'https://dev.azure.com/example';
  const project = 'SAMPLE';
  const now = new Date();
  const at = hours => new Date(now.getTime() - hours * 3600000).toISOString();
  const url = id => `${organization}/${project}/_build/results?buildId=${id}`;
  const evidence = id => [{ label: 'Sample pipeline timeline', url: url(id), type: 'sample' }];
  const deploy = (id, environment, version, status, hours, namespace = environment.toLowerCase()) => ({
    runId: id, environment, namespace, version, status, commit: 'a'.repeat(40), attempt: 1,
    startedAt: status === 'pending' ? null : at(hours + 0.2), finishedAt: status === 'succeeded' ? at(hours) : null,
    url: url(id), evidence: evidence(id),
  });
  const tst = deploy(100, 'TST', '4.2.0', 'succeeded', 24);
  const pre = deploy(100, 'PRE', '4.2.0', 'succeeded', 12);
  const dev = deploy(101, 'DEV', 'master', 'succeeded', 1);
  const previousPrd = { ...deploy(99, 'PRD', '4.1.3', 'succeeded', 120), commit: 'b'.repeat(40) };
  const dashboard = {
    readOnly: true, mode: 'sample', organization, project, fetchedAt: now.toISOString(),
    limits: { runCount: 3, retrievedRuns: 3, runsPerPipeline: 100, limited: true, scope: 'Illustrative sample data; no live ADO requests.' },
    warnings: [{ code: 'sample', message: 'Sample data is illustrative. Switch to live data to read your ADO project.' }],
    coverage: [
      { label: 'Deployment history', status: 'available', detail: 'Recorded stage outcomes, including releases waiting for approval.' },
      { label: 'Runtime health', status: 'unavailable', detail: 'No Kubernetes access is used in this prototype.' },
      { label: 'Revision-specific QA', status: 'partial', detail: 'A linked QA run does not prove the exact revision tested.' },
    ],
    environments: [
      { name: 'DEV', namespace: 'dev', lastSuccess: dev, latestAttempt: dev },
      { name: 'TST', namespace: 'tst', lastSuccess: tst, latestAttempt: tst },
      { name: 'PRE', namespace: 'pre', lastSuccess: pre, latestAttempt: pre },
      { name: 'PRD', namespace: 'prd', lastSuccess: previousPrd, latestAttempt: deploy(100, 'PRD', '4.2.0', 'pending', 0) },
    ],
    namespaces: [
      { name: 'dev', kind: 'canonical', branch: 'refs/heads/master', lastSuccess: dev, latestAttempt: dev },
      { name: '4-2-x', kind: 'release', branch: 'refs/heads/RELEASE/4.2.x', lastSuccess: deploy(102, 'DEV', 'RELEASE/4.2.x', 'succeeded', 4, '4-2-x'), latestAttempt: deploy(102, 'DEV', 'RELEASE/4.2.x', 'succeeded', 4, '4-2-x') },
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
  return dashboard;
}
