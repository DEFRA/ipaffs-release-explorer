const VERSION = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
const SHA = '(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{40})';
const CANONICAL = ['DEV', 'TST', 'PRE', 'PRD'];

const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const fullVersion = value => typeof value === 'string' && new RegExp(`^${VERSION}$`).test(value) ? value : null;
const taggedVersion = ref => fullVersion(String(ref || '').replace(/^refs\/tags\//, ''));
const refBranch = ref => String(ref || '').startsWith('refs/heads/') ? ref.slice(11) : null;
const isSuccess = record => record?.state === 'completed' && record?.result === 'succeeded';
const recordStatus = record => record?.result || record?.state || 'unknown';
// Build summary status takes precedence over the original execution result.
// A canceled stage alone is not evidence that the whole run was abandoned.
const isAbandonedStatus = status => status === 16 || String(status || '').toLowerCase() === 'abandoned';
const isAbandonedRun = run => isAbandonedStatus(run.status) || [run.result, run.status].some(value =>
  ['canceled', 'cancelled', 'canceling', 'cancelling', 'abandoned'].includes(String(value || '').toLowerCase()));
const attempt = record => Number(record?.attempt || 1);
const validNamespace = value => typeof value === 'string' && value.length <= 63 && /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value);

function runUrl(build, organization, project) {
  const base = /^https:\/\//.test(organization) ? organization.replace(/\/+$/, '') : `https://dev.azure.com/${encodeURIComponent(organization)}`;
  return build?._links?.web?.href || `${base}/${encodeURIComponent(project)}/_build/results?buildId=${build.id}`;
}

function normalizeRun(build, organization, project) {
  return {
    id: Number(build.id), pipeline: build.definition?.name || `Pipeline ${build.definition?.id || '?'}`,
    pipelineId: Number(build.definition?.id), buildNumber: build.buildNumber || null,
    sourceRef: build.sourceBranch || null, commit: build.sourceVersion || null,
    status: build.status || 'unknown', result: build.result || null,
    abandonment: isAbandonedStatus(build.status) ? 'abandoned' : null,
    queuedAt: build.queueTime || null, startedAt: build.startTime || null,
    finishedAt: build.finishTime || null, url: runUrl(build, organization, project),
  };
}

function evidence(label, url, type = 'timeline') { return { label, url, type }; }
function recordUrl(run, record) { return `${run.url}&view=logs${record?.id ? `&j=${encodeURIComponent(record.id)}` : ''}`; }
function logUrl(run, log) { return `${run.url}&view=logs${log?.id ? `&l=${encodeURIComponent(log.id)}` : ''}`; }

// Only post-push messages emitted by the existing release script are evidence.
// Parameter echoes and "Next patch release" messages do not establish a tag.
export function parseReleaseEvidence(logText) {
  const text = String(logText || '');
  const found = [];
  const created = new RegExp(`(?:^|\\n)(?:\\d{4}-\\d{2}-\\d{2}T[^ \\n]+\\s+)?Created tag '(${VERSION})' at (${SHA})(?=\\s|$)`, 'g');
  const present = new RegExp(`(?:^|\\n)(?:\\d{4}-\\d{2}-\\d{2}T[^ \\n]+\\s+)?Commit (${SHA}) is already tagged '(${VERSION})'\\. No patch tag is required\\.`, 'g');
  const aligned = new RegExp(`Completed\\. Branch '([^'\\r\\n]+)' and tag '(${VERSION})' are aligned to (${SHA})\\.`, 'g');
  const alignments = [...text.matchAll(aligned)];
  const branchLines = [...text.matchAll(/(?:Release branch: |Created branch ')([^'\r\n]+)/g)];
  for (const match of text.matchAll(created)) {
    const version = match[1], commit = match[2].toLowerCase();
    const alignment = alignments.find(item => item[2] === version && item[3].toLowerCase() === commit);
    const branch = alignment?.[1] || branchLines.at(-1)?.[1] || null;
    found.push({ version, series: version.split('.').slice(0, 2).join('.'), commit,
      branch: branch ? branch.replace(/^refs\/heads\//, '') : null, outcome: 'created', confidence: 'recorded' });
  }
  for (const match of text.matchAll(present)) {
    found.push({ version: match[2], series: match[2].split('.').slice(0, 2).join('.'), commit: match[1].toLowerCase(),
      branch: null, outcome: 'already-present', confidence: 'recorded' });
  }
  return [...new Map(found.map(item => [`${item.version}:${item.commit}:${item.outcome}`, item])).values()];
}

export function parseQaRunEvidence(logText) {
  const text = String(logText || '').split(/\r?\n/).map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '')).join('\n');
  // The CLI can surround its JSON response with task banners. Scan balanced JSON
  // objects while respecting quoted strings rather than grabbing the last run-like ID.
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < text.length; end += 1) {
      const char = text[end];
      if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        try {
          const data = JSON.parse(text.slice(start, end + 1));
          const id = Number(data.id), pipelineId = Number(data.pipeline?.id || data.definition?.id);
          if (Number.isSafeInteger(id) && id > 0 && Number.isSafeInteger(pipelineId) && pipelineId > 0) {
            const link = { id, pipelineId };
            // Pipeline Run and Build queue responses name these fields differently.
            // Keep the child's own timestamps; parent deployment dates are not QA evidence.
            const queuedAt = data.queueTime ?? data.createdDate;
            const finishedAt = data.finishTime ?? data.finishedDate;
            if (typeof queuedAt === 'string') link.queuedAt = queuedAt;
            if (typeof finishedAt === 'string') link.finishedAt = finishedAt;
            if (typeof data.reason === 'string') link.reason = data.reason;
            if (typeof data.keepForever === 'boolean') link.keepForever = data.keepForever;
            if (typeof data.retainedByRelease === 'boolean') link.retainedByRelease = data.retainedByRelease;
            return link;
          }
        } catch { /* A log preamble may contain braces that are not JSON. */ }
        break;
      }
    }
  }
  return null;
}

