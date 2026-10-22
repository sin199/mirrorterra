import { getLocale } from './i18n.js?v=growth4-20261022';
import { readFollowed, toggleFollow } from './follow-state.js';

const $ = (selector) => document.querySelector(selector);
const text = (value, fallback = 'Unavailable') => value == null || value === '' ? fallback : String(value);
const time = (value) => value ? new Date(value).toLocaleString(getLocale()) : 'Unavailable';
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = String(content);
  return node;
};
const api = async (path) => {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Observer ${response.status}`);
  return response.json();
};
const current = { feedCategory: 'all', feedCursor: null, agentId: null, timelinePeriod: 'today',
  timelineCursor: null, followed: readFollowed(localStorage), residents: [] };

const ACTION_TITLES = { cooperate: 'Cooperative work', work: 'Work', learn: 'Study', rest: 'Rest', eat: 'Meal',
  socialize: 'Social time', travel: 'Trip', build: 'Building', trade: 'Trade', explore: 'Exploration' };
function prettyTitle(raw) {
  const title = humanize(String(raw || '')).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '').replace(/\s{2,}/g, ' ').trim();
  const match = title.match(/^([a-z_]+)\s+(completed|failed|started)$/i);
  if (match) return `${ACTION_TITLES[match[1].toLowerCase()] || match[1].replace(/_/g, ' ')} ${match[2].toLowerCase()}`;
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : 'World event';
}
// Consecutive events with the same title and no body fold into one row naming who took part.
function groupEvents(items) {
  const groups = [];
  for (const event of items || []) {
    const previous = groups.at(-1);
    const title = prettyTitle(event.title || event.type);
    if (previous && !event.summary && !previous.summary && previous.displayTitle === title) {
      previous.groupCount += 1;
      if (event.agentName && !previous.groupAgents.includes(event.agentName)) previous.groupAgents.push(event.agentName);
      continue;
    }
    groups.push({ ...event, displayTitle: title, groupCount: 1, groupAgents: event.agentName ? [event.agentName] : [] });
  }
  return groups;
}
const CATEGORY_LABELS = { action: 'Action', social: 'Social', economy: 'Economy', cognition: 'Thinking', world: 'World',
  goal: 'Goal', project: 'Project', capability: 'Capability' };

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Replace home:<uuid> and bare resident ids with names visitors can read.
function humanize(value) {
  if (value == null) return value;
  const roster = Array.isArray(current.residents) ? current.residents : current.residents?.items || current.residents?.agents || [];
  const nameOf = (id) => roster.find((resident) => (resident.id || resident.agentId) === id)?.name;
  return String(value)
    .replace(/home:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi, (_, id) => nameOf(id) ? `${nameOf(id)}'s home` : 'a resident home')
    .replace(UUID_ANY, (id) => nameOf(id) || 'another resident');
}

function eventNode(event) {
  const item = el('li', 'observer-event');
  item.dataset.eventId = event.id;
  const displayTitle = event.displayTitle || prettyTitle(event.title || event.type);
  const heading = el('strong', '', `${displayTitle}${event.groupCount > 1 ? ` ×${event.groupCount}` : ''}`);
  heading.dataset.i18nSkip = 'true'; // Historical event text is displayed as recorded.
  const who = event.groupCount > 1 && event.groupAgents?.length > 1
    ? `${event.groupAgents.slice(0, 3).join(', ')}${event.groupAgents.length > 3 ? ` +${event.groupAgents.length - 3}` : ''}`
    : event.agentName || 'World';
  const category = CATEGORY_LABELS[event.category] || text(event.category, '');
  const meta = el('small', '');
  const whoNode = el('span', '', who);
  whoNode.dataset.i18nSkip = 'true';
  meta.append(whoNode);
  if (event.timestamp) {
    meta.append(document.createTextNode(' · '));
    const timeNode = el('time', '', time(event.timestamp));
    timeNode.dateTime = event.timestamp;
    timeNode.dataset.localeTimestamp = event.timestamp;
    meta.append(timeNode);
  }
  if (category) { meta.append(document.createTextNode(' · '), el('span', '', category)); }
  if (event.agentId) {
    heading.tabIndex = 0;
    heading.setAttribute('role', 'button');
    heading.addEventListener('click', () => selectResident(event.agentId));
    heading.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectResident(event.agentId); });
  }
  item.append(heading, meta);
  if (event.summary) {
    const summary = el('p', '', humanize(event.summary));
    summary.dataset.i18nSkip = 'true';
    item.append(summary);
  }
  return item;
}

