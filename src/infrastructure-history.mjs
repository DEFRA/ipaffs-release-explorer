import { mapConcurrent } from './ado-client.mjs';
import { buildInfrastructureProgress, infrastructureTag, successfulDevApplyStage } from './infrastructure-model.mjs';

const releasePipeline = { name: 'Infrastructure Release Pipeline', path: '\\Infrastructure\\Releasing', yaml: 'release-pipeline.yaml' };
const devPipeline = { name: 'infrastructure', path: '\\Infrastructure', yaml: 'pipelines/infrastructure.yaml' };
const maxOverviewDevTimelines = 5;

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

const buildFinishedBy = build => Date.parse(build.finishTime) || Number.MAX_SAFE_INTEGER;

async function readOverviewDev(dev, taggedDevRuns, readTimeline) {
  const taggedById = new Map(taggedDevRuns.map(run => [run.build.id, run]));
  const candidates = dev.filter(build => build.status === 'completed' && build.result === 'succeeded')
    .sort((a, b) => buildFinishedBy(b) - buildFinishedBy(a) || b.id - a.id);
  const additional = [];
  let latestApplyTime = 0;
  let unavailable = false;
  let limited = false;
  for (const build of candidates) {
    // An apply stage cannot finish after its build. This keeps the search
    // small while allowing overlapping runs to finish their applies out of order.
    if (buildFinishedBy(build) < latestApplyTime) break;
    let run = taggedById.get(build.id);
    if (!run) {
      if (additional.length >= maxOverviewDevTimelines) {
        limited = true;
        continue;
      }
      run = await readTimeline(build);
      additional.push(run);
    }
    if (!run.records) unavailable = true;
    latestApplyTime = Math.max(latestApplyTime, Date.parse(successfulDevApplyStage(run)?.finishTime) || 0);
  }
  return { additional, unavailable, limited };
}

export async function readInfrastructureHistory(config, client) {
  const [releaseHistory, devHistory] = await Promise.all([
    history(client, releasePipeline, {}, config.runsPerPipeline).catch(() => null),
    history(client, devPipeline, { branchName: 'refs/heads/main', tagFilters: 'Environment-DEV' }, config.runsPerPipeline).catch(() => null),
  ]);
  const releases = (releaseHistory?.items || []).filter(build => infrastructureTag(build.sourceBranch));
  const commits = new Set(releases.map(build => build.sourceVersion.toLowerCase()));
  const dev = (devHistory?.items || []).filter(build => build.sourceBranch === 'refs/heads/main'
    && Array.isArray(build.tags) && build.tags.includes('Environment-DEV'));
  const taggedDev = dev.filter(build => commits.has(build.sourceVersion.toLowerCase()));
  const readTimeline = async build => {
    try {
      const { data } = await client.get(`build/builds/${build.id}/timeline`);
      return { build, records: Array.isArray(data?.records) ? data.records : null };
    } catch {
      return { build, records: null };
    }
  };
  const timelines = await mapConcurrent([...releases, ...taggedDev], 4, readTimeline);
  const taggedDevRuns = timelines.slice(releases.length);
  const overview = await readOverviewDev(dev, taggedDevRuns, readTimeline);
  const result = buildInfrastructureProgress({
    releaseRuns: timelines.slice(0, releases.length), devRuns: [...taggedDevRuns, ...overview.additional],
    base: config.organization, project: config.project,
    limited: Boolean(releaseHistory?.limited || devHistory?.limited), devAvailability: devHistory ? 'available' : 'unavailable',
  });
  return { ...result, availability: releaseHistory ? 'available' : 'unavailable',
    devLatestAvailability: !devHistory || (!result.latestDev && overview.unavailable) ? 'unavailable' : 'available',
    devLatestLimited: Boolean(devHistory?.limited || overview.limited) };
}