function findLogRecord(log, records) {
  return records.find(record => record.log?.id != null && String(record.log.id) === String(log.id))
    || records.find(record => log.recordId && record.id === log.recordId)
    || records.find(record => log.recordIdentifier && record.identifier === log.recordIdentifier)
    || records.find(record => log.recordName && record.name === log.recordName);
}

export function successfulQaLinks(detail) {
  const records = detail?.timeline?.records || [];
  const links = [];
  for (const log of detail?.logs || []) {
    const record = findLogRecord(log, records);
    if ((log.recordName || record?.name) !== 'Trigger QA pipeline' || !isSuccess(record)) continue;
    const link = parseQaRunEvidence(log.text);
    if (link) links.push({ link, log });
  }
  return links;
}

function descendantOf(record, ancestor, records) {
  const visited = new Set();
  let current = record;
  while (current?.parentId && !visited.has(current.parentId)) {
    if (current.parentId === ancestor.id) return true;
    visited.add(current.parentId);
    current = records.find(item => item.id === current.parentId);
  }
  return false;
}

function devNamespace(run, detail) {
  const records = detail?.timeline?.records || [];
  const resolver = records.filter(record => /resolve namespace/i.test(record.name || '') || /(?:^|\.)Namespace$/.test(record.identifier || ''));
  const currentResolver = [...resolver].sort((a, b) => attempt(b) - attempt(a) || time(b.startTime || b.finishTime) - time(a.startTime || a.finishTime))[0];
  if (currentResolver && !isSuccess(currentResolver)) return null;
  for (const log of detail?.logs || []) {
    const record = findLogRecord(log, records);
    const isResolver = /resolve namespace/i.test(log.recordName || record?.name || '') || /(?:^|\.)Namespace$/.test(log.recordIdentifier || record?.identifier || '');
    if (!isResolver || !isSuccess(record) || (currentResolver && record.id !== currentResolver.id)) continue;
    const matches = [...String(log.text || '').matchAll(/(?:^|\n)(?:\d{4}-\d{2}-\d{2}T[^ \n]+\s+)?Using namespace: ([a-z0-9-]+)\s*(?=\n|$)/g)];
    const name = matches.at(-1)?.[1];
    if (validNamespace(name)) return { name, confidence: 'recorded', evidence: evidence('Namespace from successful resolver log', logUrl(run, log), 'log') };
  }
  // These are predictable mappings in the existing YAML, not live cluster observations.
  // A failed resolver is deliberately left unknown, including for familiar branches.
  const branch = refBranch(run.sourceRef);
  let name = branch === 'master' ? 'dev' : null;
  if (/^RELEASE\/\d+\.\d+\.x$/.test(branch || '')) name = branch.slice(8).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!validNamespace(name)) return null;
  return { name, confidence: 'inferred', evidence: evidence('Namespace inferred from source branch and existing YAML', run.url, 'inferred') };
}

