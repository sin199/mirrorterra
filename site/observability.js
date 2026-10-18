import { readFollowed, toggleFollow } from './follow-state.js';

const $ = (selector) => document.querySelector(selector);
const text = (value, fallback = 'Unavailable') => value == null || value === '' ? fallback : String(value);
const time = (value) => value ? new Date(value).toLocaleString() : 'Unavailable';
const el = (tag, className, content) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = String(content);
  return node;
};
const api = async (path) => {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`Observer ${response.status}`);
  return response.json();
};
const current = { feedCategory: 'all', feedCursor: null, agentId: null, timelinePeriod: 'today',
  timelineCursor: null, followed: readFollowed(localStorage), residents: [] };

function eventNode(event) {
  const item = el('li', 'observer-event');
  const heading = el('strong', '', event.title || event.type);
  const meta = el('small', '', `${event.agentName || 'World'} · ${event.worldMinute == null ? '' : `World minute ${event.worldMinute} · `}${time(event.timestamp)} · ${event.category}`);
  if (event.agentId) {
    heading.tabIndex = 0;
    heading.setAttribute('role', 'button');
    heading.addEventListener('click', () => selectResident(event.agentId));
    heading.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectResident(event.agentId); });
  }
  item.append(heading, meta);
  if (event.summary) item.append(el('p', '', event.summary));
  return item;
}

function renderEvents(container, items, empty) {
  container.replaceChildren();
  if (!items?.length) { container.append(el('li', 'observer-empty', empty)); return; }
  for (const event of items) container.append(eventNode(event));
}

