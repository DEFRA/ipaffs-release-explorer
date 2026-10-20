const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const DAY = 86400000;
const ENVIRONMENTS = ['DEV', 'TST', 'PRE', 'PRD'];
export const DELIVERY_WINDOWS = [30, 90];

const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const iso = value => value ? new Date(value).toISOString() : null;
const tagged = deployment => deployment?.versionKind === 'release-tag' && VERSION.test(deployment.version)
  && COMMIT.test(deployment.commit) && deployment.sourceRef === `refs/tags/${deployment.version}`;
const identity = item => `${item.version}:${String(item.commit).toLowerCase()}`;

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// One stage attempt can have several DeployChart job records. Count the attempt
// once: any failed job fails it, and success requires every job to succeed.
function stageAttempts(deployments) {
  const attempts = new Map();
  for (const deployment of deployments) {
    if (!ENVIRONMENTS.includes(deployment?.environment) || deployment.namespace !== deployment.environment.toLowerCase()) continue;
    const key = `${deployment.runId}:${deployment.environment}:${deployment.attempt || 1}`;
    if (!attempts.has(key)) attempts.set(key, []);
    attempts.get(key).push(deployment);
  }
  return [...attempts.values()].map(jobs => {
    const statuses = jobs.map(job => String(job.status || '').toLowerCase());
    const status = statuses.includes('failed') ? 'failed'
      : statuses.every(value => value === 'succeeded') ? 'succeeded'
        : statuses.some(value => ['canceled', 'cancelled'].includes(value)) ? 'canceled' : 'other';
    const at = Math.max(...jobs.map(job => time(job.finishedAt) || time(job.startedAt)));
    const first = jobs[0];
    return { environment: first.environment, runId: first.runId, attempt: Number(first.attempt || 1), status, at,
      version: first.version || null, versionKind: first.versionKind || null, sourceRef: first.sourceRef || null,
      commit: first.commit || null, url: first.url || null, tagged: tagged(first) };
  }).filter(item => item.at).sort((a, b) => a.at - b.at || a.runId - b.runId || a.attempt - b.attempt);
}

const reference = item => item ? { at: iso(item.at), runId: item.runId, attempt: item.attempt, url: item.url } : null;

