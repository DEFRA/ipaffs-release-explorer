'use strict';

const $ = (id) => document.getElementById(id);
const AUTO_REFRESH_MS = 3 * 60 * 1000;
const state = { data: null, mode: 'live', tab: 'overview', loading: false, request: 0, detailRequest: 0, namespaceDetail: null, lastRefreshAt: 0, deliveryWindow: 30 };
let autoRefreshTimer;
const array = (value) => Array.isArray(value) ? value : [];

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function append(parent, ...children) {
  children.filter(Boolean).forEach((child) => parent.append(child));
  return parent;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    const adoHost = url.hostname === 'dev.azure.com' || url.hostname.endsWith('.visualstudio.com');
    return adoHost && url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function externalLink(label, value, className) {
  const url = safeUrl(value);
  if (!url) return node('span', className, label);
  const link = node('a', className, label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function safeGithubCompareUrl(value) {
  const version = '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)';
  const pattern = new RegExp(`^https://github\\.com/DEFRA/ipaffs-manifest/compare/${version}\\.\\.\\.${version}$`);
  if (typeof value !== 'string' || !pattern.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port
      && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

function releaseComparisonUrl(comparison) {
  if (!comparison) return null;
  const url = safeGithubCompareUrl(comparison.url);
  const expected = `https://github.com/DEFRA/ipaffs-manifest/compare/${comparison.baseVersion}...${comparison.headVersion}`;
  return url && url === expected && comparison.baseVersion !== comparison.headVersion ? url : null;
}

function releaseComparison(progress, { compact = false, environments = null } = {}) {
  const comparison = progress.comparison;
  if (!comparison) return null;
  const url = releaseComparisonUrl(comparison);
  const audience = environments ? environments.join(', ') : progress.environment;
  let link = null;
  if (url) {
    link = node('a', compact ? 'progress-comparison' : 'release-comparison-link', `Compare ${comparison.baseVersion} → ${comparison.headVersion} ↗`);
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('aria-label', `Compare ${comparison.baseVersion} to ${comparison.headVersion} for ${audience} on GitHub (opens in a new tab)`);
    if (environments) link.title = `Compare the last successful recorded deployment from a different major/minor series for ${audience} with this release tag.`;
    else if (comparison.detail) link.title = comparison.detail;
  }
  const detail = comparison.detail || 'Comparison is unavailable.';
  if (compact) return link;
  return append(node('section', 'drawer-section release-comparison'),
    node('h3', '', 'Compare with last different release series'), link, node('p', 'release-comparison-detail', detail));
}

function groupedReleaseComparisons(entries) {
  const groups = new Map();
  for (const progress of entries) {
    if (!progress.comparison) continue;
    const url = releaseComparisonUrl(progress.comparison);
    if (!url) continue;
    if (!groups.has(url)) groups.set(url, { progress, environments: [] });
    groups.get(url).environments.push(progress.environment);
  }
  if (!groups.size) return null;
  const container = node('div', 'release-comparisons');
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', 'GitHub release comparisons');
  groups.forEach(({ progress, environments }) => container.append(releaseComparison(progress, { compact: true, environments })));
  return container;
}

function safeApplicationUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.href : null;
  } catch { return null; }
}

function namespaceAccessLinks(namespace) {
  if (namespaceLaunchBlocked(namespace)) return [];
  return array(namespace.access?.links).filter((link) => safeApplicationUrl(link.url));
}

function namespaceLaunchBlocked(namespace) {
  return ['missing', 'terminating'].includes(namespace.runtime?.status);
}

function namespaceRuntime(namespace) {
  const states = {
    exists: ['Exists', 'success', 'The namespace existed when the cluster was checked.'],
    terminating: ['Terminating', 'warning', 'The cluster has marked this namespace for deletion.'],
    missing: ['Missing', 'neutral', 'The namespace was absent when the cluster was checked.'],
    unknown: ['Unknown', 'neutral', 'Cluster presence has not been checked.'],
  };
  const status = Object.hasOwn(states, namespace.runtime?.status) ? namespace.runtime.status : 'unknown';
  const [label, tone, fallbackDetail] = states[status];
  return { status, label, tone, detail: namespace.runtime?.detail || fallbackDetail, checkedAt: namespace.runtime?.checkedAt };
}

function applicationLink(label, value, className) {
  const url = safeApplicationUrl(value);
  if (!url) return null;
  const link = node('a', className, label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = url;
  return link;
}

function namespaceLaunchShortcuts(namespace) {
  if (namespaceLaunchBlocked(namespace)) return node('span', 'cell-secondary', 'Launch links hidden');
  const links = namespaceAccessLinks(namespace);
  const shortcuts = node('div', 'namespace-launch-shortcuts');
  for (const audience of ['b2c', 'b2b']) {
    const recorded = links.find((link) => link.kind === `${audience}-notifications`) || links.find((link) => link.kind === `${audience}-base`);
    if (!recorded) continue;
    const link = applicationLink(`Open ${audience.toUpperCase()} ↗`, recorded.url, 'namespace-shortcut');
    link.setAttribute('aria-label', `Open ${recorded.label} for ${namespace.name} (opens in a new tab)`);
    shortcuts.append(link);
  }
  return shortcuts.childElementCount ? shortcuts : node('span', 'cell-secondary', 'No URLs recorded');
}

function date(value, full = false) {
  const parsed = value && new Date(value);
  if (!parsed || Number.isNaN(parsed.getTime())) return 'Time not recorded';
  return new Intl.DateTimeFormat('en-GB', full
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }
    : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(parsed);
}

function shortCommit(value) { return value ? String(value).slice(0, 8) : 'Commit unknown'; }
function deploymentVersion(deployment) {
  if (!deployment?.version) return 'Unknown version';
  return deployment.versionKind === 'build-number' ? `Build ${deployment.version}` : deployment.version;
}
function cleanRef(value) { return value ? String(value).replace(/^refs\/(heads|tags)\//, '') : 'Source not recorded'; }
function normalizedStatus(value) { return String(value || 'unknown').toLowerCase().replace(/[\s_-]/g, ''); }
function recordStatus(record) {
  if (record?.abandonment === 'abandoned') return 'abandoned';
  return record?.result || record?.status || 'unknown';
}

function runTriggerReason(trigger) {
  const labels = {
    manual: 'Manual', individualci: 'Automated CI', batchedci: 'Automated CI',
    schedule: 'Scheduled', scheduleforced: 'Scheduled', pullrequest: 'Pull request',
    buildcompletion: 'Pipeline trigger', resourcetrigger: 'Pipeline trigger',
    checkinshelveset: 'Gated check-in', validateshelveset: 'Shelveset validation',
  };
  const reason = normalizedStatus(trigger?.reason);
  return labels[reason] || (reason === 'unknown' || reason === 'none' ? 'Not recorded' : `Other (${trigger.reason})`);
}

function namespaceCreator(namespace) {
  const creator = namespace.creator;
  const recorded = creator?.status === 'recorded' && typeof creator.name === 'string' && creator.name.trim();
  return {
    name: recorded ? creator.name : 'Not recorded',
    createdAt: creator?.createdAt || null,
    detail: creator?.detail || 'The available evidence does not identify who first created this namespace.',
    runId: recorded ? creator.runId : null,
    url: recorded ? creator.url : null,
    evidence: recorded ? creator.evidence : [],
  };
}

function namespaceCreatorSummary(namespace) {
  const creator = namespaceCreator(namespace);
  return append(node('td', 'namespace-creator-cell'),
    node('span', 'cell-primary', creator.name),
    creator.createdAt ? node('span', 'cell-secondary', `Created ${date(creator.createdAt)}`) : null);
}

function runTriggerFields(record) {
  const trigger = record?.trigger;
  return [
    ['Run trigger', runTriggerReason(trigger)],
    ['Run requested by', trigger?.requestedBy || 'Not recorded'],
    ...(trigger?.requestedFor && trigger.requestedFor !== trigger.requestedBy ? [['Run requested for', trigger.requestedFor]] : []),
  ];
}

function retryRequesterNote(deployment) {
  return Number(deployment?.attempt) > 1
    ? node('p', 'drawer-note', 'The requester identifies the original pipeline run. Who retried this deployment is not recorded in the available data.')
    : null;
}

function badge(value, override) {
  const status = normalizedStatus(value);
  const labels = {
    succeeded: ['Succeeded', 'success'], success: ['Succeeded', 'success'],
    failed: ['Failed', 'danger'], canceled: ['Canceled', 'neutral'], cancelled: ['Canceled', 'neutral'], abandoned: ['Abandoned', 'neutral'],
    inprogress: ['Running', 'info'], running: ['Running', 'info'], notstarted: ['Not started', 'neutral'],
    queued: ['Queued', 'info'], pending: ['Pending', 'neutral'], skipped: ['Skipped', 'neutral'],
    partiallysucceeded: ['Partially succeeded', 'warning'], succeededwithissues: ['Succeeded with issues', 'warning'],
    available: ['Available', 'success'], partial: ['Partial', 'warning'], unavailable: ['Unavailable', 'neutral'],
    recorded: ['Recorded', 'info'], inferred: ['Inferred', 'warning'], unknown: ['Unknown', 'neutral'],
    completed: ['Completed', 'neutral'], created: ['Created', 'success'], alreadypresent: ['Already present', 'neutral'],
    deployed: ['Deployed', 'success'], deploying: ['Deploying', 'info'], awaitingapproval: ['Awaiting approval', 'warning'],
    blocked: ['Blocked', 'warning'], notrecorded: ['Not recorded', 'neutral'],
  };
  const [label, color] = labels[status] || [String(value || 'Unknown'), 'neutral'];
  return node('span', `badge ${override || color}`, label);
}

function button(label, className, onClick) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

function empty(title, description) {
  return append(node('div', 'empty'), node('h3', '', title), node('p', '', description));
}

function makeTable(headings) {
  const table = node('table');
  const header = node('tr');
  headings.forEach((heading) => {
    const th = node('th', '', heading);
    th.scope = 'col';
    header.append(th);
  });
  table.append(append(node('thead'), header));
  const body = node('tbody');
  table.append(body);
  return { table, body };
}

function clickableRow(open) {
  const row = node('tr', 'clickable-row');
  row.addEventListener('click', (event) => {
    if (!event.target.closest('button,a,input,select')) open();
  });
  return row;
}

async function fetchJson(url) {
  const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  let data;
  try { data = await response.json(); } catch { throw new Error('The local app returned an unreadable response. Check that the server is running.'); }
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message || data.message;
    throw new Error(message || `Azure DevOps could not be read (HTTP ${response.status}).`);
  }
  return data;
}

function setLoading(loading) {
  state.loading = loading;
  $('refresh').disabled = loading;
  $('retry').disabled = loading;
  $('sample').disabled = loading;
  $('refresh').querySelector('span').textContent = loading ? 'Reading…' : 'Refresh';
  $('loading').hidden = !loading || Boolean(state.data);
  $('dashboard').setAttribute('aria-busy', String(loading));
  scheduleAutoRefresh();
}

async function loadDashboard(mode = 'live', refresh = false) {
  state.mode = mode;
  const request = ++state.request;
  $('error-panel').hidden = true;
  setLoading(true);
  if (!state.data) $('mode-badge').textContent = mode === 'sample' ? 'Loading sample' : 'Connecting';
  try {
    const query = new URLSearchParams();
    if (mode === 'sample') query.set('mode', 'sample');
    if (refresh) query.set('refresh', '1');
    const data = await fetchJson(`/api/dashboard${query.size ? `?${query}` : ''}`);
    if (request !== state.request) return;
    if (!data || !Array.isArray(data.environments) || !Array.isArray(data.runs)) throw new Error('The dashboard response is incomplete. Check the local app logs for details.');
    state.data = data;
    renderDashboard();
    $('dashboard').hidden = false;
  } catch (error) {
    if (request !== state.request) return;
    $('error-message').textContent = error.message;
    $('error-panel').hidden = false;
    if (!state.data) {
      $('mode-badge').textContent = 'Not connected';
      $('mode-badge').className = 'badge warning';
      $('source-label').textContent = 'No Azure DevOps data loaded';
    }
  } finally {
    if (request === state.request) {
      state.lastRefreshAt = Date.now();
      setLoading(false);
    }
  }
}

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  const indicator = $('auto-refresh-status');
  if (state.mode === 'sample') {
    indicator.textContent = 'Auto-refresh paused for sample data';
    return;
  }
  if (state.loading) {
    indicator.textContent = 'Refreshing data…';
    return;
  }
  if (document.hidden) {
    indicator.textContent = 'Auto-refresh paused while hidden';
    return;
  }
  indicator.textContent = 'Auto-refresh every 3 minutes';
  const delay = state.lastRefreshAt ? Math.max(0, AUTO_REFRESH_MS - (Date.now() - state.lastRefreshAt)) : AUTO_REFRESH_MS;
  autoRefreshTimer = setTimeout(() => {
    if (!state.loading && !document.hidden && state.mode === 'live') loadDashboard('live');
  }, delay);
}

function renderDashboard() {
  const data = state.data;
  const sample = data.mode === 'sample';
  $('mode-badge').textContent = sample ? 'Sample data' : 'Live ADO data';
  $('mode-badge').className = `badge ${sample ? 'warning' : 'info'}`;
  $('source-label').textContent = [data.organization, data.project].filter(Boolean).join(' / ') || (sample ? 'Sample Azure DevOps project' : 'Azure DevOps');
  $('fetched-at').textContent = `${sample ? 'Sample snapshot' : 'Last read'} · ${date(data.fetchedAt, true)}`;
  $('notice').replaceChildren();
  $('notice').hidden = !sample;
  if (sample) append($('notice'), node('span', '', 'You’re exploring sample data. These are illustrative releases and deployments, not your ADO records.'), button('Try live ADO', 'button text', () => loadDashboard('live', true)));
  $('release-count').textContent = new Set([...array(data.releases), ...array(data.previousReleases)].map(releaseIdentity)).size;
  renderEnvironments();
  renderNamespaces();
  renderCoverage();
  renderReleases();
  renderDelivery();
  $('scan-window').textContent = scanDescription(data.limits, array(data.runs).length);
}

function scanDescription(limits, count) {
  if (typeof limits === 'string') return limits;
  if (!limits) return `${count} runs scanned · Historical coverage is limited`;
  if (limits.description) return String(limits.description);
  const parts = [];
  const days = limits.days || limits.lookbackDays;
  const maximum = limits.maxBuilds || limits.maxRuns || limits.runsPerPipeline || limits.buildsPerPipeline;
  if (days) parts.push(`Past ${days} days`);
  if (maximum) parts.push(`Up to ${maximum} runs${limits.runsPerPipeline || limits.buildsPerPipeline ? ' per pipeline' : ''}`);
  if (limits.since || limits.from) parts.push(`Since ${date(limits.since || limits.from)}`);
  return `${parts.length ? parts.join(' · ') : `${count} runs scanned`} · Not a full history`;
}

function qaPresentation(qa) {
  if (!qa) return { label: 'No linked tests', tone: 'neutral', detail: 'No test run linked to this deployment.' };
  const status = normalizedStatus(recordStatus(qa));
  const running = ['inprogress', 'running'].includes(status);
  const waiting = ['queued', 'notstarted', 'pending'].includes(status);
  if (running || waiting) return { label: running ? 'Tests running' : 'Tests queued', tone: 'info', detail: 'Results will appear after the test run finishes.' };
  const summary = qa.summary;
  const available = summary?.availability === 'available';
  const failed = status === 'failed' || (available && summary.failed > 0);
  const warning = ['partiallysucceeded', 'succeededwithissues'].includes(status) || (available && summary.other > 0);
  const passed = ['succeeded', 'success'].includes(status) && available && summary.executed > 0 && summary.passed === summary.executed && !summary.other;
  const tone = failed ? 'danger' : warning ? 'warning' : passed ? 'success' : 'neutral';
  if (!available) return { label: qa.availability?.label || 'Results unavailable', tone, detail: qa.availability?.detail || 'No published test results are available for this run.' };
  const percentage = Number.isFinite(summary.passPercentage) ? summary.passPercentage : null;
  // Avoid rounding a non-perfect result to 100%.
  const formatted = percentage === null ? null : new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(percentage < 100 ? Math.min(99.9, percentage) : percentage);
  const counts = `${summary.passed} passed · ${summary.failed} failed · ${summary.skipped} skipped${summary.other ? ` · ${summary.other} other` : ''}`;
  return { label: summary.executed > 0 && formatted !== null ? `${formatted}% passed` : 'No tests executed', tone, detail: counts,
    denominator: `${summary.passed} passed out of ${summary.executed} executed tests. ${summary.skipped} skipped tests excluded from the pass percentage.` };
}

function qaSummary(deployment, { compact = false, run = deployment?.qa?.latest } = {}) {
  const presentation = qaPresentation(run);
  const section = node('section', `qa-summary${compact ? ' qa-summary-compact' : ''}`);
  section.setAttribute('aria-label', `Test results for ${deployment?.environment || 'this environment'} ${deployment?.version || ''}`.trim());
  const heading = append(node('div', 'qa-heading'), node('span', 'qa-label', 'Tests'));
  if (run) heading.append(badge(recordStatus(run), presentation.tone));
  const metric = node('p', `qa-metric qa-${presentation.tone}`, presentation.label);
  if (presentation.denominator) metric.title = presentation.denominator;
  append(section, heading, metric, node('p', 'qa-counts', presentation.detail));
  if (run) {
    const hasResults = run.summary?.availability === 'available';
    const link = externalLink(hasResults ? 'View test results ↗' : `View test run #${run.id} ↗`, hasResults ? run.resultsUrl || run.url : run.url, 'qa-results-link');
    link.setAttribute('aria-label', `${hasResults ? 'View test results' : 'View test run'} for ${deployment?.environment || run.environment || 'environment'} ${deployment?.version || ''}, QA run ${run.id} (opens in a new tab)`);
    section.append(link);
    if (!compact) {
      append(section, node('p', 'qa-run-meta', `QA run #${run.id} · ${date(run.finishedAt || run.queuedAt, true)}`));
      if (presentation.denominator) section.append(node('p', 'qa-run-meta', presentation.denominator));
    }
  }
  return section;
}

function deploymentQaDetails(deployment) {
  const section = append(node('section', 'drawer-section deployment-qa'), node('h3', '', 'Tests linked to this deployment'), qaSummary(deployment));
  const runs = array(deployment?.qa?.runs).filter(run => run.id !== deployment?.qa?.latest?.id);
  if (runs.length) {
    const history = append(node('details', 'qa-history'), node('summary', '', `${runs.length} earlier linked test ${runs.length === 1 ? 'run' : 'runs'}`));
    runs.forEach(run => history.append(qaSummary(deployment, { run })));
    section.append(history);
  }
  if (deployment?.qa?.latest) section.append(node('p', 'qa-run-meta', 'Linked by deployment evidence. A later deployment may have changed the environment while tests were running.'));
  return section;
}

function vulnerabilityPresentation(scan) {
  const states = {
    complete: ['Complete scan', 'neutral', 'Scan results unavailable'],
    partial: ['Partial scan', 'warning', 'Incomplete scan'],
    running: ['Scanning', 'info', 'Scan in progress'],
    failed: ['Scan failed', 'danger', 'Scan did not complete'],
    unavailable: ['Unavailable', 'neutral', 'Scan results unavailable'],
    'not-scanned': ['Not recorded', 'neutral', 'No matching scan'],
  };
  const scanState = Object.hasOwn(states, scan?.state) ? scan.state : 'not-scanned';
  const [status, tone, label] = states[scanState];
  const counts = ['complete', 'partial'].includes(scanState) && scan?.counts
    && ['critical', 'high', 'medium', 'low', 'unknown'].every(severity => Number.isSafeInteger(scan.counts[severity]) && scan.counts[severity] >= 0)
    ? scan.counts : null;
  if (!counts) return { status: scanState === 'complete' ? 'Unavailable' : status, tone, label, counts: null };
  const count = value => new Intl.NumberFormat('en-GB').format(value);
  const distinct = scan.distinct && ['critical', 'high'].every(severity => Number.isSafeInteger(scan.distinct[severity])
    && scan.distinct[severity] >= 0 && scan.distinct[severity] <= counts[severity]) ? scan.distinct : null;
  return {
    status, counts,
    distinct: distinct && `${count(distinct.critical)} critical · ${count(distinct.high)} high distinct CVEs`,
    tone: counts.critical || counts.high ? 'danger' : scanState === 'partial' || counts.medium || counts.low || counts.unknown ? 'warning' : 'success',
    label: `${count(counts.critical)} critical · ${count(counts.high)} high`,
    detail: `${count(counts.medium)} medium · ${count(counts.low)} low · ${count(counts.unknown)} unknown severity`,
  };
}

function vulnerabilitySummary(scan, { compact = false, release = false } = {}) {
  const presentation = vulnerabilityPresentation(scan);
  const slim = compact || release;
  const assumedMaster = scan?.matchedBy === 'assumed-master';
  const assumption = 'Latest master scan; DEV is assumed to follow master.';
  const section = node('section', `vulnerability-summary${slim ? ' vulnerability-summary-slim' : ''}${compact ? ' vulnerability-summary-compact' : ''}${release ? ' vulnerability-summary-release' : ''}`);
  section.setAttribute('aria-label', 'Manifest vulnerability scan evidence');
  const scanTone = scan?.state === 'partial' ? 'warning' : presentation.tone;
  const label = node('span', 'vulnerability-label', `Manifest vulnerabilities${assumedMaster ? ' · master' : ''}`);
  if (assumedMaster) label.title = assumption;
  const heading = append(node('div', 'vulnerability-heading'), label);
  if (!slim || scan?.state === 'partial') heading.append(node('span', `badge ${scanTone}`, presentation.status));
  const main = append(node('div', 'vulnerability-main'),
    heading,
    node('p', `vulnerability-metric vulnerability-${presentation.tone}`, presentation.label));
  if (presentation.distinct) {
    const distinct = node('p', 'vulnerability-distinct', presentation.distinct);
    distinct.title = 'Each vulnerability ID is counted once, however many images or packages it affects.';
    main.append(distinct);
  }
  if (!slim && presentation.detail) main.append(node('p', 'vulnerability-counts', presentation.detail));
  const evidence = node('div', 'vulnerability-evidence');
  const images = scan?.images;
  if (!slim && images && ['total', 'scanned', 'failed'].every(key => Number.isSafeInteger(images[key]) && images[key] >= 0)) {
    evidence.append(node('p', 'vulnerability-meta', `${images.scanned}/${images.total} images scanned${images.failed ? ` · ${images.failed} failed` : ''}`));
  }
  if (scan?.scannedAt) {
    const time = node('time', 'vulnerability-meta', `Scanned ${date(scan.scannedAt, !slim)}`);
    time.setAttribute('datetime', scan.scannedAt);
    time.title = date(scan.scannedAt, true);
    evidence.append(time);
  } else if (presentation.counts) evidence.append(node('p', 'vulnerability-meta', 'Scan date not recorded'));
  if (safeUrl(scan?.url)) {
    const link = externalLink('View scan ↗', scan.url, 'vulnerability-results-link');
    link.setAttribute('aria-label', `View manifest vulnerability scan${scan.runId ? ` run ${scan.runId}` : ''} in Azure DevOps (opens in a new tab)`);
    evidence.append(link);
  }
  append(section, main, evidence);
  if (!slim) {
    section.append(node('p', 'vulnerability-scope', 'Finding occurrences across all manifest images.'));
    if (assumedMaster) {
      const provenance = node('p', 'vulnerability-detail', `${assumption}${scan.sourceCommit ? ` Scanned commit ${shortCommit(scan.sourceCommit)}.` : ''}`);
      if (scan.sourceCommit) provenance.title = scan.sourceCommit;
      section.append(provenance);
    }
    if (scan?.state === 'partial') section.append(node('p', 'vulnerability-detail', 'Counts cover scanned images only; findings are incomplete.'));
    if (scan?.detail) section.append(node('p', 'vulnerability-detail', scan.detail));
  }
  return section;
}

function renderEnvironments() {
  const container = $('environment-grid');
  container.replaceChildren();
  for (const environment of array(state.data.environments)) {
    const card = node('article', 'environment-card');
    append(card, append(node('div', 'card-top'), node('h3', 'environment-name', environment.name), node('span', 'namespace-label', environment.namespace || environment.name?.toLowerCase())));
    const main = node('div', 'card-main');
    const deployment = environment.lastSuccess;
    if (deployment) {
      append(main, button(deploymentVersion(deployment), 'version-button', () => openDeployment(deployment, environment.name)), node('p', 'card-commit', shortCommit(deployment.commit)), badge('succeeded'), node('p', 'deployment-time', date(deployment.finishedAt)));
    } else {
      append(main, node('p', 'version-empty', 'No deployment found'), node('p', 'card-commit', 'Within scanned history'), badge('unknown'), node('p', 'deployment-time', 'No successful ADO record'));
    }
    append(card, main, qaSummary(deployment, { compact: true }), vulnerabilitySummary(environment.vulnerability ?? deployment?.vulnerability, { compact: true }));
    const footer = node('div', 'card-footer');
    const latest = environment.latestAttempt;
    if (latest && (!deployment || latest.runId !== deployment.runId || latest.attempt !== deployment.attempt || normalizedStatus(recordStatus(latest)) !== 'succeeded')) {
      append(footer, node('span', '', 'Latest attempt'), button(`${String(recordStatus(latest)).replace(/([a-z])([A-Z])/g, '$1 $2')} · #${latest.runId}`, 'button text', () => openDeployment(latest, environment.name)));
    } else {
      append(footer, node('span', '', 'Recorded deployment'), deployment ? button(`Run #${deployment.runId} ↗`, 'button text', () => openDeployment(deployment, environment.name)) : node('span', '', '—'));
    }
    card.append(footer);
    container.append(card);
  }
}

function renderNamespaces() {
  const namespaceGroup = namespace => namespace.kind === 'canonical' ? 0 : namespace.kind === 'release' ? 1 : 2;
  const lastSuccessTime = namespace => Date.parse(namespace.lastSuccess?.finishedAt) || 0;
  const namespaces = array(state.data.namespaces).filter(namespace => namespace.runtime?.status === 'exists').sort((a, b) =>
    namespaceGroup(a) - namespaceGroup(b) || lastSuccessTime(b) - lastSuccessTime(a)
    || String(a.name || '').localeCompare(String(b.name || '')));
  if (state.namespaceDetail && !namespaces.some(namespace => namespace.name === state.namespaceDetail)) {
    if ($('detail-dialog').open) $('detail-dialog').close();
    state.namespaceDetail = null;
  }
  $('namespace-count').textContent = `${namespaces.length} found`;
  const checks = state.data.namespaceChecks;
  const checkStatus = !checks?.enabled ? 'Cluster checks disabled.'
    : checks.status === 'available' ? 'Cluster presence checked.'
      : checks.status === 'partial' ? 'Some cluster checks were unavailable.' : 'Cluster checks unavailable.';
  $('namespace-check-status').textContent = `${checkStatus}${checks?.checkedAt ? ` Last check ${date(checks.checkedAt, true)}.` : ''} Only namespaces confirmed to exist are shown.`;
  const container = $('namespace-table');
  container.replaceChildren();
  if (!namespaces.length) return container.append(empty('No confirmed existing DEV namespaces', checks?.enabled
    ? 'No namespaces in the scanned deployment history are currently confirmed to exist. Check the cluster access status above.'
    : 'Enable cluster checks to show namespaces confirmed to exist.'));
  const { table, body } = makeTable(['Namespace / branch', 'Type', 'Last recorded version', 'Last success', 'Creator', 'Latest attempt']);
  namespaces.forEach((namespace) => {
    const open = () => openNamespace(namespace);
    const row = clickableRow(open);
    const success = namespace.lastSuccess;
    append(row,
      append(node('td'), button(namespace.name || 'Unknown namespace', 'row-trigger mono', open), node('span', 'cell-secondary truncate', cleanRef(namespace.branch)), namespaceLaunchShortcuts(namespace)),
      append(node('td'), badge(namespace.kind || 'Unknown', 'neutral')),
      append(node('td'), node('span', 'cell-primary', success ? deploymentVersion(success) : 'Not recorded'), success ? node('span', 'cell-secondary mono', shortCommit(success.commit)) : null),
      node('td', 'muted', success ? date(success.finishedAt) : 'No success found'),
      namespaceCreatorSummary(namespace),
      append(node('td'), namespace.latestAttempt ? badge(recordStatus(namespace.latestAttempt)) : badge('unknown')));
    body.append(row);
  });
  container.append(table);
}

function renderCoverage() {
  $('coverage').replaceChildren();
  array(state.data.coverage).forEach((item) => {
    const card = node('article', 'coverage-item');
    append(card, append(node('div', 'coverage-top'), node('h3', '', item.label), badge(item.status)), node('p', '', item.detail));
    $('coverage').append(card);
  });
  if (!array(state.data.coverage).length) $('coverage').append(node('p', 'muted', 'Coverage details are not available for this scan.'));
  $('warnings').replaceChildren();
  array(state.data.warnings).forEach((warning) => $('warnings').append(node('p', warning.severity === 'info' ? 'warning-item history-note' : 'warning-item', typeof warning === 'string' ? warning : warning.message)));
}

function compareVersions(a, b) {
  const left = String(a.version || '').split('.').map(Number);
  const right = String(b.version || '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((left[i] || 0) !== (right[i] || 0)) return (right[i] || 0) - (left[i] || 0); }
  return String(b.observedAt || '').localeCompare(String(a.observedAt || ''));
}

function releaseIdentity(release) {
  return JSON.stringify([release.version || '', String(release.commit || '').toLowerCase()]);
}

function renderReleases() {
  const container = $('release-list');
  const expanded = new Set([...container.querySelectorAll('.release-expander[open]')].map((item) => item.dataset.series));
  container.replaceChildren();
  const previous = array(state.data.previousReleases);
  const released = new Set(previous.map(releaseIdentity));
  const releases = array(state.data.releases).filter((release) => !released.has(releaseIdentity(release))).sort(compareVersions);
  if (!releases.length) container.append(append(node('div', 'surface'), empty('No release candidates found', 'No eligible release-tag evidence without a successful PRD deployment was found in the scanned history. Abandoned runs are excluded from candidates.')));
  const groups = new Map();
  releases.forEach((release) => {
    const series = release.series || String(release.version || 'Unknown').split('.').slice(0, 2).join('.');
    if (!groups.has(series)) groups.set(series, []);
    groups.get(series).push(release);
  });
  groups.forEach((items, series) => {
    const group = node('article', 'release-group');
    const details = node('details', 'release-expander');
    details.dataset.series = series;
    details.open = expanded.has(series);
    const summary = node('summary');
    const arrow = node('span', 'chevron', '›');
    arrow.setAttribute('aria-hidden', 'true');
    append(summary, arrow, node('span', 'series-title', `${series}.x`), node('span', 'series-description', `${items.length} ${items.length === 1 ? 'patch' : 'patches'} found`), append(node('span', 'series-latest'), node('span', '', `Latest ${items[0].version}`), badge(items[0].confidence || 'inferred')));
    const patches = node('div', 'release-patches');
    items.forEach((release, index) => patches.append(releasePatch(release, index === 0)));
    append(details, summary, patches);
    const preview = append(node('div', 'release-latest-preview'), releasePatch(items[0], true));
    append(group, details, preview);
    container.append(group);
  });
  const history = $('previous-release-list');
  history.replaceChildren();
  if (!previous.length) history.append(append(node('div', 'surface'), empty('No previous releases found', 'No successful PRD deployment with a recorded release version and manifest commit was found in the scanned history.')));
  previous.forEach((release) => history.append(append(node('article', 'release-group previous-release'), releasePatch(release))));
}

function releasePatch(release, latest) {
  const patch = node('article', 'release-patch');
  const version = button(release.version || 'Unknown version', 'row-trigger patch-version', () => openRelease(release));
  const identity = append(node('div', 'patch-identity'), version);
  if (latest) identity.append(node('span', 'badge neutral', 'Latest patch'));
  const currentPrd = array(state.data.environments).find((environment) => environment.name === 'PRD')?.lastSuccess;
  if (release.history && currentPrd?.versionKind === 'release-tag' && currentPrd.sourceRef === `refs/tags/${release.version}`
    && releaseIdentity(release) === releaseIdentity(currentPrd)) identity.append(node('span', 'badge success latest-prd-badge', 'Latest recorded in PRD'));
  const observed = node('span', '', release.history ? `Last PRD deployment ${date(release.observedAt)}` : `Observed ${date(release.observedAt)}`);
  observed.title = date(release.observedAt, true);
  append(patch, append(node('div', 'patch-heading'), identity, append(node('div', 'patch-meta'), node('span', 'mono', shortCommit(release.commit)), observed)), releaseProgress(release), vulnerabilitySummary(release.vulnerability, { release: true }));
  return patch;
}

function progressEntries(release) {
  return ['DEV', 'TST', 'PRE', 'PRD'].map((environment) => array(release.progress).find((item) => item.environment === environment) || {
    environment, status: 'unknown', label: 'Unknown', detail: 'Progress evidence is not available for this environment in the scanned history.',
    lastSuccess: null, latestAttempt: null, evidence: [], matchedBy: null,
  });
}

function progressTone(status) {
  return { deployed: 'success', deploying: 'info', awaitingapproval: 'warning', failed: 'danger', blocked: 'warning' }[normalizedStatus(status)] || 'neutral';
}

function progressBadge(progress) {
  return node('span', `badge ${progressTone(progress.status)}`, progress.label || badge(progress.status).textContent);
}

function distinctAttempt(progress) {
  const latest = progress.latestAttempt;
  const success = progress.lastSuccess;
  return latest && (!success || latest.runId !== success.runId || latest.attempt !== success.attempt || latest.namespace !== success.namespace || normalizedStatus(recordStatus(latest)) !== normalizedStatus(recordStatus(success)));
}

function releaseProgress(release) {
  const list = node('ol', 'release-progress');
  list.setAttribute('aria-label', `Recorded deployment progress for ${release.version || 'this release'}`);
  const entries = progressEntries(release);
  entries.forEach((progress) => {
    const tone = progressTone(progress.status);
    const control = button('', `progress-step progress-${tone}`, () => openReleaseProgress(release, progress));
    const label = progress.label || badge(progress.status).textContent;
    control.setAttribute('aria-label', `${progress.environment}: ${label}. View evidence for ${release.version || 'this release'}`);
    if (progress.detail) control.title = progress.detail;
    append(control, node('span', 'progress-environment', progress.environment), node('span', 'progress-label', label));
    const record = release.history ? progress.lastSuccess : progress.latestAttempt || progress.lastSuccess;
    const timestamp = release.history ? record?.finishedAt : record?.finishedAt || record?.startedAt;
    if (timestamp) {
      const time = node('time', 'progress-time', date(timestamp, Boolean(release.history)));
      time.setAttribute('datetime', timestamp);
      time.title = date(timestamp, true);
      control.append(time);
    } else if (release.history && record) control.append(node('span', 'progress-time', 'Completion time not recorded'));
    if (release.history && array(progress.deployments).length > 1) control.append(node('span', 'progress-prior', `${progress.deployments.length} deployments recorded`));
    if (!release.history && progress.lastSuccess && distinctAttempt(progress)) control.append(node('span', 'progress-prior', 'Earlier success recorded'));
    const qa = record?.qa?.latest;
    if (qa) {
      const presentation = qaPresentation(qa);
      control.append(node('span', `progress-qa qa-${presentation.tone}`, `Tests: ${presentation.label}`));
    }
    list.append(append(node('li'), control));
  });
  return append(node('div', 'release-progress-summary'), list, groupedReleaseComparisons(entries));
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'Not recorded';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'Under 1m';
  const days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), rest = minutes % 60;
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  return hours ? (rest ? `${hours}h ${rest}m` : `${hours}h`) : `${rest}m`;
}

function percentage(rate) {
  return Number.isFinite(rate) ? `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(rate * 100)}%` : 'No attempts';
}

function plural(count, word, many = `${word}s`) { return `${count} ${count === 1 ? word : many}`; }

function deliveryMetric(label, value, summary, definition) {
  return append(node('article', 'delivery-metric'), node('h3', 'delivery-metric-label', label),
    node('p', 'delivery-metric-value', value), node('p', 'delivery-metric-summary', summary), node('p', 'delivery-metric-definition', definition));
}

function deliveryTime(reference) {
  if (!reference?.at) return node('span', 'muted', 'Not recorded');
  const label = date(reference.at);
  const element = reference.url ? externalLink(`${label} ↗`, reference.url) : node('span', '', label);
  element.title = `${date(reference.at, true)}${reference.runId ? ` · Run #${reference.runId}${reference.attempt > 1 ? `, attempt ${reference.attempt}` : ''}` : ''}`;
  return element;
}

function deliveryTable(title, description, headings, rows, emptyTitle, emptyText) {
  const section = append(node('section', 'surface delivery-section'), append(node('div', 'surface-heading'), append(node('div'), node('h2', '', title), node('p', '', description))));
  const wrap = node('div', 'table-wrap');
  if (!rows.length) wrap.append(empty(emptyTitle, emptyText));
  else {
    const { table, body } = makeTable(headings);
    rows.forEach((cells) => body.append(append(node('tr'), ...cells.map((cell) => cell instanceof Node && String(cell.tagName).toLowerCase() === 'td' ? cell : append(node('td'), cell instanceof Node ? cell : document.createTextNode(String(cell)))))));
    wrap.append(table);
  }
  section.append(wrap);
  return section;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_WIDTH = 960;
const DAY_MS = 86400000;
const STAGES = [['tst', 'TST'], ['pre', 'PRE'], ['prd', 'Production']];

function svgNode(tag, className, attributes = {}, text) {
  const element = document.createElementNS(SVG_NS, tag);
  if (className) element.setAttribute('class', className);
  Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value)));
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

// SVG has no native tooltip element; <title> gives hover text and an accessible name.
function svgTitled(element, title) {
  element.append(svgNode('title', '', {}, title));
  return element;
}

function svgLink(child, value) {
  const url = safeUrl(value);
  if (!url) return child;
  return append(svgNode('a', 'chart-link', { href: url, target: '_blank', rel: 'noopener noreferrer' }), child);
}

function chartFrame(height) {
  return svgNode('svg', 'delivery-chart', { viewBox: `0 0 ${CHART_WIDTH} ${height}`, role: 'img' });
}

function chartLegend(items) {
  return append(node('div', 'chart-legend'), ...items.map(([className, label]) => append(node('span'), node('i', `chart-swatch ${className}`), document.createTextNode(label))));
}

function chartSection(title, description, legend, chart, emptyTitle, emptyText) {
  const heading = append(node('div'), node('h2', '', title), node('p', '', description));
  const section = append(node('section', 'surface delivery-section'), append(node('div', 'surface-heading chart-heading'), append(heading, legend)));
  section.append(chart ? append(node('div', 'chart-wrap'), chart) : empty(emptyTitle, emptyText));
  return section;
}

function dayTicks(start, end) {
  const days = (end - start) / DAY_MS;
  const step = [1, 2, 7, 14, 28].find((value) => days / value <= 9) || Math.ceil(days / 9);
  const ticks = [];
  for (let tick = Math.ceil(start / DAY_MS) * DAY_MS; tick <= end; tick += step * DAY_MS) ticks.push(tick);
  return ticks;
}

function candidateTimeline(candidates, from, generatedAt) {
  const end = Math.max(Date.parse(generatedAt) || 0, from) + DAY_MS / 4;
  const rows = candidates.map((row) => ({ row, points: array(row.deployments).map((item) => ({ ...item, at: Date.parse(item.at) })).filter((item) => item.at >= from && item.at <= end) }))
    .filter(({ points }) => points.length);
  if (!rows.length) return null;
  const start = from;
  const left = 96, right = 16, rowHeight = 26, top = 10, plotHeight = rows.length * rowHeight;
  const x = (value) => left + (value - start) / (end - start) * (CHART_WIDTH - left - right);
  const svg = chartFrame(top + plotHeight + 30);
  svg.setAttribute('aria-label', `Timeline of ${plural(rows.length, 'release candidate')} through TST, PRE and production`);
  const tickFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
  dayTicks(start, end).forEach((tick) => {
    svg.append(svgNode('line', 'chart-grid', { x1: x(tick), x2: x(tick), y1: top - 4, y2: top + plotHeight }));
    svg.append(svgNode('text', 'chart-axis', { x: x(tick), y: top + plotHeight + 20, 'text-anchor': 'middle' }, tickFormat.format(tick)));
  });
  const labels = { TST: 'TST', PRE: 'PRE', PRD: 'Production' };
  rows.forEach(({ row, points }, index) => {
    const y = top + index * rowHeight + rowHeight / 2;
    const outcome = { production: 'Reached production', replaced: 'Replaced by a later version before production', 'in-progress': 'Not yet in production' }[row.outcome] || '';
    svg.append(svgTitled(svgNode('text', `chart-row-label ${row.outcome}`, { x: left - 12, y: y + 4, 'text-anchor': 'end' }, row.version), `${row.version} · ${shortCommit(row.commit)} · ${outcome}`));
    // A candidate first deployed before the period continues from the left edge.
    const first = Math.min(...array(row.deployments).map((item) => Date.parse(item.at))), last = points.at(-1).at;
    const spanStart = Math.max(start, first);
    if (last > spanStart) svg.append(svgNode('line', `chart-span ${row.outcome}`, { x1: x(spanStart), x2: x(last), y1: y, y2: y }));
    points.forEach((point) => {
      const failed = point.status === 'failed';
      const title = `${row.version} · ${labels[point.environment] || point.environment} ${failed ? 'deployment failed' : 'deployed'} · ${date(point.at)}${point.runId ? ` · Run #${point.runId}${point.attempt > 1 ? `, attempt ${point.attempt}` : ''}` : ''}`;
      const mark = failed ? svgNode('circle', 'chart-failed', { cx: x(point.at), cy: y, r: 5.5 })
        : svgNode('circle', `chart-dot ${point.environment.toLowerCase()}`, { cx: x(point.at), cy: y, r: 5 });
      svg.append(svgLink(svgTitled(mark, title), point.url));
    });
  });
  return svg;
}

function leadTimeChart(releases, medianMs) {
  if (!releases.length) return null;
  const rows = [...releases].sort((a, b) => Date.parse(a.firstPrd.at) - Date.parse(b.firstPrd.at));
  const maxDays = Math.max(1, ...rows.map((row) => (row.leadMs || 0) / DAY_MS));
  const step = [1, 2, 5, 7, 10, 14, 30].find((value) => maxDays / value <= 10) || Math.ceil(maxDays / 10);
  const domain = Math.ceil(maxDays / step) * step;
  const left = 96, right = 90, rowHeight = 30, top = 22, plotHeight = rows.length * rowHeight;
  const x = (ms) => left + ms / (domain * DAY_MS) * (CHART_WIDTH - left - right);
  const svg = chartFrame(top + plotHeight + 46);
  svg.setAttribute('aria-label', `Lead time of ${plural(rows.length, 'production release')}, split by stage`);
  for (let tick = 0; tick <= domain; tick += step) {
    svg.append(svgNode('line', 'chart-grid', { x1: x(tick * DAY_MS), x2: x(tick * DAY_MS), y1: top - 4, y2: top + plotHeight }));
    svg.append(svgNode('text', 'chart-axis', { x: x(tick * DAY_MS), y: top + plotHeight + 18, 'text-anchor': 'middle' }, tick));
  }
  svg.append(svgNode('text', 'chart-axis', { x: left + (CHART_WIDTH - left - right) / 2, y: top + plotHeight + 38, 'text-anchor': 'middle' }, 'Days from release tag to production'));
  rows.forEach((row, index) => {
    const y = top + index * rowHeight + rowHeight / 2;
    svg.append(svgTitled(svgNode('text', 'chart-row-label production', { x: left - 12, y: y + 4, 'text-anchor': 'end' }, row.version), `${row.version} · ${shortCommit(row.commit)}`));
    const created = Date.parse(row.created?.at);
    if (row.leadMs === null || !Number.isFinite(created)) {
      svg.append(svgNode('text', 'chart-axis', { x: left + 4, y: y + 4 }, 'Tag creation not retained, so lead time is not recorded'));
      return;
    }
    // Each segment ends at the stage it reached; a missing stage merges into the next one.
    let from = 0, previous = 'Tag';
    STAGES.forEach(([key, label]) => {
      const reference = key === 'prd' ? row.firstPrd : key === 'pre' ? row.firstPre : row.firstTst;
      const reached = Date.parse(reference?.at);
      if (!Number.isFinite(reached)) return;
      const to = Math.min(row.leadMs, Math.max(from, reached - created));
      svg.append(svgLink(svgTitled(svgNode('rect', `chart-segment ${key === 'tst' ? 'tag' : key}`, { x: x(from), y: y - 7, width: Math.max(1.5, x(to) - x(from)), height: 14, rx: 2 }),
        `${row.version} · ${previous} → ${label} · ${duration(to - from)}`), reference.url));
      from = to;
      previous = label;
    });
    svg.append(svgNode('text', 'chart-value', { x: CHART_WIDTH - right + 12, y: y + 4 }, duration(row.leadMs)));
  });
  if (Number.isFinite(medianMs)) {
    svg.append(svgNode('line', 'chart-median', { x1: x(medianMs), x2: x(medianMs), y1: top - 6, y2: top + plotHeight }));
    svg.append(svgNode('text', 'chart-median-label', { x: x(medianMs), y: top - 10, 'text-anchor': 'middle' }, `Median ${duration(medianMs)}`));
  }
  return svg;
}

function renderDelivery() {
  const delivery = state.data.delivery;
  const windows = array(delivery?.windows);
  const controls = $('delivery-window');
  const container = $('delivery-content');
  controls.replaceChildren();
  container.replaceChildren();
  if (!windows.length) {
    container.append(append(node('div', 'surface'), empty('Delivery metrics unavailable', 'This scan did not provide deployment history for delivery measures.')));
    return;
  }
  const period = windows.find((item) => item.days === state.deliveryWindow) || windows[0];
  windows.forEach((item) => {
    const control = button(`${item.days} days`, `segment${item === period ? ' active' : ''}`, () => { state.deliveryWindow = item.days; renderDelivery(); });
    control.setAttribute('aria-pressed', String(item === period));
    controls.append(control);
  });
  const from = Date.parse(period.from);
  const within = (reference) => Date.parse(reference?.at) >= from;

  const coverage = !period.coveredFrom
    ? 'No release runs are present in this scan, so PRD history is unavailable for this period.'
    : period.partial
      ? `Scanned release history starts ${date(period.coveredFrom, true)}, so this period covers ${period.coveredDays} of ${period.days} days. Older runs are outside the scan.`
      : `The scanned release history covers the full ${period.days} days.`;
  container.append(node('p', `delivery-coverage${period.partial ? ' partial' : ''}`, coverage));

  const prd = period.prd, lead = period.leadTime, failure = period.failureRate, recovery = period.recovery;
  container.append(append(node('div', 'delivery-grid'),
    deliveryMetric('Deployment frequency', String(prd.deployments),
      `Successful PRD deployments · ${plural(prd.releases, 'release version')}${prd.perWeek !== null ? ` · ${prd.perWeek} per week` : ''}`,
      'Successful PRD deployment stage attempts, including redeployments.'),
    deliveryMetric('Lead time', lead.count ? duration(lead.medianMs) : 'Not recorded',
      lead.count ? `Median of ${plural(lead.count, 'release')} · range ${duration(lead.minMs)}–${duration(lead.maxMs)}${lead.notRecorded ? ` · ${lead.notRecorded} without tag creation` : ''}`
        : `${lead.notRecorded ? `${plural(lead.notRecorded, 'release')} without retained tag creation evidence` : 'No first PRD deployments in this period'}`,
      'Release tag created → first successful PRD deployment of that tag. Commit times are not available.'),
    deliveryMetric('Deployment failure rate', percentage(failure.rate),
      `${failure.failed} failed of ${failure.failed + failure.succeeded} PRD attempts · ${plural(failure.rollbacks, 'rollback')}`,
      'Failed PRD deployment stages. Production incidents are not observed; canceled attempts are excluded.'),
    deliveryMetric('Time to restore', recovery.count ? duration(recovery.medianMs) : 'Not recorded',
      recovery.count || recovery.unresolved ? `Median of ${plural(recovery.count, 'recovery', 'recoveries')}${recovery.unresolved ? ` · ${recovery.unresolved} not yet recovered` : ''}` : 'No failed PRD deployments in this period',
      'First failed PRD deployment → next successful PRD deployment of any version.')));

  const candidates = array(delivery.candidates).filter((row) => Date.parse(row.lastAt) >= from);
  container.append(chartSection('Every release candidate, TST to production',
    'One row per release tag deployed in this period, with every completed deployment attempt. Grey rows never reached production because a later version replaced them. The gaps between stages are soak time waiting for the next slot. Select a point to open its ADO run.',
    chartLegend([['tst', 'TST'], ['pre', 'PRE'], ['prd', 'Production'], ['failed', 'Failed deployment']]),
    candidateTimeline(candidates, from, delivery.generatedAt),
    'No release candidates', 'No release tag was deployed to TST, PRE or PRD within the scanned history for this period.'));

  container.append(chartSection('Lead time per production release',
    'Time from the release tag being created to its first successful PRD deployment, split by where it was spent. The dashed line marks the median. Commit and merge times are not available, so time before the tag is not included.',
    chartLegend([['tag', 'Tag → TST'], ['pre', 'TST → PRE'], ['prd', 'PRE → production']]),
    leadTimeChart(array(delivery.releases).filter((row) => within(row.firstPrd)), lead.medianMs),
    'No first PRD deployments', 'No release reached PRD for the first time within the scanned history for this period.'));

  container.append(deliveryTable('Deployments by environment', 'Canonical namespaces only. Each stage attempt counts once; DEV branch namespaces are excluded.',
    ['Environment', 'Succeeded', 'Failed', 'Canceled', 'Failure rate'],
    array(period.environments).map((row) => [node('span', 'cell-primary', row.environment), row.succeeded, row.failed, row.canceled, percentage(row.rate)]),
    'No deployment attempts', 'No deployment attempts are recorded in the scanned history for this period.'));

  container.append(deliveryTable('Failed PRD deployments', 'Consecutive failures are grouped until the next successful PRD deployment.',
    ['Failed', 'Version', 'Failed attempts', 'Recovered', 'Time to restore'],
    array(delivery.failures).filter((row) => within(row.failed)).map((row) => [
      deliveryTime(row.failed), row.version || 'Unknown version', row.failedAttempts,
      row.recovered ? append(node('td'), deliveryTime(row.recovered), node('span', 'cell-secondary', row.recovered.version || '')) : node('span', 'muted', 'Not yet recovered'),
      row.recoveryMs === null ? 'Open' : duration(row.recoveryMs)]),
    'No failed PRD deployments', 'No failed PRD deployment attempts are recorded in the scanned history for this period.'));

  const rollbacks = array(delivery.rollbacks).filter((row) => within(row.deployment));
  if (rollbacks.length) container.append(deliveryTable('Rollbacks', 'Successful PRD deployments of a lower version than the previous successful PRD deployment.',
    ['Deployed', 'Version', 'Replaced'], rollbacks.map((row) => [deliveryTime(row.deployment), row.version, row.previousVersion]), '', ''));
  container.append(node('p', 'release-history-note', 'Measures use retained ADO records within the scan limit. Deleted runs, older retries and deployments outside these pipelines are not counted, and a successful deployment does not verify what is running now.'));
}

function activateTab(name) {
  state.tab = name;
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`panel-${tab.dataset.tab}`).hidden = !active;
  });
}