async function loadFeed(append = false) {
  const list = $('#observer-feed-list');
  const cursor = append ? current.feedCursor : null;
  if (append && !cursor) return;
  try {
    const page = await api(`/api/world/feed?limit=20&category=${current.feedCategory}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    const items = $('#observer-follow-filter')?.checked
      ? page.items.filter((event) => event.agentId && current.followed.has(event.agentId)) : page.items;
    if (append) for (const item of items) list.append(eventNode(item));
    else renderEvents(list, items, 'No meaningful events in this view yet.');
    current.feedCursor = page.nextCursor;
    $('#observer-feed-more').hidden = !page.nextCursor;
  } catch { if (!append) renderEvents(list, [], 'Feed temporarily unavailable.'); }
}

async function loadToday() {
  const target = $('#observer-today');
  try {
    const { today } = await api('/api/world/summary');
    target.replaceChildren();
    if (!today) { target.append(el('p', 'observer-empty', 'World summary unavailable.')); return; }
    const counts = today.counts || {};
    const line = Object.entries(counts).filter(([, count]) => count > 0)
      .map(([key, count]) => `${count} ${key}`).join(' · ');
    target.append(el('p', '', line || 'No meaningful events in the last 24 hours.'));
    if (today.sampled) target.append(el('small', '', 'Showing recent events; older events remain in the feed.'));
    const list = el('ol', 'observer-list');
    for (const event of today.topEvents || []) list.append(eventNode(event));
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
    const name = el('button', 'observer-name', resident.name);
    name.type = 'button';
    name.addEventListener('click', () => selectResident(resident.id));
    const follow = el('button', 'observer-follow', current.followed.has(resident.id) ? 'Following' : 'Follow');
    follow.type = 'button';
    follow.setAttribute('aria-pressed', current.followed.has(resident.id) ? 'true' : 'false');
    follow.addEventListener('click', () => { current.followed = toggleFollow(localStorage, resident.id);
      renderResidents(); loadFeed(); });
    card.append(name, follow, el('p', '', text(resident.role, 'Role unavailable')),
      el('p', '', `Goal: ${text(resident.currentGoal, 'No active goal')}`),
      el('p', '', `Project: ${text(resident.currentProject, 'No active project')}`),
      el('p', '', `Latest: ${text(resident.latestMeaningfulAction, 'No meaningful action yet')}`),
      el('small', '', `${text(resident.location, 'Location unavailable')} · Tool: ${text(resident.latestTool, 'none yet')} · Artifact: ${text(resident.latestArtifact, 'none yet')} · Collaborators: ${text(resident.collaborators, 'none recorded')} · Model: ${text(resident.recentModel, 'unavailable')}`));
    list.append(card);
  }
}

async function loadResidents() {
  try { current.residents = await api('/api/agents'); renderResidents(); }
  catch { $('#observer-residents').textContent = 'Residents temporarily unavailable.'; }
}

async function loadTimeline(append = false) {
  if (!current.agentId) return;
  const list = $('#observer-timeline');
  const cursor = append ? current.timelineCursor : null;
  if (append && !cursor) return;
  try {
    const page = await api(`/api/agents/${encodeURIComponent(current.agentId)}/timeline?period=${current.timelinePeriod}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (append) for (const item of page.items) list.append(eventNode(item));
    else renderEvents(list, page.items, 'No meaningful events in this period.');
    current.timelineCursor = page.nextCursor;
    $('#observer-timeline-more').hidden = !page.nextCursor;
  } catch { if (!append) renderEvents(list, [], 'Timeline temporarily unavailable.'); }
}

async function loadAgent() {
  if (!current.agentId) return;
  try {
    const resident = await api(`/api/agents/${encodeURIComponent(current.agentId)}/summary`);
    $('#observer-agent-title').textContent = resident.name;
    const target = $('#observer-agent-state');
    target.replaceChildren();
    const facts = [
      ['Location', resident.location], ['Activity', resident.activity], ['Role', resident.role],
      ['Goal', resident.currentGoal?.title], ['Goal progress', resident.currentGoal?.progress == null
        ? null : `${resident.currentGoal.progress}%`],
      ['Project', resident.currentProject?.title],
      ['Plan', resident.activePlan?.summary],
      ['Current stage', resident.activePlan?.steps?.[resident.activePlan.currentStep]?.description],
      ['Blocker', resident.activePlan?.steps?.[resident.activePlan.currentStep]?.blocker],
      ['Collaborators', resident.collaborators?.map((item) => item.name).join(', ')],
      ['Relationships', resident.relationships?.map((item) => item.name).join(', ')],
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
    const stats = [
      ['Calls today', data.callsToday], ['Calls 24h', data.calls24h], ['Failed calls 24h', data.failedCalls24h],
      ['Models 24h', Object.entries(data.byModel || {}).map(([model, count]) => `${model}: ${count}`).join(' · ')],
      ['Tiers 24h', Object.entries(data.byTier || {}).map(([tier, count]) => `${tier}: ${count}`).join(' · ')],
      ['Escalations 24h', data.escalationCount], ['Input tokens', data.usage?.inputTokens],
      ['Output tokens', data.usage?.outputTokens], ['Cache read tokens', data.usage?.cacheReadTokens],
      ['Cache write tokens', data.usage?.cacheWriteTokens],
      ['Known cost today (UTC)', data.cost?.knownUsdToday == null ? null : `$${data.cost.knownUsdToday.toFixed(4)}`],
      ['Known cost 24h', cost == null ? null : `$${cost.toFixed(4)}${data.cost.complete ? '' : ' (partial)'}`],
      ['Estimated monthly run rate', data.cost?.estimatedMonthlyRunRateUsd == null ? null : `$${data.cost.estimatedMonthlyRunRateUsd.toFixed(2)}`],
      ['Active / queued cognition', data.scheduler ? `${data.scheduler.active} / ${data.scheduler.queued}` : null]
    ];
    for (const [name, value] of stats) { const item = el('div', 'observer-stat');
      item.append(el('span', '', name), el('strong', '', text(value))); target.append(item); }
    const names = new Map(current.residents.map((resident) => [resident.id, resident.name]));
    const agents = data.scheduler?.agents || [];
    if (agents.length) {
      const list = el('div', 'observer-agent-usage');
      list.append(el('h4', '', 'Per resident · 24h'));
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
    for (const [heading, group] of [['Goals', data.goals], ['Plans', data.plans], ['Projects', data.projects],
      ['Cognition → action', data.cognitionToAction], ['Tools', data.tools], ['Fruitfly dependency', data.fruitfly]]) {
      const card = el('article', 'observer-mini-card'); card.append(el('h4', '', heading));
      for (const [key, value] of Object.entries(group || {})) {
        if (key === 'available' || key === 'reason') continue;
        const displayed = value && typeof value === 'object'
          ? Object.entries(value).map(([name, count]) => `${name}: ${count}`).join(' · ') : text(value);
        card.append(el('p', '', `${key.replaceAll(/([A-Z])/g, ' $1')}: ${displayed}`));
      }
      if (group?.reason) card.append(el('small', '', group.reason.replaceAll('_', ' ')));
      target.append(card);
    }
    if (!data.complete) target.append(el('small', '', 'Some source counts reached the query cap; totals are incomplete.'));
  } catch { target.textContent = 'Autonomy metrics temporarily unavailable.'; }
}

async function loadHealth() {
  const target = $('#observer-health');
  try {
    const data = await api('/api/world/health');
    target.textContent = `World minute ${text(data.worldMinute)} · ${text(data.agents)} residents · ${text(data.activeAgents)} active · last tick ${time(data.lastTickAt)} · last meaningful event ${time(data.lastMeaningfulEventAt)} · Mainnet write gate ${data.mainnetWriteGate ? 'on' : 'off'}`;
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

loadToday(); loadFeed(); loadResidents(); loadIntelligence(); loadAutonomy(); loadHealth();
setInterval(() => { if (document.visibilityState === 'visible') { loadFeed(); loadToday(); } }, 15_000);
setInterval(() => { if (document.visibilityState === 'visible') { loadIntelligence(); loadAutonomy(); loadResidents(); loadHealth(); } }, 60_000);
