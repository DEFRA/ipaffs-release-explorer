const NAMESPACE = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const UID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const CREATED_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)\s+namespace\/([a-z0-9-]+) created\s*$/;
const UNAVAILABLE = 'The current namespace creator is not established by retained creation logs and a first-attempt manual run requester.';

function timestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const parsed = Date.parse(value);
  // Date.parse normalizes some impossible calendar dates rather than rejecting them.
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19) ? parsed : null;
}

function firstAttempt(task, records) {
  if (Number(task.attempt) !== 1) return false;
  const seen = new Set([task.id]);
  let current = task;
  let job = false, stage = false;
  while (current.parentId) {
    if (seen.has(current.parentId)) return false;
    seen.add(current.parentId);
    const parents = records.filter(record => record.id === current.parentId);
    if (parents.length !== 1) return false;
    current = parents[0];
    if (['Job', 'Stage'].includes(current.type)) {
      if (Number(current.attempt) !== 1) return false;
      job ||= current.type === 'Job';
      stage ||= current.type === 'Stage';
    }
  }
  // Without the enclosing execution records, a missing retry actor remains unknown.
  return job && stage;
}

function taskForLog(log, records) {
  const hasId = log?.id !== undefined && log.id !== null;
  const hasRecord = typeof log?.recordId === 'string' && Boolean(log.recordId);
  if (!hasId && !hasRecord) return null;
  const matches = records.filter(record => record.type === 'Task'
    && (!hasId || String(record.log?.id) === String(log.id))
    && (!hasRecord || record.id === log.recordId));
  return matches.length === 1 ? matches[0] : null;
}

function creationEvents(run, detail) {
  const records = Array.isArray(detail?.timeline?.records) ? detail.timeline.records : [];
  const events = [];
  for (const log of Array.isArray(detail?.logs) ? detail.logs : []) {
    const task = taskForLog(log, records);
    if (!task || !['Resolve namespace', 'Create namespace'].includes(task.name)
      || task.state !== 'completed' || task.result === 'skipped') continue;
    const startedAt = timestamp(task.startTime), finishedAt = timestamp(task.finishTime);
    const logId = Number(task.log?.id ?? log.id);
    if (startedAt === null || finishedAt === null || startedAt > finishedAt
      || !Number.isSafeInteger(logId) || logId <= 0) continue;
    for (const line of String(log.text || '').split(/\r?\n/)) {
      const match = line.match(CREATED_LINE);
      if (!match || !NAMESPACE.test(match[2])) continue;
      const observedAt = timestamp(match[1]);
      if (observedAt === null || observedAt < startedAt || observedAt > finishedAt) continue;
      events.push({ name: match[2], observedAt, startedAt, finishedAt, run,
        firstAttempt: firstAttempt(task, records), logId, taskId: task.id });
    }
  }
  return events;
}

// A retained deployment or mutable owner label cannot identify the first creator.
// Only an explicit create response near the current incarnation's creation time
// can link that incarnation to the original requester of its manual pipeline run.
export function attachNamespaceCreators(dashboard, { details = new Map(), devRunIds = new Set() } = {}) {
  const events = [];
  for (const run of Array.isArray(dashboard.runs) ? dashboard.runs : []) {
    if (!Number.isSafeInteger(run.id) || run.id <= 0 || !devRunIds.has(run.id)) continue;
    const detail = details instanceof Map ? details.get(run.id) ?? details.get(String(run.id))
      : details && Object.hasOwn(details, run.id) ? details[run.id] : null;
    events.push(...creationEvents(run, detail));
  }
  for (const namespace of Array.isArray(dashboard.namespaces) ? dashboard.namespaces : []) {
    const createdTime = timestamp(namespace.runtime?.createdAt);
    const createdAt = createdTime === null ? null : namespace.runtime.createdAt;
    namespace.creator = { status: 'unavailable', name: null, createdAt, runId: null, url: null, detail: UNAVAILABLE, evidence: [] };
    if (!NAMESPACE.test(namespace.name || '') || namespace.runtime?.status !== 'exists'
      || !UID.test(namespace.runtime?.uid || '') || createdTime === null) continue;
    const matches = new Map();
    for (const event of events) {
      // Kubernetes creationTimestamp may have only seconds precision. Allow its
      // fractional second to precede the task start, but require stdout in bounds.
      const rounding = /:\d{2}Z$/.test(createdAt) ? 999 : 0;
      if (event.name !== namespace.name || event.observedAt < createdTime || event.observedAt - createdTime > 5000
        || createdTime < event.startedAt - rounding || createdTime > event.finishedAt) continue;
      const actor = typeof event.run.trigger?.requestedBy === 'string' ? event.run.trigger.requestedBy.trim() : '';
      const key = JSON.stringify([event.run.id, event.taskId, event.logId, event.observedAt, actor, event.firstAttempt]);
      matches.set(key, { ...event, actor });
    }
    if (matches.size !== 1) continue;
    const event = matches.values().next().value;
    if (!event.firstAttempt || String(event.run.trigger?.reason || '').toLowerCase() !== 'manual' || !event.actor
      || typeof event.run.url !== 'string' || !event.run.url) continue;
    const url = `${event.run.url}&view=logs&l=${encodeURIComponent(event.logId)}`;
    namespace.creator = { status: 'recorded', name: event.actor, createdAt, runId: event.run.id, url: event.run.url,
      detail: 'The namespace creation log matches its current creation time. The name identifies the requester of the manual pipeline run that created it.',
      evidence: [{ label: 'Namespace creation recorded in ADO', url, type: 'log' }] };
  }
}