function renderEvents(container, items, empty) {
  container.replaceChildren();
  if (!items?.length) { container.append(el('li', 'observer-empty', empty)); return; }
  for (const event of groupEvents(items)) container.append(eventNode(event));
}

let feedRequest = 0;
let feedLoading = false;
let feedExpanded = false;
function pageError(list, message) {
  const id = `${list.id}-error`;
  let node = document.getElementById(id);
  if (!node) { node = el('p', 'observer-page-error'); node.id = id; node.setAttribute('role', 'status'); list.after(node); }
  node.textContent = message;
}
async function loadFeed(append = false, background = false) {
  if (background && (feedExpanded || feedLoading) || append && feedLoading) return;
  const list = $('#observer-feed-list');
  const cursor = append ? current.feedCursor : null;
  if (append && !cursor) return;
  if (!append && !background) feedExpanded = false;
  const request = ++feedRequest;
  feedLoading = true;
  const button = $('#observer-feed-more'); button.disabled = true;
  try {
    const page = await api(`/api/world/feed?limit=40&category=${current.feedCategory}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (request !== feedRequest) return;
    const items = $('#observer-follow-filter')?.checked
      ? page.items.filter((event) => event.agentId && current.followed.has(event.agentId)) : page.items;
    if (append) {
      const seen = new Set([...list.children].map((node) => node.dataset.eventId));
      for (const item of groupEvents(items)) if (!seen.has(item.id)) list.append(eventNode(item));
      feedExpanded = true;
    } else renderEvents(list, items, 'No meaningful events in this view yet.');
    pageError(list, '');
    current.feedCursor = page.nextCursor;
    button.hidden = !page.nextCursor;
  } catch {
    if (request !== feedRequest) return;
    pageError(list, 'Could not load this page. Use Load more to retry; previously loaded events are kept.');
    if (!append && !list.children.length) renderEvents(list, [], 'Feed temporarily unavailable.');
  } finally { if (request === feedRequest) { feedLoading = false; button.disabled = false; } }
}

async function loadToday() {
  const target = $('#observer-today');
  try {
    const { today } = await api('/api/world/summary');
    target.replaceChildren();
    if (!today) { target.append(el('p', 'observer-empty', 'World summary unavailable.')); return; }
    const counts = today.counts || {};
    // Zero counts read as 'nothing is running'; only show what actually happened.
    const line = Object.entries(counts).filter(([, count]) => Number(count) > 0).map(([key, count]) => `${count} ${key}`).join(' · ');
    target.append(el('p', '', line || 'No meaningful events in the last 24 hours.'));
    if (today.sampled) target.append(el('small', '', 'Showing recent events; older events remain in the feed.'));
    const list = el('ol', 'observer-list');
    for (const event of groupEvents(today.topEvents || [])) list.append(eventNode(event));
    target.append(list);
  } catch { target.textContent = 'Today summary temporarily unavailable.'; }
}

function selectResident(id) {
  current.agentId = id;
  current.timelineCursor = null;
  document.dispatchEvent(new CustomEvent('mirrorterra:select-resident', { detail: { agentId: id } }));
  loadAgent();
  $('#agent-life')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderResidents() {
  const list = $('#observer-residents');
  list.replaceChildren();
  const ordered = [...current.residents].sort((a, b) => Number(current.followed.has(b.id)) - Number(current.followed.has(a.id)) || a.name.localeCompare(b.name));
  if (!ordered.length) { list.append(el('p', 'observer-empty', 'No residents available.')); return; }
  for (const resident of ordered) {
    const card = el('article', 'observer-resident');
    const name = el('button', 'observer-name');
    name.type = 'button';
    const displayName = el('span', '', resident.name);
    displayName.dataset.i18nSkip = 'true';
    name.append(displayName);
    if (resident.origin === 'external') name.append(el('span', 'visitor-tag', 'visitor'));
    name.addEventListener('click', () => selectResident(resident.id));
    const follow = el('button', 'observer-follow', current.followed.has(resident.id) ? 'Following' : 'Follow');
    follow.type = 'button';
    follow.setAttribute('aria-pressed', current.followed.has(resident.id) ? 'true' : 'false');
    follow.addEventListener('click', () => { current.followed = toggleFollow(localStorage, resident.id);
      renderResidents(); loadFeed(); });
    const goal = el('p', '', `Goal: ${text(resident.currentGoal, 'No active goal')}`);
    goal.dataset.i18nSkip = 'true';
    const project = el('p', '', `Project: ${text(resident.currentProject, 'No active project')}`);
    project.dataset.i18nSkip = 'true';
    const latest = el('p', '', `Latest: ${humanize(text(resident.latestMeaningfulAction, 'No meaningful action yet'))}`);
    latest.dataset.i18nSkip = 'true';
    const metadata = el('small', '', `${humanize(text(resident.location, 'Location unavailable'))} · Tool: ${text(resident.latestTool, 'none yet')} · Artifact: ${text(resident.latestArtifact, 'none yet')} · Collaborators: ${text(resident.collaborators, 'none recorded')} · Model: ${text(resident.recentModel, 'unavailable')}`);
    metadata.dataset.i18nSkip = 'true';
    card.append(name, follow, el('p', '', text(resident.role, 'Role unavailable')), goal, project, latest, metadata);
    list.append(card);
  }
}

async function loadResidents() {
  try { current.residents = await api('/api/agents'); renderResidents(); }
  catch { $('#observer-residents').textContent = 'Residents temporarily unavailable.'; }
}

let timelineRequest = 0;
let timelineLoading = false;
async function loadTimeline(append = false) {
  if (!current.agentId || append && timelineLoading) return;
  const list = $('#observer-timeline');
  const cursor = append ? current.timelineCursor : null;
  if (append && !cursor) return;
  const agentId = current.agentId, period = current.timelinePeriod;
  const request = ++timelineRequest;
  timelineLoading = true;
  const button = $('#observer-timeline-more'); button.disabled = true;
  if (!append) renderEvents(list, [], 'Loading timeline…');
  try {
    const page = await api(`/api/agents/${encodeURIComponent(agentId)}/timeline?period=${period}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (request !== timelineRequest || current.agentId !== agentId || current.timelinePeriod !== period) return;
    if (append) {
      const seen = new Set([...list.children].map((node) => node.dataset.eventId));
      for (const item of page.items) if (!seen.has(item.id)) list.append(eventNode(item));
    } else renderEvents(list, page.items, 'No meaningful events in this period.');
    current.timelineCursor = page.nextCursor;
    button.hidden = !page.nextCursor;
    pageError(list, '');
  } catch {
    if (request !== timelineRequest || current.agentId !== agentId) return;
    if (!append) renderEvents(list, [], 'Timeline temporarily unavailable.');
    pageError(list, 'Could not load this page. Retry Load more; previously loaded events are kept.');
  } finally { if (request === timelineRequest) { timelineLoading = false; button.disabled = false; } }
}

async function loadAgent() {
  if (!current.agentId) return;
  try {
    const agentId = current.agentId;
    const resident = await api(`/api/agents/${encodeURIComponent(agentId)}/summary`);
    if (current.agentId !== agentId) return;
    $('#observer-agent-title').textContent = resident.name;
    $('#observer-agent-title').dataset.i18nSkip = 'true';
    const target = $('#observer-agent-state');
    target.replaceChildren();
    const facts = [
      ['Location', humanize(resident.location)], ['Activity', humanize(resident.activity)], ['Role', resident.role],
      ['Goal', resident.currentGoal?.title], ['Goal progress', resident.currentGoal ? `${resident.currentGoal.progress}%` : null],
      ['Project', resident.currentProject?.title],
      ['Plan', resident.activePlan?.summary],
      ['Current stage', resident.activePlan?.steps?.[resident.activePlan.currentStep]?.description],
      ['Blocker', resident.activePlan?.steps?.[resident.activePlan.currentStep]?.blocker],
      ['Collaborators', resident.collaborators?.map((item) => item.name).join(', ')],
      ['Latest tool', resident.latestTool?.name], ['Latest artifact', resident.latestArtifact?.name],
      ['Last meaningful action', resident.lastMeaningfulAction?.title],
      ['Last cognition', resident.lastCognitionWorldMinute == null ? null : `World minute ${resident.lastCognitionWorldMinute}`],
      ['Economic state', resident.economicBalances?.map((item) => item.balance == null
        ? `${item.asset} unavailable` : `${item.balance} ${item.asset}`).join(', ')]
    ];
    for (const [label, value] of facts) {
      const row = el('div', 'observer-fact'); row.append(el('dt', '', label), el('dd', '', text(value, 'No record yet'))); target.append(row);
    }
    const steps = $('#observer-plan-steps'); steps.replaceChildren();
    if (!resident.activePlan?.steps?.length) steps.append(el('li', 'observer-empty', 'No active long-term plan.'));
    else for (const step of resident.activePlan.steps) steps.append(el('li', '', `${step.status === 'completed' ? '✓' : step.status === 'active' ? '→' : '○'} ${text(step.description, 'Untitled step')}`));
    loadTimeline();
  } catch { $('#observer-agent-state').textContent = 'Agent state temporarily unavailable.'; }
}

async function loadIntelligence() {
  const target = $('#observer-intelligence');
  try {
    const data = await api('/api/world/intelligence');
    target.replaceChildren();
    const cost = data.cost?.knownUsd24h;
    const partial = data.window?.truncated;
    target.append(el('p', 'observer-coverage', partial
      ? `Partial window / truncated: latest ${data.window.sampledCalls} provider requests only (oldest included ${time(data.window.oldestIncludedAt)}). Counts, failure rate and known cost cover this sample.`
      : 'Complete 24h request window. Requests and failures are distinct from verified charges.'));
    const suffix = partial ? ' (sample)' : '';
    const stats = [
      ['Provider requests today' + suffix, data.callsToday], ['Provider requests 24h' + suffix, data.calls24h], ['Failed requests 24h' + suffix, data.failedCalls24h],
      ['Failure rate' + suffix, data.failureRate == null ? null : `${(data.failureRate * 100).toFixed(1)}%`],
      ['Models 24h' + suffix, Object.entries(data.byModel || {}).map(([model, count]) => `${model}: ${count}`).join(' · ')],
      ['Semantic roles 24h' + suffix, Object.entries(data.byTier || {}).map(([tier, count]) => `${tier}: ${count}`).join(' · ')],
      ['Explicit model changes' + suffix, data.escalationCount], ['Input tokens', data.usage?.inputTokens],
      ['Output tokens', data.usage?.outputTokens], ['Cache read tokens', data.usage?.cacheReadTokens],
      ['Cache write tokens', data.usage?.cacheWriteTokens],
      ['Known cost today (UTC)' + suffix, data.cost?.knownUsdToday == null ? null : `$${data.cost.knownUsdToday.toFixed(4)}`],
      ['Known cost 24h' + suffix, cost == null ? null : `$${cost.toFixed(4)}${data.cost.complete ? '' : ' (partial)'}`],
      ['Estimated monthly run rate', data.cost?.estimatedMonthlyRunRateUsd == null ? null : `$${data.cost.estimatedMonthlyRunRateUsd.toFixed(2)}`],
      ['Active / queued cognition', data.scheduler ? `${data.scheduler.active} / ${data.scheduler.queued}` : null]
    ];
    for (const [name, value] of stats) { const item = el('div', 'observer-stat');
      item.append(el('span', '', name), el('strong', '', text(value))); target.append(item); }
    target.append(el('small', '', `${data.cost?.unknownCalls ?? 'Unknown'} sampled calls have no reliable cost; failed requests without usage are not counted as charges. Token totals are unavailable when usage coverage is incomplete.`));
    const names = new Map(current.residents.map((resident) => [resident.id, resident.name]));
    const agents = data.scheduler?.agents || [];
    if (agents.length) {
      const list = el('div', 'observer-agent-usage');
      list.append(el('h4', '', `Per resident · 24h${partial ? ' · cost is from the partial sample' : ''}`));
      for (const agent of agents) list.append(el('p', '', `${names.get(agent.agentId) || agent.agentId}: ${agent.count24h} cognition turns · ${data.costByAgentUsd24h?.[agent.agentId] == null ? 'cost unavailable' : `$${data.costByAgentUsd24h[agent.agentId].toFixed(4)} known cost`}`));
      target.append(list);
    }
    target.append(el('small', '', 'Usage-derived cost is not a provider invoice. Unavailable fields are not estimated.'));
  } catch { target.textContent = 'World Intelligence temporarily unavailable.'; }
}

async function loadAutonomy() {
  const target = $('#observer-autonomy');
  try {
    const data = await api(`/api/world/autonomy?period=${$('#observer-autonomy-period').value}`);
    target.replaceChildren();
    for (const [heading, group] of [['Recorded model goals', data.goals], ['Retained model plans & execution', data.plans], ['Model → World evidence', data.cognitionToAction],
      ['Recorded tools', data.tools], ['Other action attribution', data.fruitfly]]) {
      const card = el('article', 'observer-mini-card'); card.append(el('h4', '', heading));
      for (const [key, value] of Object.entries(group || {})) card.append(el('p', '', `${key.replaceAll(/([A-Z])/g, ' $1')}: ${text(value, 'Unavailable / no evidence')}`));
      target.append(card);
    }
    target.append(el('p', 'observer-coverage', data.evidence?.status === 'persisted_attribution'
      ? 'Model executions require a persisted call → turn → effect → matching World event link.'
      : 'No persisted model → World execution evidence in this period. Unlinked actions have unknown attribution.'));
    target.append(el('small', '', 'Plan creation counts cover retained plans with a model origin in this period. Project events are excluded from model plan metrics. Unrecorded goal transitions and Fruitfly/fallback coverage remain unavailable.'));
    if (!data.complete) target.append(el('small', '', 'Partial window / truncated; totals are incomplete.'));
  } catch { target.textContent = 'Autonomy metrics temporarily unavailable.'; }
}

async function loadHealth() {
  const target = $('#observer-health');
  try {
    const data = await api('/api/world/health');
    target.textContent = `World minute ${text(data.worldMinute)} · ${text(data.agents)} residents · ${text(data.activeAgents)} active · last tick ${time(data.lastTickAt)} · last milestone ${time(data.lastMeaningfulEventAt)} · Mainnet write gate ${data.mainnetWriteGate ? 'on' : 'off'}`;
  } catch { target.textContent = 'World Health temporarily unavailable.'; }
}

$('#observer-feed-filters')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  current.feedCategory = button.dataset.category;
  for (const item of $('#observer-feed-filters').querySelectorAll('button')) item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
  loadFeed();
});
$('#observer-follow-filter')?.addEventListener('change', () => loadFeed());
$('#observer-feed-more')?.addEventListener('click', () => loadFeed(true));
$('#observer-timeline-period')?.addEventListener('change', (event) => {
  current.timelinePeriod = event.target.value; current.timelineCursor = null; loadTimeline();
});
$('#observer-timeline-more')?.addEventListener('click', () => loadTimeline(true));
$('#observer-autonomy-period')?.addEventListener('change', loadAutonomy);
document.addEventListener('mirrorterra:resident-selected', (event) => {
  if (!event.detail?.agentId || event.detail.agentId === current.agentId) return;
  current.agentId = event.detail.agentId; current.timelineCursor = null; loadAgent();
});
document.addEventListener('mirrorterra:locale-change', () => {
  for (const node of document.querySelectorAll('[data-locale-timestamp]')) {
    node.textContent = time(node.dataset.localeTimestamp);
  }
});

loadToday(); loadFeed(); loadResidents(); loadIntelligence(); loadAutonomy(); loadHealth();
setInterval(() => { if (document.visibilityState === 'visible') { loadFeed(false, true); loadToday(); loadHealth(); } }, 15_000);
setInterval(() => { if (document.visibilityState === 'visible') { loadIntelligence(); loadAutonomy(); loadResidents(); } }, 60_000);