function matchingEnvironmentRecords(environmentRecords, name, runId) {
  const flattened = [];
  for (const item of environmentRecords || []) {
    if (Array.isArray(item.records)) for (const record of item.records) flattened.push({ ...record, environmentName: record.environmentName || item.environmentName || item.name });
    else flattened.push(item);
  }
  return flattened.filter(record => {
    const environmentName = record.environmentName || record.environment?.name;
    const id = record.owner?.id ?? record.build?.id ?? record.buildId ?? record.runId;
    return String(environmentName || '').toUpperCase() === name && Number(id) === runId;
  });
}

function deploymentFor(run, stage, record, envName, namespace, envRecords) {
  const source = record || stage;
  const items = [evidence(record ? 'DeployChart job result in ADO' : 'DeployChart stage result in ADO', recordUrl(run, source))];
  if (namespace?.evidence) items.push(namespace.evidence);
  if (envRecords.length) items.push(evidence('Matching ADO Environment deployment record', run.url, 'environment'));
  return {
    runId: run.id, version: taggedVersion(run.sourceRef) || run.buildNumber,
    versionKind: taggedVersion(run.sourceRef) ? 'release-tag' : 'build-number', sourceRef: run.sourceRef,
    commit: run.commit, status: recordStatus(source), startedAt: source.startTime || null,
    finishedAt: source.finishTime || null, url: run.url, evidence: items,
    attempt: attempt(source), namespace: namespace?.name || null, environment: envName,
    namespaceConfidence: namespace?.confidence || (envName === 'DEV' ? null : 'configured'),
  };
}

function compareDeployments(a, b, runsById) {
  // Queue time orders unstarted attempts only; it is never displayed as a deployment time.
  const aTime = time(a.startedAt || a.finishedAt) || time(runsById.get(a.runId)?.queuedAt);
  const bTime = time(b.startedAt || b.finishedAt) || time(runsById.get(b.runId)?.queuedAt);
  return bTime - aTime || b.attempt - a.attempt || b.runId - a.runId;
}

function lastStates(deployments, runsById) {
  const sorted = [...deployments].sort((a, b) => compareDeployments(a, b, runsById));
  const successes = sorted.filter(item => item.status === 'succeeded').sort((a, b) => time(b.finishedAt || b.startedAt) - time(a.finishedAt || a.startedAt) || b.attempt - a.attempt);
  return { lastSuccess: successes[0] || null, latestAttempt: sorted[0] || null };
}

function versionDescending(a, b) {
  const left = a.version.split('.').map(BigInt), right = b.version.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) { if (left[index] !== right[index]) return left[index] > right[index] ? -1 : 1; }
  return time(b.observedAt) - time(a.observedAt);
}

function matchingCommit(left, right) {
  const pattern = new RegExp(`^${SHA}$`);
  return pattern.test(String(left || '')) && pattern.test(String(right || '')) && left.toLowerCase() === right.toLowerCase();
}

function matchesRelease(run, candidate, kindById) {
  return kindById.get(run.id) === 'release' && run.sourceRef === `refs/tags/${candidate.version}`
    && matchingCommit(run.commit, candidate.commit);
}

function newestStage(records, identifier) {
  return records.filter(record => record.type === 'Stage' && record.identifier === identifier)
    .sort((a, b) => attempt(b) - attempt(a) || time(b.finishTime || b.startTime) - time(a.finishTime || a.startTime))[0];
}

