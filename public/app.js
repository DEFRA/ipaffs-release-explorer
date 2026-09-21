'use strict';

const $ = (id) => document.getElementById(id);
const AUTO_REFRESH_MS = 3 * 60 * 1000;
const state = { data: null, mode: 'live', tab: 'overview', loading: false, request: 0, detailRequest: 0, lastRefreshAt: 0 };
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
  $('release-count').textContent = array(data.releases).length;
  renderEnvironments();
  renderNamespaces();
  renderCoverage();
  renderReleases();
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
    card.append(main);
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
  const namespaces = array(state.data.namespaces);
  $('namespace-count').textContent = `${namespaces.length} found`;
  const container = $('namespace-table');
  container.replaceChildren();
  if (!namespaces.length) return container.append(empty('No DEV namespaces found', 'Namespace details may be missing from the available logs or deployment records.'));
  const { table, body } = makeTable(['Namespace / branch', 'Type', 'Last recorded version', 'Last success', 'Latest attempt']);
  namespaces.forEach((namespace) => {
    const open = () => openNamespace(namespace);
    const row = clickableRow(open);
    const success = namespace.lastSuccess;
    append(row,
      append(node('td'), button(namespace.name || 'Unknown namespace', 'row-trigger mono', open), node('span', 'cell-secondary truncate', cleanRef(namespace.branch))),
      append(node('td'), badge(namespace.kind || 'Unknown', 'neutral')),
      append(node('td'), node('span', 'cell-primary', success ? deploymentVersion(success) : 'Not recorded'), success ? node('span', 'cell-secondary mono', shortCommit(success.commit)) : null),
      node('td', 'muted', success ? date(success.finishedAt) : 'No success found'),
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

function renderReleases() {
  const container = $('release-list');
  const expanded = new Set([...container.querySelectorAll('.release-expander[open]')].map((item) => item.dataset.series));
  container.replaceChildren();
  const releases = array(state.data.releases).slice().sort(compareVersions);
  if (!releases.length) return container.append(append(node('div', 'surface'), empty('No release candidates found', 'Candidates require retained release-tag evidence from a run whose current state can be checked. Abandoned runs are excluded.')));
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
}

function releasePatch(release, latest) {
  const patch = node('article', 'release-patch');
  const version = button(release.version || 'Unknown version', 'row-trigger patch-version', () => openRelease(release));
  const identity = append(node('div', 'patch-identity'), version);
  if (latest) identity.append(node('span', 'badge neutral', 'Latest patch'));
  append(patch, append(node('div', 'patch-heading'), identity, append(node('div', 'patch-meta'), node('span', 'mono', shortCommit(release.commit)), node('span', '', `Observed ${date(release.observedAt)}`))), releaseProgress(release));
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
  progressEntries(release).forEach((progress) => {
    const tone = progressTone(progress.status);
    const control = button('', `progress-step progress-${tone}`, () => openReleaseProgress(release, progress));
    const label = progress.label || badge(progress.status).textContent;
    control.setAttribute('aria-label', `${progress.environment}: ${label}. View evidence for ${release.version || 'this release'}`);
    if (progress.detail) control.title = progress.detail;
    append(control, node('span', 'progress-environment', progress.environment), node('span', 'progress-label', label));
    const record = progress.latestAttempt || progress.lastSuccess;
    const timestamp = record?.finishedAt || record?.startedAt;
    if (timestamp) control.append(node('span', 'progress-time', date(timestamp)));
    if (progress.lastSuccess && distinctAttempt(progress)) control.append(node('span', 'progress-prior', 'Earlier success recorded'));
    list.append(append(node('li'), control));
  });
  return list;
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
    ['Started', date(deployment.startedAt, true)], ['Finished', deployment.finishedAt ? date(deployment.finishedAt, true) : 'Not finished / not recorded'],
  ]), evidenceLinks(deployment.evidence, deployment.url));
  loadStages(deployment.runId, content);
}

function openNamespace(namespace) {
  const content = showDetail('DEV NAMESPACE', namespace.name || 'Unknown namespace');
  append(content, node('p', 'detail-summary', 'Discovered from retained ADO history. Namespace existence and current health are not checked.'), detailFields([
    ['Type', namespace.kind], ['Branch', cleanRef(namespace.branch)],
    ['Last version', namespace.lastSuccess ? deploymentVersion(namespace.lastSuccess) : 'No successful deployment found'],
    ['Last success', namespace.lastSuccess ? date(namespace.lastSuccess.finishedAt, true) : 'Not recorded'],
    ['Latest attempt', badge(recordStatus(namespace.latestAttempt))],
  ]));
  if (namespace.lastSuccess) content.append(button('Inspect last successful deployment', 'button secondary', () => openDeployment(namespace.lastSuccess, 'DEV')));
  if (namespace.latestAttempt && namespace.latestAttempt.runId !== namespace.lastSuccess?.runId) content.append(append(node('div', 'actions'), button('Inspect latest attempt', 'button secondary', () => openDeployment(namespace.latestAttempt, 'DEV'))));
}

