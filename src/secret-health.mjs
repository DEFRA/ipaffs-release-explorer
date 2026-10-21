import { normalizeSecretExpiryReport, unavailableSecretHealth } from './secret-health-summary.mjs';

const CANONICAL = ['DEV', 'TST', 'PRE', 'PRD'];
const time = value => Date.parse(value) || 0;

// ADO serializes object parameters as JSON or a simple YAML list. An unknown
// selection fails closed for every environment instead of reviving older green.
function selectedEnvironments(build) {
  let value = build.templateParameters?.environmentNames;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch {
      const lines = value.trim().split(/\r?\n/);
      value = lines.every(line => /^\s*-\s*(DEV|TST|PRE|PRD)\s*$/.test(line))
        ? lines.map(line => line.replace(/^\s*-\s*/, '').trim()) : null;
    }
  }
  return Array.isArray(value) && value.length && value.every(env => CANONICAL.includes(env))
    && new Set(value).size === value.length ? value : null;
}

export function createSecretHealthService(config, client, { now = Date.now } = {}) {
  return {
    async attach(dashboard) {
      const targets = (dashboard.environments || []).filter(env => CANONICAL.includes(env.name));
      for (const env of targets) env.secretHealth = unavailableSecretHealth();
      if (!targets.length) return;
      let runs;
      let id;
      try {
        const pipeline = config.secretExpiryPipeline;
        if (!pipeline) return;
        id = pipeline.id;
        if (!id) {
          const definitions = await client.list('build/definitions', { name: pipeline.name, type: 'build' }, 100);
          const matches = definitions.items.filter(item => item.name === pipeline.name
            && Number.isSafeInteger(item.id) && item.id > 0);
          if (definitions.limited || matches.length !== 1) throw new Error('Ambiguous report pipeline');
          id = matches[0].id;
        }
        if (Object.values(config.pipelines || {}).includes(id)
          || Object.values(config.qaPipelines || {}).some(pipeline => pipeline.id === id)
          || config.scanPipeline?.id === id) throw new Error('Overlapping report pipeline');
        const history = await client.list('build/builds', {
          definitions: id, branchName: 'refs/heads/master', queryOrder: 'queueTimeDescending',
        }, Math.min(config.runsPerPipeline || 100, 20));
        runs = history.items.filter(run => run.definition?.id === id && Number.isSafeInteger(run.id) && run.id > 0
          && run.sourceBranch === 'refs/heads/master')
          .sort((a, b) => time(b.queueTime || b.startTime) - time(a.queueTime || a.startTime) || b.id - a.id);
        dashboard.limits.secretExpiryRuns = { count: runs.length, limited: history.limited };
      } catch {
        for (const env of targets) env.secretHealth = unavailableSecretHealth('Secret and certificate report history could not be read from ADO.');
        return;
      }

      const unresolved = new Set(targets.map(env => env.name));
      for (const run of runs.filter(run => ['completed', 'abandoned', 16].includes(run.status))) {
        if (!unresolved.size) break;
        const declared = selectedEnvironments(run);
        if (declared && !declared.some(env => unresolved.has(env))) continue;
        const url = `${config.organization}/${encodeURIComponent(config.project)}/_build/results?buildId=${run.id}&view=ms.vss-build-web.run-extensions-tab`;
        let normalized = null;
        try {
          if (run.status !== 'completed') throw new Error('The report run was abandoned');
          const report = await client.getSecretExpiryReport(run.id);
          normalized = normalizeSecretExpiryReport(report, run, { now: now() });
        } catch { /* Missing, denied or invalid artifacts remain unavailable. */ }
        const selected = declared || (normalized ? Object.keys(normalized.environments) : CANONICAL);
        for (const env of targets.filter(env => unresolved.has(env.name) && selected.includes(env.name))) {
          env.secretHealth = { ...(normalized?.environments[env.name]
            || unavailableSecretHealth('The latest environment report could not be read or verified.')),
          runId: run.id, url };
          unresolved.delete(env.name);
        }
      }
      for (const running of runs.filter(run => ['inProgress', 'notStarted', 'postponed'].includes(run.status))) {
        const selected = selectedEnvironments(running) || CANONICAL;
        for (const env of targets.filter(env => unresolved.has(env.name) && selected.includes(env.name))) {
          env.secretHealth = { ...unavailableSecretHealth('The first available report is still running or queued.'),
            state: 'running', runId: running.id,
            url: `${config.organization}/${encodeURIComponent(config.project)}/_build/results?buildId=${running.id}&view=ms.vss-build-web.run-extensions-tab` };
          unresolved.delete(env.name);
        }
      }
    },
  };
}