function progressForRun(run, environment, deployments, detail, runsById) {
  const records = detail?.timeline?.records || [];
  const states = lastStates(deployments, runsById);
  const target = newestStage(records, `${environment}_DeployChart`);
  const current = states.latestAttempt;
  const observation = (status, label, text, record = target, event = current) => ({
    status, label, detail: text, runId: run.id, url: run.url,
    evidence: event?.evidence || [evidence(record ? `ADO stage: ${record.name || record.identifier}` : 'Matching ADO pipeline run', record ? recordUrl(run, record) : run.url, record ? 'timeline' : 'run')],
    orderTime: time(event?.finishedAt || event?.startedAt) || time(record?.finishTime || record?.startTime) || time(run.queuedAt),
  });
  if (!records.length && detail?.validationFailed) return observation('failed', 'Failed', 'Pipeline validation failed before any deployment started.', null, null);
  if (!records.length) return observation('unknown', 'Unknown', 'A matching run exists, but its timeline is unavailable in this snapshot.', null, null);
  if (environment === 'DEV' && !deployments.length) return observation('unknown', 'Unknown', 'A run for this exact commit exists, but retained evidence does not confirm its DEV deployment and resolved namespace.', null, null);
  if (current?.status === 'succeeded') return observation('deployed', environment === 'DEV' ? 'Commit deployed' : 'Deployed', environment === 'DEV'
    ? `This exact commit was deployed to DEV namespace ${current.namespace}. This establishes commit deployment, not deployment of the release tag.`
    : 'ADO records a successful deployment of this exact release tag and commit.');
  if (current?.status === 'failed') return observation('failed', 'Failed', 'The latest recorded deployment attempt failed.');
  if (current?.status === 'canceled' || current?.status === 'cancelled') return observation('canceled', 'Canceled', 'The latest recorded deployment attempt was canceled.');
  if (current?.status === 'inProgress' || (target?.state === 'inProgress' && target?.result !== 'skipped')) return observation('deploying', 'Deploying', environment === 'DEV'
    ? 'Deployment of this exact commit is in progress in DEV.' : 'Deployment of this release tag and commit is in progress.');
  if (current && !['pending', 'notStarted', 'skipped'].includes(current.status)) return observation('unknown', 'Unknown', `ADO reports ${current.status}; a completed successful deployment cannot be established.`);

  // Approval is inferred only from an active named gate and an unstarted target.
  // A pending target stage alone could simply be waiting on earlier deployment work.
  const gateName = environment === 'PRE' ? 'GateToPRE' : environment === 'PRD' ? 'GateToPRD' : null;
  const recordedGate = gateName ? newestStage(records, gateName) : null;
  const gate = recordedGate && (!target || attempt(recordedGate) >= attempt(target)) ? recordedGate : null;
  const targetStarted = Boolean(current?.startedAt || (target?.startTime && target.result !== 'skipped'));
  if (!targetStarted && gate?.state === 'inProgress') return observation('awaiting-approval', 'Awaiting approval', `The ${environment} approval gate is active; deployment to ${environment} has not started.`, gate, null);
  if (!targetStarted && ['failed', 'canceled'].includes(gate?.result)) return observation('blocked', 'Blocked', `The ${environment} approval gate ${gate.result === 'failed' ? 'failed' : 'was canceled'} before this environment deployed.`, gate, null);

  const currentStages = [...new Set(records.filter(record => record.type === 'Stage').map(record => record.identifier))].map(identifier => newestStage(records, identifier));
  const ownStages = currentStages.filter(record => record.identifier?.startsWith(`${environment}_`) || (environment === 'DEV' && record.identifier === 'ConfigureDeployment'));
  const failedPreparation = ownStages.filter(record => record.result === 'failed').sort((a, b) => time(b.finishTime) - time(a.finishTime))[0];
  if (failedPreparation) return observation('failed', 'Failed', `Deployment preparation for ${environment} failed before the application deployment completed.`, failedPreparation, null);
  const runningPreparation = ownStages.find(record => record.state === 'inProgress');
  if (runningPreparation) return observation('deploying', 'Deploying', `Deployment preparation for ${environment} is in progress; the application deployment has not completed.`, runningPreparation, null);

  const earlier = environment === 'PRE' ? ['TST'] : environment === 'PRD' ? ['TST', 'PRE'] : [];
  const priorStages = environment === 'TST' ? ['ValidateTaggedSource']
    : environment === 'PRE' ? ['ValidateTaggedSource', 'TriggerQAAutomation', 'GateToPRE']
      : environment === 'PRD' ? ['ValidateTaggedSource', 'TriggerQAAutomation', 'GateToPRE', 'GateToPRD'] : [];
  const upstreamFailure = currentStages.find(record => record.result === 'failed'
    && (earlier.some(name => record.identifier?.startsWith(`${name}_`)) || priorStages.includes(record.identifier))
    && (record.identifier !== gateName || record === gate));
  if (upstreamFailure) return observation('blocked', 'Blocked', `An earlier release stage failed, so ${environment} has not started.`, upstreamFailure, null);
  if (run.result === 'canceled' || run.result === 'cancelled') return observation('canceled', 'Canceled', `This matching pipeline run was canceled before ${environment} deployed.`, target, null);
  if (!target) return observation('unknown', 'Unknown', `The matching run's loaded timeline has no recognized ${environment} deployment stage.`, null, null);
  return observation('not-started', 'Not started', target.result === 'skipped'
    ? `ADO skipped ${environment} in this run. No deployment is established by this stage.`
    : `${environment} has not started in this run. A pending stage does not establish an approval wait.`, target, null);
}