function openRelease(release) {
  const content = showDetail('RELEASE CANDIDATE', release.version || 'Unknown version');
  append(content, node('p', 'detail-summary', release.confidence === 'recorded' ? 'A release tag was identified in retained pipeline evidence.' : 'This candidate was inferred from existing ADO data. Inspect the evidence before treating it as authoritative.'), append(node('section', 'drawer-section candidate-progress-section'), node('h3', '', 'Recorded deployment progress'), releaseProgress(release), node('p', 'progress-caption', 'Select an environment to inspect the evidence. These records do not show current cluster health.')), detailFields([
    ['Version', release.version], ['Release series', release.series], ['Manifest commit', release.commit || 'Not recorded', 'mono'],
    ['Release branch', release.branch ? cleanRef(release.branch) : 'Not recorded'], ['Evidence', badge(release.confidence || 'inferred')],
    ['Outcome', release.outcome ? badge(release.outcome) : 'Not recorded'], ['Observed', date(release.observedAt, true)], ['Pipeline run', release.runId ? `#${release.runId}` : 'Not recorded'],
  ]), node('p', 'drawer-note', 'Observed time belongs to the pipeline evidence. It may differ from the original tag creation time. ADO history does not confirm that the Git tag still exists.'), evidenceLinks(release.evidence, release.url));
}

function openReleaseProgress(release, progress) {
  const content = showDetail('RELEASE DEPLOYMENT PROGRESS', `${release.version || 'Release'} · ${progress.environment}`);
  append(content, button(`← Back to ${release.version || 'release'}`, 'button text progress-back', () => openRelease(release)), progressBadge(progress), node('p', 'progress-detail', progress.detail || 'No additional evidence detail is available.'), detailFields([
    ['Environment', progress.environment], ['Release version', release.version], ['Manifest commit', release.commit || 'Not recorded', 'mono'],
    ['Matched by', progress.matchedBy === 'tag-and-commit' ? 'Release tag and manifest commit' : progress.matchedBy === 'commit' ? 'Manifest commit' : 'No confirmed match'],
  ]));
  if (progress.lastSuccess) appendProgressDeployment(content, 'Last successful deployment', progress.lastSuccess, progress.environment);
  if (distinctAttempt(progress)) appendProgressDeployment(content, 'Latest attempt', progress.latestAttempt, progress.environment);
  if (!progress.lastSuccess && !progress.latestAttempt) content.append(node('p', 'drawer-note', 'No matching deployment record was found in the scanned history. This does not prove the release was never deployed.'));
  append(content, evidenceLinks(progress.evidence, progress.url), node('p', 'drawer-note', 'Progress describes the available ADO evidence for this candidate. It does not verify the version currently running in the cluster.'));
}

function appendProgressDeployment(container, title, deployment, environment) {
  const section = append(node('section', 'drawer-section progress-record'), node('h3', '', title), detailFields([
    ['Status', badge(recordStatus(deployment))], ['Namespace', deployment.namespace, 'mono'],
    [deployment.versionKind === 'build-number' ? 'ADO build number' : 'Release version', deployment.version],
    ['Run', deployment.runId ? `#${deployment.runId}` : 'Not recorded'], ['Attempt', deployment.attempt],
    ['Started', deployment.startedAt ? date(deployment.startedAt, true) : 'Not started / not recorded'],
    ['Finished', deployment.finishedAt ? date(deployment.finishedAt, true) : 'Not finished / not recorded'],
  ]), button('Inspect deployment record', 'button secondary', () => openDeployment(deployment, environment)));
  container.append(section);
}

function openRun(run) {
  const content = showDetail(run.pipeline || 'PIPELINE RUN', `Run #${run.id}`);
  append(content, detailFields([
    ['Pipeline', run.pipeline], ['Build number', run.buildNumber], ['Source ref', run.sourceRef || 'Not recorded', 'mono'],
    ['Source commit', run.commit || 'Not recorded', 'mono'], ['Status', badge(recordStatus(run))],
    ...(run.abandonment === 'abandoned' ? [['Original execution result', badge(run.result)]] : []),
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

async function loadStages(runId, container) {
  if (!/^\d+$/.test(String(runId || ''))) return;
  const request = state.detailRequest;
  const loading = node('p', 'detail-loading', 'Reading stage history…');
  container.append(loading);
  try {
    const result = await fetchJson(`/api/runs/${encodeURIComponent(runId)}${state.data.mode === 'sample' ? '?mode=sample' : ''}`);
    if (request !== state.detailRequest) return;
    loading.remove();
    renderStages(array(result.stages), container);
    if (array(result.run?.qaLinks).length) renderQaLinks(result.run.qaLinks, container);
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
$('detail-dialog').addEventListener('close', () => { state.detailRequest++; });
$('detail-dialog').addEventListener('click', (event) => {
  const rect = $('detail-dialog').getBoundingClientRect();
  if (event.target === $('detail-dialog') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) $('detail-dialog').close();
});
loadDashboard('live');