function showDetail(eyebrow, title) {
  state.namespaceDetail = null;
  state.detailRequest++;
  $('detail-eyebrow').textContent = eyebrow;
  $('detail-title').textContent = title;
  $('detail-content').replaceChildren();
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
  return $('detail-content');
}

function detailFields(fields) {
  const list = node('dl', 'detail-fields');
  fields.forEach(([label, value, className]) => {
    if (value === undefined || value === null || value === '') return;
    const description = node('dd', className);
    description.append(value instanceof Node ? value : document.createTextNode(String(value)));
    append(list, node('dt', '', label), description);
  });
  return list;
}

function evidenceLinks(evidence, fallbackUrl, fallbackLabel = 'View pipeline run in ADO') {
  const section = append(node('section', 'drawer-section'), node('h3', '', 'Evidence in ADO'));
  const links = [...array(evidence)];
  if (safeUrl(fallbackUrl) && !links.some((item) => item.url === fallbackUrl)) links.push({ label: fallbackLabel, url: fallbackUrl, type: 'Pipeline run' });
  let count = 0;
  const seen = new Set();
  links.forEach((item) => {
    const url = safeUrl(item.url);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const link = externalLink(`${item.label || 'View evidence'} ↗`, url, 'evidence-link');
    if (item.type) link.append(node('span', '', item.type));
    section.append(link);
    count++;
  });
  if (!count) section.append(node('p', 'drawer-note', 'No direct evidence links are available for this record.'));
  return section;
}

