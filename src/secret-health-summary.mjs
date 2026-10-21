const ENVIRONMENTS = ['dev', 'tst', 'pre', 'prd'];
const STATUSES = ['OK', 'EXPIRING_SOON', 'EXPIRED', 'NO_EXPIRY', 'DISABLED', 'NOT_YET_VALID',
  'MISSING_SECRET', 'MISSING_CERTIFICATE', 'INVALID_METADATA', 'READ_ERROR'];
const UNREADABLE = new Set(['MISSING_SECRET', 'MISSING_CERTIFICATE', 'INVALID_METADATA', 'READ_ERROR']);
const DAY = 86400000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  // Date.parse silently rolls impossible dates such as February 30 forward.
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number.isFinite(Date.parse(value));
}
const validCommit = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

export function unavailableSecretHealth(detail = 'No secret and certificate report is available.') {
  return { state: 'unavailable', colour: 'grey', checkedAt: null, detail, counts: null,
    stale: false, runId: null, url: null, fingerprintMismatches: 0, fingerprintUnknown: 0 };
}

// Only compact, validated metadata leaves this normalizer. Never forward secret
// names, client IDs, fingerprints, source-store names or raw reporting errors.
export function normalizeSecretExpiryReport(report, build, { now = Date.now() } = {}) {
  if (!object(report) || report.schemaVersion !== 1 || typeof report.complete !== 'boolean'
    || !validCommit(report.sourceCommit) || !validCommit(build?.sourceVersion)
    || report.sourceCommit.toLowerCase() !== build.sourceVersion.toLowerCase()
    || report.sourceRef !== 'refs/heads/master' || report.sourceRef !== build.sourceBranch
    || !timestamp(report.checkedAt) || Date.parse(report.checkedAt) > now + 300000
    || !Array.isArray(report.environments) || !report.environments.length
    || report.environments.some(env => !ENVIRONMENTS.includes(env))
    || new Set(report.environments).size !== report.environments.length
    || !Array.isArray(report.reports) || !Array.isArray(report.secrets)
    || report.reports.length !== report.environments.length
    || new Set(report.reports.map(entry => entry?.environment)).size !== report.reports.length
    || report.reports.some(entry => !object(entry) || !report.environments.includes(entry.environment))
    || report.secrets.some(row => !object(row) || !report.environments.includes(row.environment))) return null;

  const environments = {};
  for (const env of report.environments) {
    const entry = report.reports.find(item => item.environment === env);
    const rows = report.secrets.filter(row => row.environment === env);
    const summary = unavailableSecretHealth('The environment report is missing or invalid.');
    environments[env.toUpperCase()] = summary;
    if (entry.status !== 'AVAILABLE' || typeof entry.complete !== 'boolean'
      || !timestamp(entry.checkedAt) || Date.parse(entry.checkedAt) > Date.parse(report.checkedAt)
      || !Number.isSafeInteger(entry.secretCount) || entry.secretCount !== rows.length || !rows.length) continue;

    const identities = new Set();
    let valid = true;
    for (const row of rows) {
      const identity = `${row.itemType || 'secret'}:${row.secretName}`;
      if (typeof row.secretName !== 'string' || !row.secretName.trim() || identities.has(identity)
        || !['secret', 'certificate'].includes(row.itemType || 'secret') || !STATUSES.includes(row.status)
        || typeof row.inUse !== 'boolean' || !timestamp(row.checkedAt)
        || Date.parse(row.checkedAt) !== Date.parse(entry.checkedAt)
        || (row.expiresAt !== null && !timestamp(row.expiresAt))
        || (row.certificateRole != null && !['canonical', 'application', 'identity-redirect'].includes(row.certificateRole))
        || (row.fingerprintStatus != null && !['REFERENCE', 'MATCH', 'MISMATCH', 'UNKNOWN'].includes(row.fingerprintStatus))) {
        valid = false;
        break;
      }
      identities.add(identity);
    }
    if (!valid) continue;

    const counts = { green: 0, amber: 0, red: 0 };
    for (const row of rows) {
      const remaining = Date.parse(row.expiresAt) - Date.parse(row.checkedAt);
      const colour = !row.expiresAt || UNREADABLE.has(row.status) ? 'amber'
        : remaining > 60 * DAY ? 'green' : remaining >= 30 * DAY ? 'amber' : 'red';
      counts[colour] += 1;
    }
    const fingerprintMismatches = rows.filter(row => row.itemType === 'certificate'
      && ['application', 'identity-redirect'].includes(row.certificateRole) && row.fingerprintStatus === 'MISMATCH').length;
    const fingerprintUnknown = rows.filter(row => row.itemType === 'certificate'
      && ['application', 'identity-redirect'].includes(row.certificateRole) && row.fingerprintStatus !== 'MATCH'
      && row.fingerprintStatus !== 'MISMATCH').length;
    const complete = entry.complete && !rows.some(row => UNREADABLE.has(row.status))
      && rows.some(row => row.itemType === 'certificate') && rows.some(row => (row.itemType || 'secret') === 'secret')
      && fingerprintUnknown === 0;
    const stale = now - Date.parse(entry.checkedAt) > 48 * 60 * 60 * 1000;
    const colour = counts.red ? 'red' : counts.amber || !complete || stale ? 'amber' : 'green';
    const detail = [
      counts.red ? `${counts.red} ${counts.red === 1 ? 'item expires' : 'items expire'} in fewer than 30 days, including expired items.`
        : counts.amber ? `${counts.amber} ${counts.amber === 1 ? 'item has' : 'items have'} 30–60 days remaining or no verified expiry.`
          : 'All reported expiry dates are more than 60 days away.',
      !complete ? 'Coverage is incomplete.' : '',
      stale ? 'This report is over 48 hours old.' : '',
    ].filter(Boolean).join(' ');
    environments[env.toUpperCase()] = { ...summary, state: complete ? 'complete' : 'partial',
      colour, checkedAt: entry.checkedAt, detail, counts, stale, fingerprintMismatches, fingerprintUnknown };
  }
  return { environments };
}