// Pipeline evidence only: deployment outcomes are not production incidents,
// and tag creation is the earliest change time the scanned logs record.
export function deliveryMetrics({ deployments = [], releases = [], coverageStart = null, now = Date.now() } = {}) {
  const attempts = stageAttempts(deployments);
  const prd = attempts.filter(item => item.environment === 'PRD');
  const prdSuccesses = prd.filter(item => item.status === 'succeeded');
  const firstSuccess = (environment, release) => attempts.find(item => item.environment === environment
    && item.status === 'succeeded' && item.tagged && identity(item) === identity(release));

  const created = new Map();
  for (const release of releases) {
    if (release?.outcome !== 'created' || !VERSION.test(release.version) || !COMMIT.test(release.commit) || !time(release.observedAt)) continue;
    const previous = created.get(identity(release));
    if (!previous || time(release.observedAt) < time(previous.observedAt)) created.set(identity(release), release);
  }
  const leadTimes = [];
  const released = new Map();
  for (const success of prdSuccesses.filter(item => item.tagged)) if (!released.has(identity(success))) released.set(identity(success), success);
  for (const [key, firstPrd] of released) {
    const release = created.get(key);
    const createdAt = release ? time(release.observedAt) : 0;
    const row = { version: firstPrd.version, commit: firstPrd.commit.toLowerCase(), firstPrd: reference(firstPrd),
      created: release ? { at: iso(createdAt), runId: release.runId || null, url: release.evidence?.[0]?.url || release.url || null } : null,
      firstTst: reference(firstSuccess('TST', firstPrd)), firstPre: reference(firstSuccess('PRE', firstPrd)),
      leadMs: release && firstPrd.at >= createdAt ? firstPrd.at - createdAt : null };
    leadTimes.push(row);
  }
  leadTimes.sort((a, b) => time(b.firstPrd.at) - time(a.firstPrd.at));

  // Consecutive failures belong to one interruption, measured from the first
  // failure until the next successful PRD deployment of any version.
  const failures = [];
  let open = null;
  for (const item of prd) {
    if (item.status === 'failed') {
      if (open) open.failedAttempts += 1;
      else open = { version: item.version, versionKind: item.versionKind, failed: reference(item), failedAttempts: 1, recovered: null, recoveryMs: null };
    } else if (item.status === 'succeeded' && open) {
      failures.push({ ...open, recovered: { ...reference(item), version: item.version }, recoveryMs: item.at - time(open.failed.at) });
      open = null;
    }
  }
  if (open) failures.push(open);
  failures.sort((a, b) => time(b.failed.at) - time(a.failed.at));

  const rollbacks = [];
  const taggedSuccesses = prdSuccesses.filter(item => item.tagged);
  taggedSuccesses.forEach((item, index) => {
    const previous = taggedSuccesses[index - 1];
    if (previous && compareVersions(item.version, previous.version) < 0) {
      rollbacks.push({ version: item.version, previousVersion: previous.version, deployment: reference(item) });
    }
  });
  rollbacks.sort((a, b) => time(b.deployment.at) - time(a.deployment.at));

  const coverage = time(coverageStart);
  const windows = DELIVERY_WINDOWS.map(days => {
    const from = now - days * DAY;
    const coveredFrom = coverage ? Math.max(from, coverage) : null;
    const coveredDays = coveredFrom === null ? 0 : Math.max(0, (now - coveredFrom) / DAY);
    const inWindow = at => time(at) >= from && time(at) <= now;
    const windowAttempts = attempts.filter(item => item.at >= from && item.at <= now);
    const prdWindow = windowAttempts.filter(item => item.environment === 'PRD');
    const succeeded = prdWindow.filter(item => item.status === 'succeeded').length;
    const failed = prdWindow.filter(item => item.status === 'failed').length;
    const leads = leadTimes.filter(row => inWindow(row.firstPrd.at));
    const leadValues = leads.map(row => row.leadMs).filter(value => value !== null);
    const recoveries = failures.filter(row => inWindow(row.failed.at));
    const recoveryValues = recoveries.map(row => row.recoveryMs).filter(value => value !== null);
    return {
      days, from: iso(from), coveredFrom: iso(coveredFrom), coveredDays: Math.round(coveredDays * 10) / 10,
      partial: coveredFrom === null || coveredFrom > from,
      prd: {
        deployments: succeeded,
        releases: new Set(prdWindow.filter(item => item.status === 'succeeded' && item.tagged).map(identity)).size,
        perWeek: coveredDays >= 1 ? Math.round(succeeded / (coveredDays / 7) * 10) / 10 : null,
      },
      leadTime: { count: leadValues.length, notRecorded: leads.length - leadValues.length, medianMs: median(leadValues),
        minMs: leadValues.length ? Math.min(...leadValues) : null, maxMs: leadValues.length ? Math.max(...leadValues) : null },
      failureRate: { failed, succeeded, rate: failed + succeeded ? failed / (failed + succeeded) : null,
        rollbacks: rollbacks.filter(row => inWindow(row.deployment.at)).length },
      recovery: { count: recoveryValues.length, unresolved: recoveries.length - recoveryValues.length, medianMs: median(recoveryValues) },
      environments: ENVIRONMENTS.map(environment => {
        const rows = windowAttempts.filter(item => item.environment === environment);
        const ok = rows.filter(item => item.status === 'succeeded').length, bad = rows.filter(item => item.status === 'failed').length;
        return { environment, succeeded: ok, failed: bad, canceled: rows.filter(item => item.status === 'canceled').length,
          rate: ok + bad ? bad / (ok + bad) : null };
      }),
    };
  });
  const oldest = now - Math.max(...DELIVERY_WINDOWS) * DAY;
  return {
    generatedAt: iso(now), coverageStart: coverage ? iso(coverage) : null, windows,
    releases: leadTimes.filter(row => time(row.firstPrd.at) >= oldest),
    failures: failures.filter(row => time(row.failed.at) >= oldest),
    rollbacks: rollbacks.filter(row => time(row.deployment.at) >= oldest),
  };
}
