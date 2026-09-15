export function loadConfig(env = process.env) {
  const organization = (env.ADO_ORGANIZATION || '').replace(/\/$/, '');
  if (!/^https:\/\/dev\.azure\.com\/[A-Za-z0-9_-]+$/.test(organization)) {
    throw new Error('ADO_ORGANIZATION must be an HTTPS dev.azure.com organization URL.');
  }
  const integer = (name, fallback, min = 1, max = 100000000) => {
    const raw = env[name] || (fallback === undefined ? '' : String(fallback));
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} is invalid.`);
    return Number(raw);
  };
  const project = (env.ADO_PROJECT || '').trim();
  if (!project) throw new Error('ADO_PROJECT is required. Configure your project in the server environment.');
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(host)) throw new Error('HOST must be a local bind address.');
  const port = integer('PORT', 4317, 1024, 65535);
  const allowedHosts = (env.ALLOWED_HOSTS || `localhost:${port},127.0.0.1:${port}`)
    .split(',').map(value => value.trim().toLowerCase());
  for (const value of allowedHosts) {
    const match = value.match(/^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([0-9]+))?$/);
    if (!match || match[1].length > 253 || match[1].split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
      throw new Error('ALLOWED_HOSTS must contain comma-separated hostnames with optional ports, without URLs or wildcards.');
    }
  }
  return {
    organization,
    project,
    pipelines: {
      dev: integer('ADO_DEV_PIPELINE_ID'),
      create: integer('ADO_CREATE_RELEASE_PIPELINE_ID'),
      release: integer('ADO_RELEASE_PIPELINE_ID'),
      qa: integer('ADO_QA_PIPELINE_ID'),
    },
    environmentNames: ['DEV', 'TST', 'PRE', 'PRD'],
    runsPerPipeline: integer('ADO_RUNS_PER_PIPELINE', 20, 1, 100),
    cacheSeconds: integer('ADO_CACHE_SECONDS', 90, 10, 3600),
    host,
    port,
    allowedHosts: [...new Set(allowedHosts)],
  };
}