function candidateProgress(candidate, runs, allDeployments, getDetail, runsById, kindById) {
  return CANONICAL.map(environment => {
    const dev = environment === 'DEV';
    const matchingRuns = runs.filter(run => !isAbandonedRun(run) && (dev
      ? kindById.get(run.id) === 'dev' && matchingCommit(run.commit, candidate.commit)
      : matchesRelease(run, candidate, kindById)));
    const empty = { environment, status: 'not-recorded', label: 'No record',
      detail: dev ? 'No non-abandoned DEV run for this exact commit is present in the loaded ADO history. Older runs may be outside this snapshot.'
        : 'No non-abandoned deployment run for this exact release tag and commit is present in the loaded ADO history. Older runs may be outside this snapshot.',
      lastSuccess: null, latestAttempt: null, evidence: [], matchedBy: null };
    if (!matchingRuns.length) return empty;
    const matchingIds = new Set(matchingRuns.map(run => run.id));
    const deployments = allDeployments.filter(item => item.environment === environment && matchingIds.has(item.runId)
      && (!dev || (validNamespace(item.namespace) && item.namespaceConfidence === 'recorded')));
    const states = lastStates(deployments, runsById);
    const observations = matchingRuns.map(run => progressForRun(run, environment, deployments.filter(item => item.runId === run.id), getDetail(run.id), runsById));
    observations.sort((a, b) => b.orderTime - a.orderTime || b.runId - a.runId);
    // A later pending/skipped run does not remove an established successful
    // deployment. Active work, failures and missing evidence remain visible.
    const chosen = observations.find(item => item.status !== 'not-started') || observations[0];
    const { orderTime, ...display } = chosen;
    const historical = states.lastSuccess && display.status !== 'deployed';
    const evidenceItems = [...display.evidence, ...(historical ? states.lastSuccess.evidence : [])];
    return { ...empty, ...display, ...states, matchedBy: dev ? 'commit' : 'tag-and-commit',
      detail: `${display.detail}${historical ? ` An earlier successful ${dev ? 'commit ' : ''}deployment is also recorded.` : ''}`,
      evidence: [...new Map(evidenceItems.map(item => [`${item.label}:${item.url}`, item])).values()] };
  });
}

