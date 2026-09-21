const DAY = 24 * 60 * 60 * 1000;
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const NORMAL_RUN_REASONS = new Set(['manual', 'individualCI', 'batchedCI', 'schedule', 'scheduleForced',
  'userCreated', 'validateShelveset', 'checkInShelveset', 'buildCompletion', 'resourceTrigger', 'triggered']);

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  // Date.parse normalizes impossible calendar days such as February 30.
  const calendarDay = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}

export function normalizeRetentionPolicy(raw) {
  const runDays = raw?.purgeRuns?.value;
  const pullRequestDays = raw?.purgePullRequestRuns?.value;
  const minimumRuns = raw?.retainRunsPerProtectedBranch?.value;
  return positiveInteger(runDays) && positiveInteger(pullRequestDays) && nonnegativeInteger(minimumRuns)
    ? { runDays, pullRequestDays, minimumRuns } : null;
}

// The caller must establish that the linked QA lookup returned 404. Age and
// current settings provide context, never proof of the reason for deletion.
export function inferQaRetention(evidence, policy, { now = Date.now(), runs = [] } = {}) {
  if (!evidence || !positiveInteger(evidence.id) || !positiveInteger(evidence.pipelineId)
    || !positiveInteger(policy?.runDays) || !positiveInteger(policy?.pullRequestDays)
    || !nonnegativeInteger(policy?.minimumRuns)) return null;
  if (evidence.keepForever === true || evidence.retainedByRelease === true) return null;

  const currentTime = typeof now === 'number' ? now : timestamp(now);
  if (!Number.isFinite(currentTime) || !Number.isFinite(new Date(currentTime).getTime())) return null;
  const hasQueue = evidence.queuedAt != null;
  const hasFinish = evidence.finishedAt != null;
  const queued = hasQueue ? timestamp(evidence.queuedAt) : null;
  const finished = hasFinish ? timestamp(evidence.finishedAt) : null;
  if ((!hasQueue && !hasFinish) || (hasQueue && (!Number.isFinite(queued) || queued > currentTime))
    || (hasFinish && (!Number.isFinite(finished) || finished > currentTime))
    || (hasQueue && hasFinish && finished < queued)) return null;

  const reference = hasFinish ? finished : queued;
  const retentionDays = evidence.reason === 'pullRequest' ? policy.pullRequestDays
    : NORMAL_RUN_REASONS.has(evidence.reason) ? policy.runDays : Math.max(policy.runDays, policy.pullRequestDays);
  if (currentTime - reference <= retentionDays * DAY) return null;

  // For GitHub-backed pipelines the recent-run minimum applies across branches.
  // Count distinct completed successes only, and require their queue times to
  // postdate our reference. A bounded scan must not pretend it has full history.
  const newerRuns = new Set();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!positiveInteger(run?.id) || run.id === evidence.id || run.definition?.id !== evidence.pipelineId
      || run.status !== 'completed' || !['succeeded', 'partiallySucceeded'].includes(run.result)
      || run.deleted === true) continue;
    const queuedAt = timestamp(run.queueTime);
    const finishedAt = timestamp(run.finishTime);
    if (Number.isFinite(queuedAt) && Number.isFinite(finishedAt) && queuedAt > reference
      && finishedAt >= queuedAt && finishedAt <= currentTime) newerRuns.add(run.id);
  }
  if (newerRuns.size < policy.minimumRuns) return null;

  const ageDays = Math.floor((currentTime - reference) / DAY);
  const ageBasis = hasFinish ? 'finished' : 'queued';
  const detail = `${hasFinish ? 'Finished' : 'Queued'} ${ageDays} ${ageDays === 1 ? 'day' : 'days'} ago; the current run retention period is ${retentionDays} ${retentionDays === 1 ? 'day' : 'days'}.`
    + (hasFinish ? '' : ' Finish time is unavailable, so this is an estimate.')
    + ' ADO no longer returns this run and does not confirm why it was removed.';
  return { status: 'past-retention', label: hasFinish ? 'Past retention window' : 'Likely past retention window',
    detail, retentionDays, ageDays, ageBasis, minimumRuns: policy.minimumRuns };
}
