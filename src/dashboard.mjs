import { buildDashboard, successfulQaLinks } from './model.mjs';
import { mapConcurrent } from './ado-client.mjs';
import { normalizeRetentionPolicy, inferQaRetention } from './retention.mjs';

const INTERESTING_LOG = /Resolve namespace|Set Namespace|Create release branch or next patch tag|Create release refs|Trigger QA pipeline|Publish namespace access URLs|Generate namespace URLs/i;

export function createDashboardService(config, client, { now = Date.now } = {}) {
  let cached;
  let pending;
  let lastDetails = new Map();
  let lastBuilds = [];

  async function load() {
    const warnings = [];
    const callsBefore = client.requests;
    const lists = await Promise.all(Object.entries(config.pipelines).map(async ([kind, id]) => ({
      kind,
      ...(await client.list('build/builds', { definitions: id, queryOrder: 'queueTimeDescending' }, config.runsPerPipeline)),
    })));
    const builds = lists.flatMap(list => list.items.map(build => ({ ...build, _kind: list.kind })));
    const relevant = builds.filter(build => build.definition.id !== config.pipelines.qa);
    const details = new Map();
    await mapConcurrent(relevant, 6, async build => {
      try {
        const { data: timeline } = await client.get(`build/builds/${build.id}/timeline`);
        const records = timeline === null ? [] : timeline?.records;
        if (!Array.isArray(records)) throw new Error('Invalid timeline');
        if (!records.length) {
          // A failed run alone may still contain successful deployments. Only
          // explicit request validation errors plus an empty timeline establish
          // that no deployment started. Access/transport errors remain warnings.
          if (build.status === 'completed' && build.result === 'failed'
            && Array.isArray(build.validationResults) && build.validationResults.some(item => item?.result === 'error')) {
            details.set(Number(build.id), { validationFailed: true, timeline: { records: [] }, logs: [] });
            return;
          }
          throw new Error('Timeline unavailable');
        }
        const tasks = records.filter(record => record.type === 'Task' && record.log?.id && INTERESTING_LOG.test(record.name || ''));
        const logs = await mapConcurrent(tasks, 2, async record => {
          try {
            const { data: text } = await client.get(`build/builds/${build.id}/logs/${record.log.id}`, {}, { text: true });
            // Some ADO installations return JSON log lines despite the plain-text Accept header.
            let logText = text;
            try {
              const parsed = JSON.parse(text);
              if (Array.isArray(parsed.value)) logText = parsed.value.join('\n');
            } catch { /* Plain text is the normal response. */ }
            return { id: record.log.id, text: logText, recordId: record.id, recordName: record.name, recordIdentifier: record.identifier };
          } catch {
            warnings.push({ code: 'log_unavailable', message: `A supporting log for run ${build.id} is unavailable; some fields may be unknown.` });
            return null;
          }
        });
        details.set(Number(build.id), { timeline, logs: logs.filter(Boolean) });
      } catch {
        warnings.push({ code: 'timeline_unavailable', message: `Timeline for run ${build.id} is unavailable; its deployment result has not been inferred.` });
        details.set(Number(build.id), { error: 'Timeline unavailable', timeline: { records: [] }, logs: [] });
      }
    });
    const linkedQa = new Map();
    for (const detail of details.values()) {
      for (const { link } of successfulQaLinks(detail)) {
        if (link.pipelineId !== config.pipelines.qa || builds.some(build => build.id === link.id)) continue;
        if (!linkedQa.has(link.id)) linkedQa.set(link.id, []);
        linkedQa.get(link.id).push(link);
      }
    }
    const qaAvailability = new Map();
    const scannedQaRuns = builds.filter(build => build.definition.id === config.pipelines.qa);
    // Optional policy lookup is shared within this scan, then refreshed with the
    // next snapshot. Failure leaves the existing unknown-result explanation intact.
    let retentionPromise;
    const retentionPolicy = () => retentionPromise ||= client.get('build/retention')
      .then(({ data }) => normalizeRetentionPolicy(data)).catch(() => null);
    await mapConcurrent([...linkedQa], 4, async ([id, evidence]) => {
      try {
        const { data: child } = await client.get(`build/builds/${id}`);
        if (child?.definition?.id !== config.pipelines.qa) throw new Error('Unexpected QA pipeline');
        builds.push({ ...child, _kind: 'qa' });
      } catch (error) {
        if (error.code === 'ado_response_error' && error.status === 404) {
          const policy = await retentionPolicy();
          const observations = evidence.map(link => inferQaRetention(link, policy, { now: now(), runs: scannedQaRuns }));
          // Conflicting or incomplete retained logs must not turn an unknown
          // result into a confident age classification.
          if (observations.length && observations.every(Boolean)) {
            const availability = observations.sort((a, b) => (a.ageBasis === 'queued' ? 0 : 1) - (b.ageBasis === 'queued' ? 0 : 1) || a.ageDays - b.ageDays)[0];
            qaAvailability.set(id, availability);
            warnings.push({ code: 'qa_run_past_retention', severity: 'info', message: `Linked QA run ${id}: ${availability.label}. ${availability.detail}` });
            return;
          }
        }
        warnings.push({ code: 'qa_run_unavailable', message: `Linked QA run ${id} is unavailable; its result is unknown.` });
      }
    });
    let environments = [];
    const environmentRecords = [];
    try {
      const response = await client.list('distributedtask/environments', { 'api-version': '7.1-preview.1' }, 100);
      environments = response.items.filter(env => config.environmentNames.includes(env.name));
      await mapConcurrent(environments, 4, async environment => {
        try {
          const records = await client.list(`distributedtask/environments/${environment.id}/environmentdeploymentrecords`, { 'api-version': '7.1-preview.1' }, 20);
          environmentRecords.push(...records.items.map(record => ({ ...record, environmentId: environment.id, environmentName: environment.name })));
        } catch {
          warnings.push({ code: 'environment_history_unavailable', message: `${environment.name} Environment history is unavailable; deployment timelines are used where present.` });
        }
      });
    } catch {
      warnings.push({ code: 'environments_unavailable', message: 'Environment history is unavailable; deployment timelines are used where present.' });
    }
    const fetchedAt = new Date(now()).toISOString();
    const limits = {
      runsPerPipeline: config.runsPerPipeline,
      runCount: builds.length,
      retrievedRuns: builds.length,
      limited: lists.some(list => list.limited),
      scope: `Up to ${config.runsPerPipeline} recent runs per pipeline; older or deleted history is outside this scan.`,
      pipelines: lists.map(list => ({ kind: list.kind, count: list.items.length, limited: list.limited })),
      apiRequests: client.requests - callsBefore,
    };
    const dashboard = buildDashboard({ builds, details, environments, environmentRecords, organization: config.organization, project: config.project, fetchedAt, limits, warnings, qaAvailability });
    lastDetails = details;
    lastBuilds = builds;
    cached = dashboard;
    return dashboard;
  }

  return {
    async get({ refresh = false } = {}) {
      if (!refresh && cached && now() - Date.parse(cached.fetchedAt) < config.cacheSeconds * 1000) return { ...cached, cached: true };
      if (!pending) pending = load().finally(() => { pending = undefined; });
      return pending;
    },
    run(id) {
      const run = cached?.runs.find(run => Number(run.id) === id);
      if (!run) return null;
      const detail = lastDetails.get(id);
      const source = lastBuilds.find(build => Number(build.id) === id);
      const stages = (detail?.timeline?.records || []).filter(record => record.type === 'Stage').sort((a, b) => {
        if (Number.isFinite(a.order) && Number.isFinite(b.order) && a.order !== b.order) return a.order - b.order;
        const startedA = Date.parse(a.startTime) || Number.MAX_SAFE_INTEGER;
        const startedB = Date.parse(b.startTime) || Number.MAX_SAFE_INTEGER;
        return startedA - startedB || String(a.name).localeCompare(String(b.name));
      }).map(record => ({
        name: record.name || record.identifier,
        status: record.result || record.state || 'unknown',
        attempt: record.attempt || 1,
        startedAt: record.startTime || null,
        finishedAt: record.finishTime || null,
      }));
      return {
        run,
        stages,
        evidence: [{ label: 'Original pipeline run', url: run.url, type: 'run' }],
        tags: Array.isArray(source?.tags) ? source.tags : [],
        note: detail?.validationFailed ? 'Pipeline validation failed before any deployment started.'
          : detail ? 'Stage outcomes describe recorded pipeline activity, not live cluster health.' : 'Only run summary data was read for this pipeline.',
      };
    },
  };
}
