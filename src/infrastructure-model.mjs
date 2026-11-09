const RELEASE_ENVIRONMENTS = ['TST', 'PRE', 'PRD'];
const APPROVAL_STAGES = { PRE: 'GateToPRE', PRD: 'GateToPRD' };
const DEV_DEPLOYMENTS = new Map([
  ['DeployResourceGroup', 'Deploy - ResourceGroup'],
  ['DeployNetwork', 'Deploy - Network'],
  ['DeployACR', 'Deploy - ACR'],
  ['DeployClassic', 'Deploy - Classic'],
  ['DeployInfrastructure', 'Deploy - Infrastructure'],
  ['PrivateLink', 'Deploy - PrivateLink'],
]);

const commitOf = ({ sourceVersion }) => typeof sourceVersion === 'string' && /^[a-f\d]{40}$/i.test(sourceVersion) ? sourceVersion.toLowerCase() : null;
const validRun = run => Number.isSafeInteger(run?.build?.id) && run.build.id > 0;
const time = value => Date.parse(value) || 0;
const started = record => time(record?.startTime);
const finished = record => time(record?.finishTime);
const eventTime = record => finished(record) || started(record);
const attempt = record => Number(record.attempt) || 1;
const byRunRecency = (a, b) => time(b.build.queueTime) - time(a.build.queueTime) || b.build.id - a.build.id;
const byStageRecency = (a, b) => eventTime(b) - eventTime(a);
const bySuccessRecency = (a, b) => time(b.at) - time(a.at) || b.runId - a.runId;
const completed = record => record?.state === 'completed' && record.result === 'succeeded';
const canceled = record => ['canceled', 'cancelled', 'abandoned'].includes(record?.result) || ['canceled', 'cancelled', 'abandoned', 16].includes(record?.status);

export function infrastructureTag(sourceBranch) {
  return typeof sourceBranch === 'string'
    ? /^refs\/tags\/([1-9][0-9]*(?:\.(?:0|[1-9][0-9]*))?)$/.exec(sourceBranch)?.[1] ?? null
    : null;
}

function evidence(build, record, base, project, at = record?.finishTime || record?.startTime) {
  const runUrl = new URL(`${base}/${encodeURIComponent(project)}/_build/results`);
  runUrl.searchParams.set('buildId', build.id);
  if (record?.id) {
    runUrl.searchParams.set('view', 'logs');
    runUrl.searchParams.set('j', record.id);
  }
  return { at: time(at) ? at : null, runId: build.id, runUrl: runUrl.href, stage: record?.identifier ?? null };
}

function latestStages(records) {
  const stages = new Map();
  for (const record of records) {
    if (record?.type !== 'Stage' || typeof record.identifier !== 'string') continue;
    const prior = stages.get(record.identifier);
    if (!prior || attempt(record) > attempt(prior)
      || (attempt(record) === attempt(prior) && eventTime(record) >= eventTime(prior))) stages.set(record.identifier, record);
  }
  return stages;
}

function noStageStatus(build, records) {
  if (['notStarted', 'postponed'].includes(build.status)) return 'pending';
  if (records === null) return 'unavailable';
  if (canceled(build)) return 'canceled';
  return 'unknown';
}

function stageActivity(stages, completion) {
  for (const stage of [...stages].sort(byStageRecency)) {
    if (stage.state === 'inProgress' && !stage.result) return { status: 'running', stage };
    if (stage.state !== 'completed') continue;
    if (canceled(stage)) return { status: 'canceled', stage };
    if (stage.result === 'failed' || (stage === completion && stage.result === 'succeededWithIssues')) return { status: stage.result, stage };
  }
  return null;
}

function releaseObservation({ build, records }, environment, base, project) {
  const completeStage = `${environment}_Complete`;
  const stages = latestStages(records || []);
  const completion = stages.get(completeStage);
  const ownStages = [...stages.values()].filter(record => record.identifier.startsWith(`${environment}_`));
  const gate = stages.get(APPROVAL_STAGES[environment]);
  const observed = (status, stage, at) => ({ status, ...evidence(build, stage, base, project, at) });
  const successful = (records || []).filter(record => record?.type === 'Stage' && record.identifier === completeStage && completed(record))
    .map(record => evidence(build, record, base, project, record.finishTime || null));

  const activity = stageActivity(ownStages, completion);
  let latest;
  if (completed(completion) && (!activity || eventTime(activity.stage) <= eventTime(completion))) {
    latest = observed('succeeded', completion, completion.finishTime || null);
  } else if (activity) {
    latest = observed(activity.status, activity.stage);
  } else if (gate?.state === 'inProgress' && !gate.result) {
    latest = observed('awaitingApproval', gate);
  } else if (gate?.state === 'completed' && gate.result === 'failed') {
    latest = observed('approvalFailed', gate);
  } else if (canceled(gate) || (canceled(build) && completion?.result !== 'skipped')) {
    latest = observed('canceled', gate || completion);
  } else if (completion?.result === 'skipped') {
    latest = observed('skipped', completion, null);
  } else if (completion?.state === 'pending' || completion?.state === 'notStarted') {
    latest = observed('pending', completion, null);
  } else {
    latest = observed(noStageStatus(build, records), completion, null);
  }
  return { latest, successful };
}

