import { mapConcurrent } from './ado-client.mjs';
import { buildInfrastructureProgress, infrastructureTag } from './infrastructure-model.mjs';

const releasePipeline = { name: 'Infrastructure Release Pipeline', path: '\\Infrastructure\\Releasing', yaml: 'release-pipeline.yaml' };
const devPipeline = { name: 'infrastructure', path: '\\Infrastructure', yaml: 'pipelines/infrastructure.yaml' };

async function history(client, { name, path, yaml }, query, limit) {
  const definitions = await client.list('build/definitions', { name, path, type: 'build', includeAllProperties: true });
  const matches = definitions.items.filter(item => item?.name === name && item.path === path
    && Number.isSafeInteger(item.id) && item.id > 0 && item.repository?.type === 'GitHub'
    && item.repository.name?.toLowerCase() === 'defra/ipaffs-infra'
    && [yaml, `/${yaml}`].includes(item.process?.yamlFilename));
  if (definitions.limited || matches.length !== 1) throw new Error('Infrastructure pipeline could not be identified');
  const id = matches[0].id;
  const builds = await client.list('build/builds', { definitions: id, queryOrder: 'queueTimeDescending', ...query }, limit);
  return {
    items: builds.items.filter(build => build?.definition?.id === id && Number.isSafeInteger(build.id) && build.id > 0
      && typeof build.sourceVersion === 'string' && /^[a-f0-9]{40}$/i.test(build.sourceVersion)),
    limited: builds.limited,
  };
}

export async function readInfrastructureHistory(config, client) {
  let releaseHistory;
  try {
    releaseHistory = await history(client, releasePipeline, {}, config.runsPerPipeline);
  } catch {
    return { availability: 'unavailable', devAvailability: 'unavailable', limited: false, releases: [],
      latestSuccessful: { TST: null, PRE: null, PRD: null } };
  }

  const releases = releaseHistory.items.filter(build => infrastructureTag(build.sourceBranch));
  const commits = new Set(releases.map(build => build.sourceVersion.toLowerCase()));
  let devHistory = { items: [], limited: false };
  let devAvailability = 'available';
  if (commits.size) {
    try {
      devHistory = await history(client, devPipeline, { branchName: 'refs/heads/main', tagFilters: 'Environment-DEV' }, config.runsPerPipeline);
    } catch {
      devAvailability = 'unavailable';
    }
  }

  const dev = devHistory.items.filter(build => build.sourceBranch === 'refs/heads/main'
    && Array.isArray(build.tags) && build.tags.includes('Environment-DEV') && commits.has(build.sourceVersion.toLowerCase()));
  const timelines = await mapConcurrent([...releases, ...dev], 4, async build => {
    try {
      const { data } = await client.get(`build/builds/${build.id}/timeline`);
      return { build, records: Array.isArray(data?.records) ? data.records : null };
    } catch {
      return { build, records: null };
    }
  });
  return buildInfrastructureProgress({
    releaseRuns: timelines.slice(0, releases.length), devRuns: timelines.slice(releases.length),
    base: config.organization, project: config.project,
    limited: releaseHistory.limited || devHistory.limited, devAvailability,
  });
}