export function buildDashboard({ builds = [], details = new Map(), environments = [], environmentRecords = [], organization = '', project = '', fetchedAt = new Date().toISOString(), limits = {}, warnings = [], qaAvailability = new Map() } = {}) {
  const runs = builds.map(build => normalizeRun(build, organization, project)).sort((a, b) => time(b.queuedAt) - time(a.queuedAt));
  const runsById = new Map(runs.map(run => [run.id, run]));
  const kindById = new Map(builds.map(build => [Number(build.id), build._kind]));
  const getDetail = id => details instanceof Map ? (details.get(id) || details.get(String(id))) : details[id];
  const allDeployments = [];
  const namespaceInfo = new Map();
  const releaseCandidates = [];
  let missingTimelines = 0, unknownNamespaces = 0, inferredNamespaces = 0;

  for (const run of runs) {
    const detail = getDetail(run.id);
    const records = detail?.timeline?.records || [];
    const kind = builds.find(build => Number(build.id) === run.id)?._kind;
    run.stages = records.filter(record => record.type === 'Stage').map(record => ({
      name: record.name || record.identifier, identifier: record.identifier || null, status: recordStatus(record),
      startedAt: record.startTime || null, finishedAt: record.finishTime || null, attempt: attempt(record),
    }));
    run.qaLinks = [];
    // Validation failures have no execution history to lose or namespace to
    // infer. Keep the failed summary without treating it as a coverage gap.
    if (!records.length && detail?.validationFailed) continue;
    if (!records.length && ['create', 'dev', 'release'].includes(kind)) missingTimelines += 1;
    if (kind === 'create') {
      for (const log of detail?.logs || []) {
        const record = findLogRecord(log, records);
        if ((log.recordName || record?.name) !== 'Create release branch or next patch tag') continue;
        // A successful recorded task is preferred. Older retained runs may have only
        // successful job records, which still bound the exact post-push log evidence.
        const job = records.find(item => item.type === 'Job' && /(?:^|\.)CreateBranchAndTag(?:\.|$)/.test(item.identifier || ''));
        if (!(isSuccess(record) || (!record && isSuccess(job))) || run.result !== 'succeeded' || isAbandonedRun(run)) continue;
        for (const item of parseReleaseEvidence(log.text)) releaseCandidates.push({
          ...item, branch: item.branch || refBranch(run.sourceRef), observedAt: record?.finishTime || job?.finishTime || run.finishedAt,
          runId: run.id, url: run.url, evidence: [evidence(item.outcome === 'created' ? 'Successful tag creation log' : 'Successful existing-tag check log', logUrl(run, log), 'log')],
        });
      }
    }
    for (const { link: child, log } of successfulQaLinks(detail)) {
      const childRun = runsById.get(child.id);
      run.qaLinks.push({ ...child, status: childRun?.status || 'unknown', result: childRun?.result || null,
        abandonment: childRun?.abandonment || null,
        ...(!childRun && qaAvailability.has(child.id) ? { availability: qaAvailability.get(child.id) } : {}),
        url: childRun?.url || runUrl({ id: child.id }, organization, project), revisionVerified: false,
        evidence: [evidence('QA run ID from successful queue task', logUrl(run, log), 'log')] });
    }
    if (!['dev', 'release'].includes(kind)) continue;
    const dev = kind === 'dev';
    const ns = dev ? devNamespace(run, detail) : null;
    if (dev && !ns) unknownNamespaces += 1;
    if (dev && ns?.confidence === 'inferred') inferredNamespaces += 1;
    if (dev && ns && !namespaceInfo.has(ns.name)) namespaceInfo.set(ns.name, { name: ns.name, kind: ns.name === 'dev' ? 'canonical' : /^refs\/heads\/RELEASE\//.test(run.sourceRef || '') ? 'release' : 'branch', branch: refBranch(run.sourceRef), confidence: ns.confidence });
    for (const envName of dev ? ['DEV'] : ['TST', 'PRE', 'PRD']) {
      const stages = records.filter(record => record.type === 'Stage' && record.identifier === `${envName}_DeployChart`);
      for (const stage of stages) {
        // Skipped stages did not attempt a deployment. They remain visible in run details.
        if (stage.result === 'skipped') continue;
        const jobs = records.filter(record => record.type === 'Job' && /(?:^|\.)DeployChart(?:\.|$)/.test(record.identifier || '') && descendantOf(record, stage, records));
        const namespace = dev ? ns : { name: envName.toLowerCase(), confidence: 'configured' };
        const matched = matchingEnvironmentRecords(environmentRecords, envName, run.id);
        for (const job of jobs) allDeployments.push(deploymentFor(run, stage, job, envName, namespace, matched));
        if (!jobs.length || !jobs.some(job => attempt(job) >= attempt(stage))) allDeployments.push(deploymentFor(run, stage, null, envName, namespace, matched));
      }
    }
  }

  const releasesByIdentity = new Map();
  // Prefer actual creation evidence over later verified no-ops for the same tag+SHA.
  for (const candidate of releaseCandidates.sort((a, b) => time(a.observedAt) - time(b.observedAt))) {
    const key = `${candidate.version}:${candidate.commit}`;
    const existing = releasesByIdentity.get(key);
    if (!existing || (existing.outcome !== 'created' && candidate.outcome === 'created')) releasesByIdentity.set(key, candidate);
  }
  const releases = [...releasesByIdentity.values()].filter(candidate => {
    const releaseRuns = runs.filter(run => matchesRelease(run, candidate, kindById));
    // Keep newly created tags that have no release run yet, and any candidate
    // with a remaining active, failed or completed attempt. Historical canceled
    // runs still belong in the overview and pipeline history.
    return !releaseRuns.length || releaseRuns.some(run => !isAbandonedRun(run));
  }).sort(versionDescending);
  for (const release of releases) release.progress = candidateProgress(release, runs, allDeployments, getDetail, runsById, kindById);
  const envRows = CANONICAL.map(name => ({ name, namespace: name.toLowerCase(), ...lastStates(allDeployments.filter(item => item.environment === name && item.namespace === name.toLowerCase()), runsById) }));
  const namespaces = [...namespaceInfo.values()].map(item => ({ ...item, ...lastStates(allDeployments.filter(deployment => deployment.environment === 'DEV' && deployment.namespace === item.name), runsById) })).sort((a, b) => a.name === 'dev' ? -1 : b.name === 'dev' ? 1 : a.name.localeCompare(b.name));
  const warningRows = [...warnings];
  if (missingTimelines) warningRows.push({ code: 'TIMELINE_COVERAGE', message: `${missingTimelines} run(s) have no loaded timeline; deployment and release evidence may be incomplete.` });
  if (unknownNamespaces) warningRows.push({ code: 'UNKNOWN_DEV_NAMESPACE', message: `${unknownNamespaces} DEV run(s) have no reliable namespace mapping and are excluded from namespace state.` });
  if (inferredNamespaces) warningRows.push({ code: 'INFERRED_DEV_NAMESPACE', message: `${inferredNamespaces} DEV namespace mapping(s) are inferred from branch naming because a successful resolver log was unavailable.` });
  if (limits.truncated || limits.buildsTruncated || limits.logsTruncated) warningRows.push({ code: 'BOUNDED_HISTORY', message: 'The loaded history is bounded; an older successful deployment or release may be outside this snapshot.' });
  if (releases.some((release, index) => releases.slice(index + 1).some(other => release.version === other.version && release.commit !== other.commit))) warningRows.push({ code: 'RELEASE_TAG_CONFLICT', message: 'A release version was observed at different commits. Both records are shown; the current Git tag cannot be verified through historical ADO logs alone.' });

  return {
    readOnly: true, mode: 'live', organization, project, fetchedAt, limits, warnings: warningRows,
    coverage: [
      { label: 'Deployment history', status: allDeployments.length ? (missingTimelines ? 'partial' : 'available') : 'unavailable', detail: 'ADO job and stage results show recorded deployments, including successes within unfinished release runs. They do not report current cluster health.' },
      { label: 'Release candidates', status: releases.length ? 'partial' : 'unavailable', detail: 'Candidates come from successful retained tag-creation logs. Deleted logs and tags created outside these pipelines are not covered.' },
      { label: 'DEV namespaces', status: namespaces.length ? 'partial' : 'unavailable', detail: 'Namespaces are reconstructed from successful resolver logs or explicitly marked branch inference. This is deployment history, not a live namespace inventory.' },
      { label: 'ADO Environments', status: environments.length ? 'available' : 'unavailable', detail: 'Environment records corroborate matching manifest runs only; unrelated deployments are excluded.' },
      { label: 'Runtime health', status: 'unavailable', detail: 'This read-only ADO prototype does not query Kubernetes or establish what is currently running.' },
      { label: 'QA revision assurance', status: 'unavailable', detail: 'A queued or passing QA run alone does not prove it tested the exact deployed manifest commit.' },
    ],
    environments: envRows, namespaces, releases, runs,
  };
}