function successfulApplyTask(records, byId, stage, name) {
  if (!completed(stage) || !stage.id) return false;
  const matches = records.filter(record => {
    if (record?.type !== 'Task' || record.name !== name) return false;
    const seen = new Set();
    let ancestor = record;
    while (completed(ancestor) && ancestor.id && !seen.has(ancestor.id)) {
      if (ancestor === stage) return true;
      seen.add(ancestor.id);
      ancestor = byId.get(ancestor.parentId);
    }
    return false;
  });
  return matches.length === 1;
}

export function successfulDevApplyStage({ build, records }, stages = latestStages(records || [])) {
  // Mirror the infrastructure preview's baseline evidence. DEV success alone
  // can describe a run that skipped apply steps or omitted Private Link.
  if (build.status !== 'completed' || build.result !== 'succeeded' || !records) return null;
  const byId = new Map(records.filter(record => record?.id).map(record => [record.id, record]));
  if (byId.size !== records.length
    || ![...DEV_DEPLOYMENTS].every(([stage, task]) => successfulApplyTask(records, byId, stages.get(stage), task))) return null;
  return [...DEV_DEPLOYMENTS.keys()].reverse().map(name => stages.get(name)).sort((a, b) => finished(b) - finished(a))[0];
}

function devObservation(run, base, project) {
  const { build, records } = run;
  const stages = latestStages(records || []);
  const applied = successfulDevApplyStage(run, stages);
  if (applied) {
    const successful = evidence(build, applied, base, project, applied.finishTime || null);
    return { latest: { status: 'succeeded', ...successful }, successful: [successful] };
  }
  const activity = stageActivity([...DEV_DEPLOYMENTS.keys()].map(name => stages.get(name)).filter(Boolean));
  return {
    latest: { status: activity?.status || noStageStatus(build, records), ...evidence(build, activity?.stage, base, project) },
    successful: [],
  };
}

function combine(observations, fallback = 'noEvidence') {
  const latest = observations[0]?.latest || { status: fallback, at: null, runId: null, runUrl: null, stage: null };
  const successful = observations.flatMap(observation => observation.successful).sort(bySuccessRecency)[0] ?? null;
  return { ...latest, successful };
}

export function buildInfrastructureProgress({ releaseRuns, devRuns, base, project, limited = false, devAvailability = 'available' }) {
  const devByCommit = new Map();
  let latestDev = null;
  for (const run of devRuns.filter(validRun).sort(byRunRecency)) {
    const commit = commitOf(run.build);
    if (!commit || run.build.sourceBranch !== 'refs/heads/main' || !Array.isArray(run.build.tags)
      || !run.build.tags.includes('Environment-DEV')) continue;
    if (!devByCommit.has(commit)) devByCommit.set(commit, []);
    const observation = devObservation(run, base, project);
    devByCommit.get(commit).push(observation);
    const [success] = observation.successful;
    if (success && (!latestDev || bySuccessRecency(success, latestDev) < 0)) latestDev = { commit, ...success };
  }

  const releaseByIdentity = new Map();
  for (const run of releaseRuns.filter(validRun).sort(byRunRecency)) {
    const tag = infrastructureTag(run.build.sourceBranch);
    const commit = commitOf(run.build);
    if (!tag || !commit) continue;
    const key = `${tag}:${commit}`;
    if (!releaseByIdentity.has(key)) releaseByIdentity.set(key, { tag, commit, runs: [] });
    releaseByIdentity.get(key).runs.push(run);
  }

  const latestSuccessful = { TST: null, PRE: null, PRD: null };
  const releases = [...releaseByIdentity.values()].map(({ tag, commit, runs }) => {
    const environments = { DEV: combine(devByCommit.get(commit) || [], devAvailability === 'unavailable' ? 'unavailable' : 'noEvidence') };
    for (const environment of RELEASE_ENVIRONMENTS) {
      const cell = combine(runs.map(run => releaseObservation(run, environment, base, project)));
      environments[environment] = cell;
      const previous = latestSuccessful[environment];
      if (cell.successful && (!previous || bySuccessRecency(cell.successful, previous) < 0)) {
        latestSuccessful[environment] = { tag, commit, ...cell.successful };
      }
    }
    return { tag, commit, environments };
  });
  return { availability: 'available', devAvailability, limited, releases, latestSuccessful, latestDev };
}
