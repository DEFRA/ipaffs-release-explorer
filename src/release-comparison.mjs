const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const series = version => version.split('.').slice(0, 2).join('.');
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const taggedDeployment = deployment => deployment?.versionKind === 'release-tag'
  && VERSION.test(deployment.version) && COMMIT.test(deployment.commit)
  && deployment.sourceRef === `refs/tags/${deployment.version}`;

// These are links to recorded manifest tags, not fresh GitHub tag observations.
export function attachReleaseComparisons(releases, environments, identities = [], deployments = []) {
  const commitsByVersion = new Map();
  const versionsByCommit = new Map();
  const successes = [...new Set([...deployments, ...environments.map(item => item.lastSuccess)])]
    .filter(deployment => deployment?.status === 'succeeded')
    .sort((a, b) => time(b.finishedAt || b.startedAt) - time(a.finishedAt || a.startedAt)
      || Number(b.attempt || 1) - Number(a.attempt || 1) || Number(b.runId || 0) - Number(a.runId || 0));
  const taggedDeployments = successes.filter(taggedDeployment);
  for (const { version, commit } of [...identities, ...releases, ...taggedDeployments]) {
    if (!VERSION.test(version) || !COMMIT.test(commit)) continue;
    const sha = commit.toLowerCase();
    if (!commitsByVersion.has(version)) commitsByVersion.set(version, new Set());
    if (!versionsByCommit.has(sha)) versionsByCommit.set(sha, new Set());
    commitsByVersion.get(version).add(sha);
    versionsByCommit.get(sha).add(version);
  }

  const unavailable = detail => ({ url: null, detail });
  for (const release of releases) {
    for (const progress of release.progress || []) {
      const environment = environments.find(item => item.name === progress.environment);
      let baseVersion = null;
      let matchedBy = 'tag';
      let unresolved = false;
      if (!VERSION.test(release.version) || !COMMIT.test(release.commit)) {
        progress.comparison = unavailable('Release tag identity unavailable.');
        continue;
      }
      for (const deployment of successes) {
        if (!environment || deployment.environment !== environment.name
          || deployment.namespace !== environment.namespace) continue;
        const declaredTag = deployment.versionKind === 'release-tag' && VERSION.test(deployment.version)
          && deployment.sourceRef === `refs/tags/${deployment.version}` ? deployment.version : null;
        if (declaredTag && series(declaredTag) === series(release.version)) continue;
        let version = taggedDeployment(deployment) ? deployment.version : null;
        let match = 'tag';
        if (!version && environment.name === 'DEV' && COMMIT.test(deployment.commit)) {
          // A branch build number is never a tag. Multiple tags at a commit are ambiguous.
          const versions = versionsByCommit.get(deployment.commit.toLowerCase());
          if (versions?.size === 1) version = [...versions][0];
          else if (versions?.size && [...versions].every(value => series(value) === series(release.version))) continue;
          match = 'commit';
        }
        // Unknown newer evidence cannot establish that an older tag is the last
        // different-series deployment. Known same-series tags can be skipped.
        if (!version) { unresolved = true; break; }
        if (series(version) === series(release.version)) continue;
        baseVersion = version;
        matchedBy = match;
        break;
      }
      if (unresolved) progress.comparison = unavailable('A newer successful deployment has no reliable release tag identity.');
      else if (!baseVersion) progress.comparison = unavailable('No successful deployment from a different release series recorded.');
      else if (commitsByVersion.get(baseVersion)?.size > 1 || commitsByVersion.get(release.version)?.size > 1) {
        progress.comparison = unavailable('Conflicting commits recorded for a comparison tag.');
      } else progress.comparison = {
        baseVersion, headVersion: release.version, matchedBy,
        url: `https://github.com/DEFRA/ipaffs-manifest/compare/tags/${baseVersion}...tags/${release.version}`,
        detail: `Compare the last successful recorded ${environment.name} deployment from a different major/minor series with this release tag.${matchedBy === 'commit' ? ' The DEV tag is matched by manifest commit; DEV deployed a branch build.' : ''}`,
      };
    }
  }
}