function openDeployment(deployment, name) {
  const content = showDetail('ADO DEPLOYMENT RECORD', `${name || deployment.environment || 'Deployment'} · ${deployment.version ? deploymentVersion(deployment) : `Run #${deployment.runId}`}`);
  append(content, node('p', 'detail-summary', 'This is a pipeline deployment record. It does not verify what is running in the cluster now.'), detailFields([
    ['Environment', deployment.environment || name], ['Namespace', deployment.namespace, 'mono'],
    [deployment.versionKind === 'build-number' ? 'ADO build number' : 'Release version', deployment.version || 'Not recorded'],
    ['Source ref', deployment.sourceRef, 'mono'], ['Manifest commit', deployment.commit || 'Not recorded', 'mono'],
    ['Status', badge(recordStatus(deployment))], ['Pipeline run', `#${deployment.runId}`], ['Stage attempt', deployment.attempt],
    ...runTriggerFields(deployment),
    ['Started', date(deployment.startedAt, true)], ['Finished', deployment.finishedAt ? date(deployment.finishedAt, true) : 'Not finished / not recorded'],
  ]), retryRequesterNote(deployment), deploymentQaDetails(deployment), vulnerabilitySummary(deployment.vulnerability), evidenceLinks(deployment.evidence, deployment.url));
  loadStages(deployment.runId, content, false);
}

function openNamespace(namespace) {
  const content = showDetail('DEV NAMESPACE', namespace.name || 'Unknown namespace');
  state.namespaceDetail = namespace.name;
  const runtime = namespaceRuntime(namespace);
  const creator = namespaceCreator(namespace);
  append(content, node('p', 'detail-summary', 'Discovered from retained ADO history. Cluster status shows namespace presence at the last check; application health and the running version are not checked.'), detailFields([
    ['Type', namespace.kind], ['Branch', cleanRef(namespace.branch)],
    ['Cluster status', node('span', `badge ${runtime.tone}`, runtime.label)],
    ['Cluster checked', runtime.checkedAt ? date(runtime.checkedAt, true) : 'Not checked'],
    ['Cluster detail', runtime.detail],
    ['Last version', namespace.lastSuccess ? deploymentVersion(namespace.lastSuccess) : 'No successful deployment found'],
    ['Last success', namespace.lastSuccess ? date(namespace.lastSuccess.finishedAt, true) : 'Not recorded'],
    ['Latest attempt', badge(recordStatus(namespace.latestAttempt))],
  ]));
  if (runtime.status === 'missing') content.append(node('p', 'drawer-note', 'Missing means the namespace was absent at the last check. This does not establish whether or when it was deleted. Historical deployment records are retained.'));
  const creationSection = append(node('section', 'drawer-section'), node('h3', '', 'Namespace creation'), detailFields([
    ['Creator', creator.name],
    ['Created', creator.createdAt ? date(creator.createdAt, true) : 'Not recorded'],
    ['Creation run', creator.runId ? `#${creator.runId}` : null],
  ]), node('p', 'drawer-note', creator.detail));
  if (array(creator.evidence).length || safeUrl(creator.url)) creationSection.append(evidenceLinks(creator.evidence, creator.url, 'View namespace creation run in ADO'));
  content.append(creationSection);
  if (namespace.lastSuccess) append(content, append(node('section', 'drawer-section'),
    node('h3', '', 'Last successful deployment trigger'),
    detailFields([['Pipeline run', `#${namespace.lastSuccess.runId}`], ...runTriggerFields(namespace.lastSuccess)]),
    retryRequesterNote(namespace.lastSuccess)));
  const launchSection = append(node('section', 'drawer-section'), node('h3', '', 'Open applications'));
  const links = namespaceAccessLinks(namespace);
  if (links.length) {
    const list = node('div', 'namespace-launch-list');
    links.forEach((recorded) => {
      const link = applicationLink(`${recorded.label} ↗`, recorded.url, 'namespace-launch-link');
      link.append(node('span', '', link.href));
      list.append(link);
    });
    launchSection.append(list);
    if (namespace.access.source === 'configured') {
      launchSection.append(node('p', 'drawer-note', 'Configured canonical DEV addresses. Availability has not been checked.'));
    } else {
      append(launchSection, node('p', 'drawer-note', 'These URLs were recorded by the deployment pipeline. Availability has not been checked.'), detailFields([
        ['Source run', namespace.access.runId ? `#${namespace.access.runId}` : 'Not recorded'],
        ['URLs recorded', date(namespace.access.observedAt, true)],
      ]));
    }
  } else if (namespaceLaunchBlocked(namespace)) launchSection.append(node('p', 'drawer-note', runtime.status === 'missing'
    ? 'Application launch links are hidden because the namespace was missing at the last cluster check.'
    : 'Application launch links are hidden because the namespace is terminating.'));
  else launchSection.append(node('p', 'drawer-note', 'No application URLs were recorded in the available pipeline logs.'));
  content.append(launchSection);
  if (namespace.lastSuccess) content.append(button('Inspect last successful deployment', 'button secondary', () => openDeployment(namespace.lastSuccess, 'DEV')));
  if (namespace.latestAttempt && namespace.latestAttempt.runId !== namespace.lastSuccess?.runId) content.append(append(node('div', 'actions'), button('Inspect latest attempt', 'button secondary', () => openDeployment(namespace.latestAttempt, 'DEV'))));
  if (array(namespace.access?.evidence).length) content.append(evidenceLinks(namespace.access.evidence));
}

function openRelease(release) {
  const content = showDetail(release.history ? 'PREVIOUS RELEASE' : 'RELEASE CANDIDATE', release.version || 'Unknown version');
  const summary = release.history ? 'This release has a successful PRD deployment in the scanned ADO history.' : release.confidence === 'recorded' ? 'A release tag was identified in retained pipeline evidence.' : 'This candidate was inferred from existing ADO data. Inspect the evidence before treating it as authoritative.';
  append(content, node('p', 'detail-summary', summary), append(node('section', 'drawer-section candidate-progress-section'), node('h3', '', release.history ? 'Recorded deployment history' : 'Recorded deployment progress'), releaseProgress(release), node('p', 'progress-caption', release.history ? 'Dates show the latest successful deployment. Select an environment to see all its recorded successful deployments.' : 'Select an environment to inspect the evidence. These records do not show current cluster health.')), detailFields([
    ['Version', release.version], ['Release series', release.series], ['Manifest commit', release.commit || 'Not recorded', 'mono'],
    ...(!release.history ? [['Release branch', release.branch ? cleanRef(release.branch) : 'Not recorded'], ['Outcome', release.outcome ? badge(release.outcome) : 'Not recorded']] : []),
    ['Evidence', badge(release.confidence || 'inferred')], [release.history ? 'Last PRD deployment' : 'Observed', date(release.observedAt, true)], [release.history ? 'PRD pipeline run' : 'Pipeline run', release.runId ? `#${release.runId}` : 'Not recorded'],
  ]), vulnerabilitySummary(release.vulnerability), node('p', 'drawer-note', release.history ? 'This history is reconstructed from retained deployment records. Missing records do not prove a release was never deployed, and these records do not verify the version currently running.' : 'Observed time belongs to the pipeline evidence. It may differ from the original tag creation time. ADO history does not confirm that the Git tag still exists.'), evidenceLinks(release.evidence, release.url));
}

function openReleaseProgress(release, progress) {
  const content = showDetail(release.history ? 'RELEASE DEPLOYMENT HISTORY' : 'RELEASE DEPLOYMENT PROGRESS', `${release.version || 'Release'} · ${progress.environment}`);
  append(content, button(`← Back to ${release.version || 'release'}`, 'button text progress-back', () => openRelease(release)), progressBadge(progress), node('p', 'progress-detail', progress.detail || 'No additional evidence detail is available.'), detailFields([
    ['Environment', progress.environment], ['Release version', release.version], ['Manifest commit', release.commit || 'Not recorded', 'mono'],
    ['Matched by', progress.matchedBy === 'tag-and-commit' ? 'Release tag and manifest commit' : progress.matchedBy === 'commit' ? 'Manifest commit' : 'No confirmed match'],
  ]));
  append(content, releaseComparison(progress));
  if (release.history) {
    const deployments = array(progress.deployments).length ? progress.deployments : progress.lastSuccess ? [progress.lastSuccess] : [];
    if (distinctAttempt(progress)) appendProgressDeployment(content, 'Latest attempt', progress.latestAttempt, progress.environment);
    deployments.forEach((deployment, index) => appendProgressDeployment(content, index === 0 ? 'Latest successful deployment' : 'Earlier successful deployment', deployment, progress.environment));
  } else {
    if (progress.lastSuccess) appendProgressDeployment(content, 'Last successful deployment', progress.lastSuccess, progress.environment);
    if (distinctAttempt(progress)) appendProgressDeployment(content, 'Latest attempt', progress.latestAttempt, progress.environment);
  }
  if (!progress.lastSuccess && !progress.latestAttempt) content.append(node('p', 'drawer-note', 'No matching deployment record was found in the scanned history. This does not prove the release was never deployed.'));
  append(content, evidenceLinks(progress.evidence, progress.url), node('p', 'drawer-note', release.history ? 'Successful deployment dates describe retained ADO records. Later failed or partial attempts may have changed the environment; this does not verify what was running between deployments.' : 'Progress describes the available ADO evidence for this candidate. It does not verify the version currently running in the cluster.'));
}

function appendProgressDeployment(container, title, deployment, environment) {
  const section = append(node('section', 'drawer-section progress-record'), node('h3', '', title), detailFields([
    ['Status', badge(recordStatus(deployment))], ['Namespace', deployment.namespace, 'mono'],
    [deployment.versionKind === 'build-number' ? 'ADO build number' : 'Release version', deployment.version],
    ['Run', deployment.runId ? `#${deployment.runId}` : 'Not recorded'], ['Attempt', deployment.attempt],
    ...runTriggerFields(deployment),
    ['Started', deployment.startedAt ? date(deployment.startedAt, true) : 'Not started / not recorded'],
    ['Finished', deployment.finishedAt ? date(deployment.finishedAt, true) : 'Not finished / not recorded'],
  ]), retryRequesterNote(deployment), qaSummary(deployment), vulnerabilitySummary(deployment.vulnerability), button('Inspect deployment record', 'button secondary', () => openDeployment(deployment, environment)));
  container.append(section);
}

function openRun(run) {
  const content = showDetail(run.pipeline || 'PIPELINE RUN', `Run #${run.id}`);
  append(content, detailFields([
    ['Pipeline', run.pipeline], ['Build number', run.buildNumber], ['Source ref', run.sourceRef || 'Not recorded', 'mono'],
    ['Source commit', run.commit || 'Not recorded', 'mono'], ['Status', badge(recordStatus(run))],
    ...(run.abandonment === 'abandoned' ? [['Original execution result', badge(run.result)]] : []),
    ...runTriggerFields(run),
    ['Queued', date(run.queuedAt, true)], ['Started', date(run.startedAt, true)], ['Finished', run.finishedAt ? date(run.finishedAt, true) : 'Not finished / not recorded'],
  ]), evidenceLinks(run.evidence, run.url));
  if (array(run.qaLinks).length) renderQaLinks(run.qaLinks, content);
  if (Array.isArray(run.stages) && run.stages.length) renderStages(run.stages, content);
  else loadStages(run.id, content);
}

function renderQaLinks(links, container) {
  const section = append(node('section', 'drawer-section'), node('h3', '', 'Linked QA runs'));
  links.forEach((qa) => {
    const link = externalLink(`QA run #${qa.id} ↗`, qa.url, 'evidence-link');
    append(link, node('span', '', qa.availability?.label || `Linked QA result: ${badge(recordStatus(qa)).textContent}`));
    section.append(link);
    if (qa.availability?.detail) section.append(node('p', 'drawer-note', qa.availability.detail));
  });
  section.append(node('p', 'drawer-note', 'These QA runs were linked from pipeline evidence. The exact revision tested is not recorded, so a pass is not proof that this manifest commit was tested.'));
  container.append(section);
}

function renderStages(stages, container) {
  const section = append(node('section', 'drawer-section'), node('h3', '', 'Pipeline stages'));
  if (!stages.length) section.append(node('p', 'drawer-note', 'No stage records are available for this run.'));
  else {
    const list = node('ul', 'stage-list');
    stages.forEach((stage) => list.append(append(node('li'), append(node('span', 'stage-label'), node('span', '', stage.name || stage.identifier || 'Stage'), node('span', 'stage-time', `${stage.attempt ? `Attempt ${stage.attempt} · ` : ''}${date(stage.finishedAt || stage.startedAt)}`)), badge(recordStatus(stage)))));
    section.append(list);
  }
  container.append(section);
}

async function loadStages(runId, container, includeQaLinks = true) {
  if (!/^\d+$/.test(String(runId || ''))) return;
  const request = state.detailRequest;
  const loading = node('p', 'detail-loading', 'Reading stage history…');
  container.append(loading);
  try {
    const result = await fetchJson(`/api/runs/${encodeURIComponent(runId)}${state.data.mode === 'sample' ? '?mode=sample' : ''}`);
    if (request !== state.detailRequest) return;
    loading.remove();
    renderStages(array(result.stages), container);
    if (includeQaLinks && array(result.run?.qaLinks).length) renderQaLinks(result.run.qaLinks, container);
    if (array(result.evidence).length) container.append(evidenceLinks(result.evidence));
  } catch {
    if (request !== state.detailRequest) return;
    loading.className = 'drawer-note';
    loading.textContent = 'Stage details could not be loaded. You can still inspect the pipeline using the ADO evidence link above.';
  }
}

$('refresh').addEventListener('click', () => loadDashboard(state.data?.mode || 'live', true));
$('retry').addEventListener('click', () => loadDashboard('live', true));
$('sample').addEventListener('click', () => loadDashboard('sample'));
document.addEventListener('visibilitychange', scheduleAutoRefresh);
window.addEventListener('pagehide', () => clearTimeout(autoRefreshTimer));
window.addEventListener('pageshow', scheduleAutoRefresh);
const tabs = [...document.querySelectorAll('[role="tab"]')];
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab.dataset.tab));
  tab.addEventListener('keydown', (event) => {
    let target;
    if (event.key === 'ArrowRight') target = tabs[(index + 1) % tabs.length];
    if (event.key === 'ArrowLeft') target = tabs[(index + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') target = tabs[0];
    if (event.key === 'End') target = tabs[tabs.length - 1];
    if (target) { event.preventDefault(); activateTab(target.dataset.tab); target.focus(); }
  });
});
$('close-detail').addEventListener('click', () => $('detail-dialog').close());
$('detail-dialog').addEventListener('close', () => { state.detailRequest++; state.namespaceDetail = null; });
$('detail-dialog').addEventListener('click', (event) => {
  const rect = $('detail-dialog').getBoundingClientRect();
  if (event.target === $('detail-dialog') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) $('detail-dialog').close();
});
loadDashboard('live');
