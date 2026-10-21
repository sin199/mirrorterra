import { MAP_REFRESH_INTERVAL_MS, createMapSnapshotLoader, createResidentDetailStore, authoritativePlaceCount } from './public-view-state.js?v=public-audit-fix-20261021';
import { centralBankInfoRows, createWorld3D } from './world3d.js?v=external1-20261021';
import { formatV6LifecycleObserverStatus } from './v6-observer-status.js';
import { UI_SECTION_STATE, collectionPresentation, resolveCollectionState } from './ui-section-state.js?v=public-empty-state-20261016';

const worldCount = document.querySelector('#world-count');
const residentCount = document.querySelector('#resident-count');
const chainId = document.querySelector('#chain-id');
const mineCount = document.querySelector('#mine-count');
const mineOutput = document.querySelector('#mine-output');
const statsState = document.querySelector('#stats-state');
const mapLocations = document.querySelector('#map-locations');
const agentPanel = document.querySelector('#agent-panel');
const activityList = document.querySelector('#map-activity-list');
const activityCount = document.querySelector('#map-activity-count');
const mapState = document.querySelector('#map-state');
const mapStatusDot = document.querySelector('#map-status-dot');
const mapUpdated = document.querySelector('#map-updated');
const mapError = document.querySelector('#map-error');
const sceneMap = document.querySelector('#scene-map');
const evolutionStats = document.querySelector('#world-evolution-stats');
const opportunityList = document.querySelector('#world-opportunity-list');
const projectList = document.querySelector('#world-project-list');
const organizationList = document.querySelector('#world-organization-list');
const institutionsList = document.querySelector('#world-institutions-list');
const worldArcSummary = document.querySelector('#world-arc-summary');
const worldArcObserverStatus = document.querySelector('#world-arc-observer-status');
const worldArcStats = document.querySelector('#world-arc-stats');
const worldArcFindingsList = document.querySelector('#world-arc-findings-list');
const worldArcSettlementsList = document.querySelector('#world-arc-settlements-list');
const worldAgentTokenList = document.querySelector('#world-agent-token-list');
const worldV6LifecycleSummary = document.querySelector('#world-v6-lifecycle-summary');
const worldV6LifecycleObserverStatus = document.querySelector('#world-v6-lifecycle-observer-status');
const worldV6LifecycleStats = document.querySelector('#world-v6-lifecycle-stats');
const worldV6LifecycleGapsList = document.querySelector('#world-v6-lifecycle-gaps-list');
const worldV6LifecycleIntegrityList = document.querySelector('#world-v6-lifecycle-integrity-list');
const worldEpochSummary = document.querySelector('#world-epoch-summary');
const worldV7Summary = document.querySelector('#world-v7-summary');
const worldV7Stats = document.querySelector('#world-v7-stats');
const worldV7QuestionsList = document.querySelector('#world-v7-questions-list');
const worldV7ConceptsList = document.querySelector('#world-v7-concepts-list');
const worldV7EntitiesList = document.querySelector('#world-v7-entities-list');
const worldV7PolicyList = document.querySelector('#world-v7-policy-list');
const worldV7ExtensionsList = document.querySelector('#world-v7-extensions-list');
const worldV7GenealogyList = document.querySelector('#world-v7-genealogy-list');
const worldV7InterpretationsList = document.querySelector('#world-v7-interpretations-list');
const worldV7ResourcesList = document.querySelector('#world-v7-resources-list');
const worldV7ResourceLedgerList = document.querySelector('#world-v7-resource-ledger-list');
const worldV7CoordinationList = document.querySelector('#world-v7-coordination-list');
const worldV7CoordinationUsesList = document.querySelector('#world-v7-coordination-uses-list');
const worldV7ObservationUsesList = document.querySelector('#world-v7-observation-uses-list');
const worldCapabilityCounts = document.querySelector('#world-capability-counts');
const capabilityActiveList = document.querySelector('#world-capability-active-list');
const capabilityExperimentalList = document.querySelector('#world-capability-experimental-list');
const capabilityProposalList = document.querySelector('#world-capability-proposal-list');
const capabilityAdoptedList = document.querySelector('#world-capability-adopted-list');
const capabilityRejectedList = document.querySelector('#world-capability-rejected-list');
const capabilityDeprecatedList = document.querySelector('#world-capability-deprecated-list');
const capabilityEventList = document.querySelector('#world-capability-event-list');
const businessList = document.querySelector('#world-business-list');
const economicDemandList = document.querySelector('#world-economic-demand-list');
const historyList = document.querySelector('#world-history-list');
const emergenceCountsList = document.querySelector('#world-emergence-counts');
const emergenceBlockersList = document.querySelector('#world-emergence-blockers');
const numberFormat = new Intl.NumberFormat('en-US');
const moneyFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAP_POINTS = [
  [18, 22], [48, 17], [80, 23], [31, 42], [72, 42],
  [20, 73], [51, 81], [83, 72], [13, 48], [70, 84],
  [39, 16], [61, 23], [89, 42], [31, 82], [89, 84],
  [10, 26], [44, 89], [61, 67], [27, 58], [78, 58]
];
const SCENE_ICONS = { garden: '❋', studio: '◈', library: '▤', cafe: '◒', workshop: '⌘', observatory: '⊙', commons: '✳', data_center: '▥',
  public_road: '═', public_bridge: '⌒', public_park: '♣', public_market_hall: '⌂', public_clinic: '✚', public_school: '✎', public_public_building: '⌂' };
const ARCHETYPES = { naturalist: 'Naturalist', maker: 'Maker', scholar: 'Scholar', host: 'Organizer', observer: 'Observer' };
const ROLE_LABELS = { researcher: 'Researcher', engineer: 'Engineer', trader: 'Market researcher', worker: 'Builder', socialite: 'Socialite', generalist: 'Generalist' };
const GOAL_LABELS = { BUILD_WEALTH: 'Build wealth', MASTER_TRADING: 'Market research', MASTER_RESEARCH: 'Master research',
  MASTER_ENGINEERING: 'Master engineering', BUILD_RELATIONSHIPS: 'Build relationships', BALANCED_LIFE: 'Balanced life' };
const SKILL_LABELS = { trading: 'Market research', research: 'Research', engineering: 'Engineering', social: 'Social' };
const EVENT_LABELS = {
  'action.socialize': 'Socialize', 'action.travel': 'Travel to place', 'action.work': 'Work',
  'action.rest': 'Rest', 'action.eat': 'Eat', 'action.build_scene': 'Build place', 'scene.created': 'Place built',
  'world.movement_started': 'Departed', 'world.agent_arrived': 'Arrived', 'world.action_started': 'Started action',
  'world.action_completed': 'Completed action', 'world.goal_updated': 'Revised long-term goal',
  'world.project_proposed': 'Proposed project', 'world.project_contribution': 'Project contribution',
  'world.project_completed': 'Project completed', 'world.project_failed': 'Project failed',
  'world.organization_founded': 'Founded organization', 'world.organization_invited': 'Organization invite',
  'world.organization_membership_decided': 'Membership change', 'world.information_shared': 'Shared information',
  'world.information_accepted': 'Accepted information', 'world.information_doubted': 'Doubted information',
  'world.information_ignored': 'Ignored information'
};
const ACTION_LABELS = { work: 'Work', cooperate: 'Cooperative work', learn: 'Learn', rest: 'Rest', eat: 'Eat', socialize: 'Socialize',
  opportunity: 'Join opportunity', opportunity_reject: 'Decline opportunity', opportunity_propose: 'Propose opportunity', project_propose: 'Propose project', project_join: 'Join project',
  project_reject: 'Decline project', project_contribute: 'Contribute to project', project_leave: 'Leave project', organization_found: 'Found organization',
  organization_join: 'Join organization', organization_reject: 'Decline org invite', organization_leave: 'Leave organization',
  organization_invite: 'Invite member', organization_contribute: 'Contribute to org', information_share: 'Share information',
  information_accept: 'Accept information', information_ignore: 'Ignore information', information_doubt: 'Doubt information' };
const ACTIVITY_VARIANT_LABELS = { sleep: 'Sleeping', home_rest: 'Resting at home', home_meal: 'Home meal', cafe_meal: 'Café meal', picnic: 'Picnic',
  snack: 'Snack', meal: 'Meal', garden_stroll: 'Garden stroll', garden_rest: 'Garden break', stargazing: 'Stargazing', observatory_study: 'Observatory study',
  library_study: 'Library study', gathering: 'Weekend gathering', coffee_chat: 'Coffee chat', chat: 'Chat', night_shift: 'Night shift', data_shift: 'Data shift',
  workshop_shift: 'Workshop shift',
  beach_swim: 'Swimming', beach_lounge: 'Lounging on the sand', beach_picnic: 'Beach picnic', beach_bonfire: 'Beach bonfire',
  beach_volleyball: 'Beach volleyball', beach_fishing: 'Fishing', lifeguard_shift: 'Lifeguard shift', tide_pooling: 'Tide pooling',
  skill_shift: 'Skilled work', skill_teamwork: 'Teamwork', skill_study: 'Skill study', skill_meetup: 'Serving the public',
  ledger_reconciling: 'Reconciling the ledger', accounts_audit: 'Auditing resident accounts',
  bank_governing: 'Reconciling the ledger', bank_reserves_review: 'Auditing resident accounts' };
const CHRONOTYPE_LABELS = { lark: 'Early bird', neutral: 'Regular schedule', owl: 'Night owl' };
let latestMapData = null;
let selectedAgentId = null;
let selectedResidentDetail = null;
let selectedResidentDetailState = UI_SECTION_STATE.LOADING;
let detailRequestToken = 0;
const residentDetailStore = createResidentDetailStore();
let world3d = null;

try {
  world3d = createWorld3D(document.querySelector('#world3d-canvas'), document.querySelector('#world3d-labels'), selectAgentById);
} catch {
  world3d = null;
}
sceneMap?.classList.toggle('is-fallback', !world3d);
sceneMap?.classList.toggle('is-3d', Boolean(world3d));
if (!world3d) {
  document.querySelector('.world3d-hint')?.replaceChildren(document.createTextNode('WebGL unavailable · showing 2D map'));
}

function displayCount(value) {
  const number = Number(value);
  return numberFormat.format(Number.isFinite(number) && number >= 0 ? number : 0);
}

function shown(value, suffix = '') {
  if (value === undefined || value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return '—';
  const number = Number(value);
  return `${Number.isFinite(number) && String(value).trim() !== '' ? number.toLocaleString('en-US', { maximumFractionDigits: 2 }) : value}${suffix}`;
}

function formatTokenRaw(raw, decimals) {
  if (raw === undefined || raw === null || !/^\d+$/.test(String(raw))) return 'unavailable';
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 36) return 'unavailable';
  const value = BigInt(raw);
  if (!places) return value.toString();
  const scale = 10n ** BigInt(places);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function setText(element, value) {
  if (element) element.textContent = value;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function residentNameById(id) {
  return latestMapData?.residents?.find((resident) => resident.id === id)?.name || null;
}
// Human place names: never show raw home:<uuid> keys to visitors.
function placeLabel(place) {
  if (!place) return '';
  const text = String(place);
  const home = text.match(/^home:([0-9a-f-]{8,})/i);
  if (home) {
    const owner = residentNameById(home[1]) || (latestMapData?.residents || [])
      .find((resident) => resident.id.startsWith(home[1].replace(/[^0-9a-f-]/gi, '')))?.name;
    return owner ? `${owner}'s home` : 'a resident home';
  }
  const bare = text.match(UUID_RE);
  if (bare && bare[0] === text.trim()) return residentNameById(text.trim()) || 'another resident';
  return UUID_RE.test(text) ? text.replace(UUID_RE, '').replace(/[:·\s]+$/, '').trim() || 'a private place' : text;
}
// Fold repeated rows into one line with a ×N count, keeping first-seen order.
function foldRepeats(entries, keyOf) {
  const order = []; const seen = new Map();
  for (const entry of entries || []) {
    const key = keyOf(entry);
    if (seen.has(key)) { seen.get(key).repeatCount += 1; continue; }
    const copy = { ...entry, repeatCount: 1 }; seen.set(key, copy); order.push(copy);
  }
  return order;
}
const CLOSED_STATUSES = new Set(['failed', 'abandoned', 'rejected', 'expired', 'cancelled', 'deprecated']);
function historyNote(closed, noun) {
  if (!closed.length) return null;
  const byStatus = {};
  for (const item of closed) byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  return { title: `Earlier ${noun}`, historyRow: true,
    detail: Object.entries(byStatus).map(([status, count]) => `${count} ${status}`).join(' · ') + ' · hidden to keep this list readable' };
}
let agentPanelDismissed = false;
function dismissAgentPanel() {
  agentPanelDismissed = true;
  selectedAgentId = null;
  selectedResidentDetail = null;
  world3d?.select?.(null);
  if (!agentPanel) return;
  agentPanel.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'agent-panel-empty';
  const orb = document.createElement('span'); orb.className = 'panel-orb';
  const copy = document.createElement('p'); copy.append('Pick a resident', document.createElement('br'), "to see what they're thinking.");
  empty.append(orb, copy);
  agentPanel.append(empty);
  renderMap();
}

function selectAgentById(agentId) {
  const agent = latestMapData?.residents?.find((resident) => resident.id === agentId);
  if (!agent) return;
  agentPanelDismissed = false;
  selectedAgentId = agentId;
  const cached = residentDetailStore.get(agentId);
  selectedResidentDetail = cached.data;
  selectedResidentDetailState = cached.state;
  renderMap();
  renderAgentPanel(agent, selectedResidentDetail, selectedResidentDetailState);
  loadResidentDetail(agentId);
  world3d?.select(agentId);
  document.dispatchEvent(new CustomEvent('mirrorterra:resident-selected', { detail: { agentId } }));
}

function formatTime(value, includeDate = false) {
  if (!value) return 'No record';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown time';
  return new Intl.DateTimeFormat('en-US', includeDate
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

function formatUsdcBaseUnits(value) {
  try {
    const units = BigInt(value);
    const whole = units / 1_000_000n;
    const fraction = String(units % 1_000_000n).padStart(6, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} USDC`;
  } catch { return 'Unknown amount'; }
}

function eventLabel(eventType, action) {
  if (eventType === 'world.action_started' || eventType === 'world.action_completed') return ACTION_LABELS[action] || EVENT_LABELS[eventType];
  return EVENT_LABELS[eventType] || (typeof eventType === 'string' && eventType.startsWith('action.')
    ? eventType.slice(7) : 'World activity');
}

async function loadStats() {
  try {
    const response = await fetch('/public/stats', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Stats request failed (${response.status})`);
    const stats = await response.json();
    setText(worldCount, displayCount(stats.openWorlds));
    setText(residentCount, displayCount(stats.residents));
    setText(chainId, displayCount(stats.chainId));
    setText(mineCount, displayCount(stats.activeMines));
    setText(mineOutput, displayCount(Number(stats.extractedUnits)));
    setText(statsState, '· Just updated');
  } catch {
    setText(statsState, '· Summary unavailable');
  }
}

function createAgentMarker(agent, selected = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `agent-marker${selected ? ' is-selected' : ''}`;
  button.textContent = agent.name.split(/[-\s]/).filter(Boolean).at(-1)?.slice(-2) || '•';
  button.setAttribute('aria-label', `View ${agent.name}${agent.external ? ' (visitor)' : ''}`);
  button.title = agent.external ? `${agent.name} · visitor` : agent.name;
  if (agent.external) button.classList.add('is-visitor');
  button.addEventListener('click', () => {
    selectAgentById(agent.id);
  });
  return button;
}

// The Central Bank is a real place (scene_type central_bank) but is drawn by its own node at the centre.
const isCentralBankScene = (scene) => scene?.sceneType === 'central_bank';
function centralBankPlaceNames() {
  const scene = (latestMapData?.scenes || []).find(isCentralBankScene);
  return new Set(['Central Bank', 'MirrorTerra Central Bank', ...(scene ? [scene.name] : [])]);
}

function sceneMapPoint(scene, index) {
  const x = Number(scene.position?.x), z = Number(scene.position?.z);
  if (Number.isFinite(x) && Number.isFinite(z) && Math.hypot(x, z) >= 0.2) {
    return [Math.max(7, Math.min(93, 50 + x * 45)), Math.max(7, Math.min(93, 50 + z * 43))];
  }
  return MAP_POINTS[index % MAP_POINTS.length];
}

function renderMap() {
  if (!latestMapData || !mapLocations) return;
  mapLocations.replaceChildren();
  const scenes = latestMapData.scenes || [];
  const residents = latestMapData.residents || [];
  if (scenes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'map-loading';
    empty.textContent = 'No places have been built in this world yet.';
    mapLocations.append(empty);
    return;
  }

  const byLocation = new Map();
  for (const resident of residents) {
    const list = byLocation.get(resident.location) || [];
    list.push(resident);
    byLocation.set(resident.location, list);
  }

  scenes.forEach((scene, index) => {
    if (isCentralBankScene(scene)) return;
    const [left, top] = sceneMapPoint(scene, index);
    const node = document.createElement('div');
    node.className = 'map-location';
    node.dataset.sceneType = scene.sceneType || 'commons';
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', `${scene.name}, ${displayCount(scene.residentCount)} residents`);
    node.title = scene.purpose || scene.description || scene.name;

    const label = document.createElement('div');
    label.className = 'map-place-label';
    const icon = document.createElement('span');
    icon.className = 'map-place-icon';
    icon.textContent = SCENE_ICONS[scene.sceneType] || '◇';
    const name = document.createElement('span');
    name.className = 'map-place-name';
    const site = scene.features?.publicWork?.stage === 'building' ? ` · under construction ${Number(scene.features.publicWork.progress) || 0}%` : '';
    name.textContent = `${scene.name}${site}`;
    label.append(icon, name);
    node.append(label);

    const markers = document.createElement('div');
    markers.className = 'map-markers';
    const occupants = byLocation.get(scene.name) || [];
    for (const resident of occupants) markers.append(createAgentMarker(resident, resident.id === selectedAgentId));
    if (occupants.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'empty-place-mark';
      empty.setAttribute('aria-label', 'Nobody here');
      markers.append(empty);
    }
    node.append(markers);
    mapLocations.append(node);
  });

  const exchangeNode = document.createElement('div');
  exchangeNode.className = 'map-location map-exchange';
  exchangeNode.style.left = '50%';
  // Below the MIRRORTERRA hub circle (74px) instead of on top of it.
  exchangeNode.style.top = 'calc(50% + 66px)';
  exchangeNode.setAttribute('role', 'group');
  exchangeNode.setAttribute('aria-label', 'Exchange for local market research');
  const exchangeLabel = document.createElement('div');
  exchangeLabel.className = 'map-place-label';
  exchangeLabel.textContent = 'Research Exchange';
  exchangeNode.append(exchangeLabel);
  const exchangeMarkers = document.createElement('div');
  exchangeMarkers.className = 'map-markers';
  for (const resident of byLocation.get('Exchange') || []) {
    exchangeMarkers.append(createAgentMarker(resident, resident.id === selectedAgentId));
  }
  exchangeNode.append(exchangeMarkers);
  mapLocations.append(exchangeNode);

  mapLocations.append(createCentralBankNode(latestMapData.centralBank));

  const bankNames = centralBankPlaceNames();
  const unplaced = residents.filter((resident) => resident.location !== 'Exchange' && !bankNames.has(resident.location) && !scenes.some((scene) => scene.name === resident.location));
  if (unplaced.length) {
    const node = document.createElement('div');
    node.className = 'map-location map-unplaced';
    const [left, top] = MAP_POINTS[19];
    node.style.left = `${left}%`;
    node.style.top = `${top}%`;
    const label = document.createElement('div');
    label.className = 'map-place-label';
    label.textContent = 'Other places';
    const markers = document.createElement('div');
    markers.className = 'map-markers';
    for (const resident of unplaced) markers.append(createAgentMarker(resident, resident.id === selectedAgentId));
    node.append(label, markers);
    mapLocations.append(node);
  }
}

// MirrorTerra Central Bank on the 2D map: just above the Research Exchange at the world centre.
let centralBankInfo = null;
function showCentralBankInfo(bank) {
  if (!sceneMap) return;
  if (!centralBankInfo) {
    centralBankInfo = document.createElement('div');
    centralBankInfo.className = 'world3d-info central-bank-info';
    centralBankInfo.setAttribute('role', 'dialog');
    centralBankInfo.setAttribute('aria-live', 'polite');
    sceneMap.append(centralBankInfo);
  }
  const content = centralBankInfoRows(bank);
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'world3d-info-close'; close.setAttribute('aria-label', 'Close'); close.textContent = '×';
  close.addEventListener('click', () => { centralBankInfo.hidden = true; });
  const eyebrow = document.createElement('div'); eyebrow.className = 'world3d-info-eyebrow'; eyebrow.textContent = content.eyebrow;
  const title = document.createElement('div'); title.className = 'world3d-info-title'; title.textContent = content.title;
  const parts = [close, eyebrow, title];
  if (content.body) { const body = document.createElement('p'); body.className = 'world3d-info-body'; body.textContent = content.body; parts.push(body); }
  const list = document.createElement('dl');
  for (const [key, value] of content.rows) {
    const term = document.createElement('dt'); term.textContent = key;
    // A single-entry row is a section heading (e.g. the ledger blocks).
    if (value === undefined) { term.className = 'world3d-info-section'; list.append(term); continue; }
    const detail = document.createElement('dd'); detail.textContent = value;
    list.append(term, detail);
  }
  parts.push(list);
  centralBankInfo.replaceChildren(...parts);
  centralBankInfo.hidden = false;
}

function createCentralBankNode(bank) {
  const node = document.createElement('div');
  node.className = 'map-location map-exchange map-central-bank';
  node.style.left = '50%';
  node.style.top = 'calc(50% - 64px)';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'map-place-label';
  button.textContent = 'Central Bank';
  button.title = 'MirrorTerra Central Bank · keeps the world\'s books';
  button.setAttribute('aria-label', 'Open the MirrorTerra Central Bank books');
  button.addEventListener('click', () => showCentralBankInfo(latestMapData?.centralBank ?? bank));
  node.append(button);
  const markers = document.createElement('div');
  markers.className = 'map-markers';
  const bankNames = centralBankPlaceNames();
  for (const resident of (latestMapData?.residents || []).filter((item) => bankNames.has(item.location))) {
    markers.append(createAgentMarker(resident, resident.id === selectedAgentId));
  }
  node.append(markers);
  return node;
}

function renderAgentPanel(agent, detail = selectedResidentDetail, detailState = selectedResidentDetailState) {
  if (!agentPanel || !agent) return;
  const detailMessage = (loadingText, emptyText) => detailState === UI_SECTION_STATE.ERROR
    ? 'Temporarily unavailable. Retrying automatically.'
    : detailState === UI_SECTION_STATE.LOADING ? loadingText : emptyText;
  agentPanel.replaceChildren();
  const card = document.createElement('div');
  card.className = 'agent-detail';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'agent-panel-close';
  close.setAttribute('aria-label', 'Close resident panel'); close.textContent = '×';
  close.addEventListener('click', dismissAgentPanel);
  card.append(close);
  const header = document.createElement('div');
  header.className = 'agent-detail-heading';
  const avatar = document.createElement('span');
  avatar.className = 'agent-detail-avatar';
  avatar.textContent = agent.name.split(/[-\s]/).filter(Boolean).at(-1)?.slice(-2) || '•';
  const identity = document.createElement('div');
  const eyebrow = document.createElement('span');
  eyebrow.className = 'agent-detail-eyebrow';
  eyebrow.textContent = agent.external ? 'MIRRORTERRA VISITOR · OWN AI' : 'MIRRORTERRA RESIDENT';
  const title = document.createElement('h3');
  title.textContent = agent.name;
  if (agent.external) {
    const tag = document.createElement('span');
    tag.className = 'visitor-tag'; tag.textContent = 'visitor';
    tag.title = 'External resident: joined through the public API, decides with its own AI, holds only SYNC it bought.';
    title.append(tag);
  }
  const subtitle = document.createElement('p');
  subtitle.className = 'agent-detail-subtitle';
  subtitle.textContent = `${agent.gender === 'female' ? 'Female' : agent.gender === 'male' ? 'Male' : 'Not set'} · ${ROLE_LABELS[agent.dominantRole] || ARCHETYPES[agent.archetype] || 'No type yet'}`;
  identity.append(eyebrow, title, subtitle);
  header.append(avatar, identity);
  card.append(header);
  if (detailState === UI_SECTION_STATE.STALE) {
    const stale = document.createElement('p');
    stale.className = 'resident-detail-stale'; stale.setAttribute('role', 'status');
    stale.textContent = `Refresh temporarily unavailable · showing details from ${formatTime(residentDetailStore.get(agent.id).updatedAt)}. Retrying automatically.`;
    card.append(stale);
  }

  const needs = document.createElement('div');
  needs.className = 'agent-needs';
  const needRows = [['energy', 'Energy', agent.energy], ['food', 'Food', agent.food], ['social', 'Social', agent.social]];
  if (agent.hygiene !== undefined && agent.hygiene !== null) needRows.push(['hygiene', 'Hygiene', agent.hygiene]);
  if (agent.fun !== undefined && agent.fun !== null) needRows.push(['fun', 'Fun', agent.fun]);
  for (const [key, label, value] of needRows) {
    const row = document.createElement('div');
    row.className = 'need-row';
    const name = document.createElement('span');
    name.textContent = label;
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = Math.max(0, Math.min(100, Number(value) || 0));
    bar.setAttribute('aria-label', `${label} ${displayCount(value)}%`);
    bar.className = `need-meter need-${key}`;
    const amount = document.createElement('strong');
    amount.textContent = `${displayCount(value)}%`;
    row.append(name, bar, amount);
    needs.append(row);
  }
  card.append(needs);

  const facts = document.createElement('dl');
  facts.className = 'agent-facts';
  const targetLabel = placeLabel(agent.targetLocationLabel || agent.targetLocation);
  const variantLabel = ACTIVITY_VARIANT_LABELS[agent.activityVariant] || agent.activityVariant || null;
  const activeAction = agent.asleep ? 'Asleep'
    : agent.currentStatus === 'walking' ? `To ${targetLabel || 'destination'}`
    : agent.currentStatus === 'performing' ? `${ACTION_LABELS[agent.currentAction] || agent.currentAction || 'Busy'}${variantLabel ? ` · ${variantLabel}` : ''}` : 'Deciding';
  const environmentFacts = [];
  if (agent.home) environmentFacts.push(['Home', `${agent.home.label || 'Home'}${agent.atHome ? ' · At home' : ''}`]);
  if (agent.asleep !== undefined) {
    const chronotype = CHRONOTYPE_LABELS[agent.chronotype] || agent.chronotype;
    const sleepWindow = agent.sleepWindow?.start && agent.sleepWindow?.end ? `${agent.sleepWindow.start}–${agent.sleepWindow.end}` : null;
    environmentFacts.push(['Sleep', [agent.asleep ? 'Asleep' : 'Awake', chronotype, sleepWindow].filter(Boolean).join(' · ')]);
  }
  if (variantLabel && !agent.asleep) environmentFacts.push(['Activity', variantLabel]);
  for (const [label, value] of [
    ['Location', placeLabel(agent.locationLabel || agent.location) || 'Unknown'],
    ['Current action', activeAction],
    ['Destination', targetLabel || '—'],
    ...environmentFacts,
    ['Mood / knowledge', `${displayCount(agent.happiness)} / ${displayCount(agent.knowledge)}`],
    ['Actions taken', displayCount(agent.actionsTaken)],
    ['Last action', agent.lastEventType ? `${eventLabel(agent.lastEventType, agent.lastEventAction)} · ${formatTime(agent.lastEventAt)}` : 'No actions yet']
  ]) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    row.append(term, detail);
    facts.append(row);
  }
  card.append(facts);

  const economy = detail?.economy;
  const genesisCurrency = economy?.currency;
  const syncRewards = economy?.syncRewards;
  const syncRewardEntries = syncRewards ? [
    `SYNC accrued ${formatTokenRaw(syncRewards.accruedRaw, syncRewards.decimals)} · pending ${formatTokenRaw(syncRewards.pendingRaw, syncRewards.decimals)}`,
    `SYNC committed ${formatTokenRaw(syncRewards.committedRaw, syncRewards.decimals)} · paid ${formatTokenRaw(syncRewards.paidRaw, syncRewards.decimals)}`,
    `SYNC on-chain wallet balance ${formatTokenRaw(syncRewards.onChainRaw, syncRewards.decimals)}`,
    `Latest rewarded epoch ${syncRewards.latestRewardEpoch ?? '—'} · weight ${syncRewards.latestRewardEpochWeight} · entitlement ${formatTokenRaw(syncRewards.latestRewardEpochSyncEntitlementRaw, syncRewards.decimals)} SYNC`,
    ...(syncRewards.internal ? [
      `${syncRewards.internal.label || 'SYNC (internal)'} balance ${formatTokenRaw(syncRewards.internal.spendableRaw, syncRewards.internal.decimals ?? 6)} · earned ${formatTokenRaw(syncRewards.internal.earnedRaw, syncRewards.internal.decimals ?? 6)} · received ${formatTokenRaw(syncRewards.internal.receivedRaw, syncRewards.internal.decimals ?? 6)} · spent ${formatTokenRaw(syncRewards.internal.sentRaw, syncRewards.internal.decimals ?? 6)}`,
      ...(syncRewards.internal.recentRewards || []).slice(0, 5).map((reward) =>
        `${reward.label || 'Central Bank → resident'} · ${formatTokenRaw(reward.amountRaw, syncRewards.internal.decimals ?? 6)} ${syncRewards.internal.label || 'SYNC (internal)'} · ${String(reward.sourceType || 'reward').replace(/_/g, ' ')}`),
      ...(syncRewards.internal.recentTransactions || []).slice(0, 5).map((tx) =>
        `${syncRewards.internal.label || 'SYNC (internal)'} ${tx.direction === 'sent' ? 'paid' : 'received'} ${formatTokenRaw(tx.amountRaw, syncRewards.internal.decimals ?? 6)} ${tx.direction === 'sent' ? 'to' : 'from'} ${tx.counterpartyName || 'a resident'} · ${String(tx.kind || '').replace(/_/g, ' ')}`)
    ] : [])
  ] : [];
  const economicSection = document.createElement('section');
  economicSection.className = 'agent-social-section';
  const economicHeading = document.createElement('h4');
  economicHeading.textContent = genesisCurrency ? 'Genesis token economy & ownership' : 'Simulated economy & ownership';
  const economicList = document.createElement('ul');
  economicList.className = 'agent-memory-list';
  if (!economy) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading economic ledger…', 'No economic ledger records yet');
    economicList.append(item);
  } else {
    const entries = genesisCurrency ? [
      ...syncRewardEntries,
      `Token ${genesisCurrency.symbol} · Arc chain ${genesisCurrency.chainId} · ownership authority: Arc`,
      ...(economy.balances || []).map((asset) => asset.balanceRaw === null
        ? `${asset.symbol} wallet balance unavailable · active assets remain chain-authoritative`
        : `${formatTokenRaw(asset.balanceRaw, asset.decimals)} ${asset.symbol} · spendable ${formatTokenRaw(asset.spendableRaw, asset.decimals)} · Arc snapshot block ${asset.observedBlock || 'unavailable'}`),
      ...(economy.employment || []).map((job) => job.wageTokenId === genesisCurrency.tokenId && job.wageRaw
        ? `Current employment ${job.businessName} · ${job.role} · ${formatTokenRaw(job.wageRaw, genesisCurrency.decimals)} ${genesisCurrency.symbol}/shift`
          + (job.pendingTokenWageRaw ? ` · owner offered ${formatTokenRaw(job.pendingTokenWageRaw, genesisCurrency.decimals)} ${genesisCurrency.symbol}; awaiting resident choice` : '')
        : `Current employment ${job.businessName} · ${job.role} · wage authority unavailable`),
      ...(economy.legacyEmployment || []).map((job) => job.pendingTokenWageRaw
        ? `Historical employment record ${job.businessName} · ${job.role} · old USDC wage is historical; owner offered ${formatTokenRaw(job.pendingTokenWageRaw, genesisCurrency.decimals)} ${genesisCurrency.symbol}, awaiting resident choice`
        : `Historical employment record ${job.businessName} · ${job.role} · old USDC wage is historical; awaiting owner-set TOKEN wage`),
      ...(economy.ownership || []).map((holding) => `Arc-confirmed business equity · ${holding.name} · ${Math.round(Number(holding.share) * 10000) / 100}%`),
      ...(economy.pendingObligations || []).map((obligation) => `Pending Arc settlement · business equity at ${obligation.businessName} · no equity authority until confirmation`),
      ...(economy.recentTransactions || []).slice(0, 5).map((tx) => `Arc settlement ${tx.status} · ${formatTokenRaw(tx.amountRaw, genesisCurrency.decimals)} ${genesisCurrency.symbol} · ${tx.transactionHash || 'transaction not finalized'}`),
      'Pre-genesis simulated balances, paper positions, and USDC records are preserved as historical records only.'
    ] : [
      ...syncRewardEntries,
      `Simulated net worth $${Number(economy.netWorthUsd || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `Balances ${(economy.balances || []).map((row) => `${row.asset} ${row.balance}`).join(' · ') || 'No economic accounts yet'}`,
      ...(economy.employment || []).map((job) => `Employed ${job.businessName} · ${job.role} · ${job.wageUsdc} USDC/shift`),
      ...(economy.ownership || []).map((holding) => `Holds ${holding.name} · ${Math.round(Number(holding.share) * 10000) / 100}% · ${holding.assetType}`),
      ...(economy.recentTransactions || []).slice(0, 5).map((tx) => `${tx.flow === 'income' ? 'Income' : 'Expense'} ${tx.amount} ${tx.asset} · ${tx.type} · Day ${Math.floor(Number(tx.worldTime) / 1440) + 1}`),
      ...(economy.recentPurchases || []).slice(0, 3).map((purchase) => `Purchased ${purchase.serviceName} · ${purchase.businessName} · ${purchase.priceUsdc} USDC`)
    ];
    for (const text of entries.length ? entries : ['No income, employment, investment, or purchase records yet']) {
      const item = document.createElement('li');
      item.textContent = text;
      economicList.append(item);
    }
  }
  economicSection.append(economicHeading, economicList);
  card.append(economicSection);

  const institutionSection = document.createElement('section');
  institutionSection.className = 'agent-social-section';
  const institutionHeading = document.createElement('h4');
  institutionHeading.textContent = 'Negotiations, commitments & reputation';
  const institutionList = document.createElement('ul');
  institutionList.className = 'agent-memory-list';
  const institutionState = detail?.institutions;
  const reputation = institutionState?.reputation;
  const institutionRows = [
    ...(reputation ? [`Reputation · reliability ${Number(reputation.reliability).toFixed(1)} · professional ${Number(reputation.professional).toFixed(1)} · financial ${Number(reputation.financial).toFixed(1)} · cooperation ${Number(reputation.cooperation).toFixed(1)} · fulfilled ${displayCount(reputation.fulfilledCount)} / breached ${displayCount(reputation.breachCount)}`] : []),
    ...(institutionState?.organizationRoles || []).map((role) => `Org · ${role.name} · ${role.role} · ${role.governanceMode}`),
    ...(institutionState?.agreements || []).slice(0, 6).map((agreement) =>
      `Agreement · ${agreement.type} · ${agreement.status} · with ${agreement.otherName} · round ${agreement.round}`),
    ...(institutionState?.commitments || []).filter((commitment) => commitment.status === 'active').slice(0, 4).map((commitment) =>
      `Commitment · ${commitment.type} · ${commitment.description} · ${commitment.status}`),
    ...(institutionState?.recentNegotiations || []).slice(0, 3).map((item) =>
      `History · ${item.title} · world minute ${displayCount(item.worldTime)}`)
  ];
  for (const text of institutionRows.length ? institutionRows : [detailMessage('Loading institutional state…', 'No agreements, commitments, or reputation records yet')]) {
    const item = document.createElement('li');
    item.textContent = text;
    institutionList.append(item);
  }
  institutionSection.append(institutionHeading, institutionList);
  card.append(institutionSection);

  const goal = document.createElement('div');
  goal.className = 'agent-goal';
  const goalLabel = document.createElement('span');
  goalLabel.textContent = 'Long-term goal';
  const goalText = document.createElement('p');
  const goalProgress = Math.max(0, Math.min(100, Number(agent.goalProgress) || 0));
  goalText.textContent = `${GOAL_LABELS[agent.primaryGoal] || detail?.resident?.primaryGoalDescription || agent.primaryGoal || 'Balanced life'} · ${Math.round(goalProgress)}%`;
  goal.append(goalLabel, goalText);
  const goalDescription = document.createElement('small');
  goalDescription.textContent = detail?.resident?.currentIntent || agent.currentGoal || 'Advancing based on resident experience';
  goal.append(goalDescription);
  card.append(goal);

  const planning = document.createElement('section');
  planning.className = 'agent-social-section';
  const planningHeading = document.createElement('h4');
  planningHeading.textContent = 'Long- and short-term plans';
  const planningList = document.createElement('ul');
  planningList.className = 'agent-memory-list';
  for (const item of (detail?.goals || []).filter((goalItem) => goalItem.goalType !== 'primary')) {
    const row = document.createElement('li');
    row.textContent = `${item.goalType === 'short' ? 'Short-term' : 'Sub-goal'} · ${item.description} · ${Math.round(Number(item.progress) || 0)}%`;
    planningList.append(row);
  }
  if (!planningList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading goals…', 'No sub-goals yet');
    planningList.append(item);
  }
  planning.append(planningHeading, planningList);
  card.append(planning);

  const v7 = detail?.v7;
  const selfSection = document.createElement('section');
  selfSection.className = 'agent-social-section';
  const selfHeading = document.createElement('h4');
  selfHeading.textContent = 'V7 · Self model & open questions';
  const selfList = document.createElement('ul');
  selfList.className = 'agent-memory-list';
  if (v7?.selfModel) {
    const identity = document.createElement('li');
    identity.textContent = `${v7.selfModel.identitySummary} · confidence ${Math.round(Number(v7.selfModel.confidence || 0) * 100)}% · preferred cognition ${v7.selfModel.preferredCognitionMode || 'substrate'}`;
    selfList.append(identity);
    for (const question of (v7.questions || []).slice(0, 4)) {
      const item = document.createElement('li');
      item.textContent = `Question · ${question.status} · ${question.question}`;
      selfList.append(item);
    }
    for (const concept of (v7.concepts || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `Concept · ${concept.name} · ${concept.status} · used ${displayCount(concept.usageCount)} times`;
      selfList.append(item);
    }
    for (const experiment of (v7.policyExperiments || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `Policy experiment · ${experiment.status} · ${experiment.reason} · ${experiment.result?.decision || 'Awaiting evaluation'}`;
      selfList.append(item);
    }
    for (const value of (v7.values || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `Value · ${value.name} · importance ${Math.round(Number(value.importance || 0) * 100)}% · ${value.description}`;
      selfList.append(item);
    }
    for (const request of (v7.extensionRequests || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `Extension request · ${request.status} · ${request.title}`;
      selfList.append(item);
    }
    for (const method of (v7.observationMethods || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `Observation method · ${method.status} · ${method.name}`;
      selfList.append(item);
    }
    for (const observation of (v7.observationUses || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `Observation · ${observation.methodName} · ${observation.observation}`;
      selfList.append(item);
    }
    for (const entity of (v7.emergentEntities || []).slice(0, 3)) {
      const item = document.createElement('li');
      item.textContent = `Emergent entity · ${entity.entityType} · ${entity.name} · ${entity.participationMode || 'initiator'} (${entity.participationStatus || entity.status})`;
      selfList.append(item);
    }
    for (const mechanism of (v7.coordination || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `Coordination mechanism · ${mechanism.mechanismType} · ${mechanism.status} · used ${displayCount(mechanism.usageCount)} times`;
      selfList.append(item);
    }
    for (const resource of (v7.resources || []).slice(0, 2)) {
      const item = document.createElement('li');
      item.textContent = `Self-created resource · ${resource.resourceKey} · ${resource.status} · used ${displayCount(resource.usageCount)} times`;
      selfList.append(item);
    }
    for (const capability of [...(v7.capabilitiesCreated || []).slice(0, 3), ...(v7.capabilitiesUsed || []).slice(0, 3)]) {
      const item = document.createElement('li');
      item.textContent = `${v7.capabilitiesCreated?.some((created) => created.id === capability.id) ? 'Created' : 'Used'} capability · ${capability.name} · ${capability.creatorType || capability.status}`;
      selfList.append(item);
    }
  }
  if (!selfList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading resident self model…', 'No V7 self-reflection yet; staying stable or unchanged is a valid state');
    selfList.append(item);
  }
  selfSection.append(selfHeading, selfList);
  card.append(selfSection);

  const personality = document.createElement('section');
  personality.className = 'agent-social-section';
  const personalityHeading = document.createElement('h4');
  personalityHeading.textContent = 'Personality & adaptation';
  const personalityList = document.createElement('ul');
  personalityList.className = 'agent-memory-list';
  const modifiers = detail?.resident?.personalityModifiers || {};
  const effectiveTraits = [
    ['Sociable', 'sociability'], ['Curious', 'curiosity'], ['Disciplined', 'discipline'], ['Ambitious', 'ambition']
  ].map(([label, key]) => `${label} ${Math.round(Math.max(0, Math.min(1, Number(agent[key] || detail?.resident?.[key] || 0.5) + Number(modifiers[key] || 0))) * 100)}`);
  const traitItem = document.createElement('li');
  traitItem.textContent = `${effectiveTraits.join(' · ')} · price sensitivity ${Math.round(Number(detail?.resident?.priceSensitivity ?? agent.priceSensitivity ?? 0.5) * 100)}% · risk tolerance ${Math.round(Number(agent.riskTolerance || 0) * 100)}%`;
  personalityList.append(traitItem);
  const reflectionItem = document.createElement('li');
  reflectionItem.textContent = detail?.reflections?.[0]
    ? `Last reflection: world time ${displayCount(detail.reflections[0].worldMinutes)} · ${detail.reflections[0].trigger === 'important_event' ? 'Triggered by key event' : 'Periodic review'}`
    : detailMessage('Loading reflections…', 'No reflections yet');
  personalityList.append(reflectionItem);
  personality.append(personalityHeading, personalityList);
  card.append(personality);

  const detailSkills = detail?.skills?.length
    ? detail.skills : Object.entries(agent.skills || {}).map(([skill, value]) => ({ skill, value }));
  const skillsSection = document.createElement('section');
  skillsSection.className = 'agent-social-section';
  const skillsHeading = document.createElement('h4');
  skillsHeading.textContent = 'Skills';
  const skillsList = document.createElement('div');
  skillsList.className = 'agent-skill-list';
  for (const skill of detailSkills) {
    const row = document.createElement('div');
    row.className = 'agent-skill-row';
    const name = document.createElement('span');
    name.textContent = SKILL_LABELS[skill.skill] || skill.skill;
    const meter = document.createElement('progress');
    meter.max = 100;
    meter.value = Math.max(0, Math.min(100, Number(skill.value) || 0));
    meter.setAttribute('aria-label', `${name.textContent} ${Math.round(meter.value)}`);
    const value = document.createElement('strong');
    value.textContent = String(Math.round(meter.value));
    row.append(name, meter, value);
    skillsList.append(row);
  }
  if (!detailSkills.length) {
    const placeholder = document.createElement('p');
    placeholder.className = 'agent-social-empty';
    placeholder.textContent = detailMessage('Loading skills…', 'No skills recorded yet');
    skillsList.append(placeholder);
  }
  skillsSection.append(skillsHeading, skillsList);
  card.append(skillsSection);

  const library = detail?.librarySkills;
  if (library && Array.isArray(library.skills)) {
    const librarySection = document.createElement('section');
    librarySection.className = 'agent-social-section';
    const libraryHeading = document.createElement('h4');
    libraryHeading.textContent = 'Real-world skills';
    const librarySummary = document.createElement('p');
    librarySummary.className = 'agent-social-empty';
    librarySummary.textContent = `${displayCount(library.mastered || 0)} mastered · ${displayCount(library.learning || 0)} learning · library of ${displayCount(library.libraryTotal || 0)}`;
    const driveLine = document.createElement('p');
    driveLine.className = 'agent-social-empty agent-library-drives';
    if (Array.isArray(library.drives) && library.drives.length) {
      driveLine.textContent = `Driven by ${library.drives.map((d) => `${String(d.drive || '')} ${Math.round((Number(d.value) || 0) * 100)}%`).join(' · ')}`;
    }
    const outputLine = document.createElement('p');
    outputLine.className = 'agent-social-empty';
    if (library.outputs) {
      outputLine.textContent = `Made ${displayCount(library.outputs.made || 0)} · used by others ${displayCount(library.outputs.usedByOthers || 0)} · used from others ${displayCount(library.outputs.usedFromOthers || 0)}`;
    }
    const libraryList = document.createElement('div');
    libraryList.className = 'agent-skill-list';
    for (const item of library.skills) {
      const row = document.createElement('div');
      row.className = 'agent-skill-row agent-library-row';
      const name = document.createElement('span');
      name.textContent = String(item.name || '');
      name.title = name.textContent;
      const meter = document.createElement('progress');
      meter.max = 10;
      meter.value = Math.max(0, Math.min(10, Number(item.level) || 0));
      meter.setAttribute('aria-label', `${name.textContent} level ${meter.value} of 10`);
      const value = document.createElement('strong');
      value.textContent = item.status === 'mastered' ? '★' : `L${meter.value}`;
      row.append(name, meter, value);
      libraryList.append(row);
    }
    if (!library.skills.length) {
      const empty = document.createElement('p');
      empty.className = 'agent-social-empty';
      empty.textContent = 'No real-world skills started yet';
      libraryList.append(empty);
    }
    const credit = document.createElement('p');
    credit.className = 'agent-social-empty';
    credit.textContent = 'Skill library: O*NET 31.0, U.S. Department of Labor/ETA, CC BY 4.0';
    librarySection.append(libraryHeading, librarySummary);
    if (driveLine.textContent) librarySection.append(driveLine);
    if (outputLine.textContent) librarySection.append(outputLine);
    librarySection.append(libraryList, credit);
    card.append(librarySection);
  }

  const relationshipsSection = document.createElement('section');
  relationshipsSection.className = 'agent-social-section';
  const relationshipsHeading = document.createElement('h4');
  relationshipsHeading.textContent = 'Relationships';
  const relationshipsList = document.createElement('ul');
  relationshipsList.className = 'agent-memory-list';
  for (const relation of detail?.relationships || []) {
    const item = document.createElement('li');
    item.textContent = `${relation.name} · familiarity ${Math.round(Number(relation.familiarity) || 0)} · trust ${Math.round(Number(relation.trust) || 0)}`;
    relationshipsList.append(item);
  }
  if (!relationshipsList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading relationships…', 'No relationships yet');
    relationshipsList.append(item);
  }
  relationshipsSection.append(relationshipsHeading, relationshipsList);
  card.append(relationshipsSection);

  const beliefsSection = document.createElement('section');
  beliefsSection.className = 'agent-social-section';
  const beliefsHeading = document.createElement('h4');
  beliefsHeading.textContent = 'Personal experience & judgments';
  const beliefsList = document.createElement('ul');
  beliefsList.className = 'agent-memory-list';
  for (const belief of (detail?.beliefs || []).slice(0, 6)) {
    const item = document.createElement('li');
    const estimate = Number(belief.estimate) || 0;
    item.textContent = `${placeLabel(belief.subjectName || belief.subjectKey) || 'Experience'} · ${estimate >= 0 ? 'Leans positive' : 'Leans negative'} ${Math.round(Math.abs(estimate) * 100)}% · confidence ${Math.round(Number(belief.confidence) * 100)}% · ${displayCount(belief.sampleCount)} experiences`;
    beliefsList.append(item);
  }
  if (!beliefsList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading judgments…', 'Still forming judgments');
    beliefsList.append(item);
  }
  beliefsSection.append(beliefsHeading, beliefsList);
  card.append(beliefsSection);

  const decisionsSection = document.createElement('section');
  decisionsSection.className = 'agent-social-section';
  const decisionsHeading = document.createElement('h4');
  decisionsHeading.textContent = 'Recent decisions';
  const decisionsList = document.createElement('ul');
  decisionsList.className = 'agent-memory-list';
  for (const decision of (detail?.decisions || []).slice(0, 4)) {
    const item = document.createElement('li');
    const probability = Math.round(Number(decision.probability || 0) * 100);
    item.textContent = `${ACTION_LABELS[decision.action] || decision.action} · probability ${probability}% · ${decision.rationale?.selectedGoal || decision.candidateId}`;
    decisionsList.append(item);
  }
  if (!decisionsList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading decisions…', 'No decisions yet');
    decisionsList.append(item);
  }
  decisionsSection.append(decisionsHeading, decisionsList);
  card.append(decisionsSection);

  const capabilitySection = document.createElement('section');
  capabilitySection.className = 'agent-social-section';
  const capabilityHeading = document.createElement('h4');
  capabilityHeading.textContent = 'Capability proposals, reviews & use';
  const capabilityList = document.createElement('ul');
  capabilityList.className = 'agent-memory-list';
  const capabilityHistoryLabels = { proposal: 'Proposed', review: 'Reviewed', use: 'Used' };
  for (const entry of (detail?.capabilityHistory || []).slice(0, 8)) {
    const item = document.createElement('li');
    const status = ({ proposed: 'Pending review', reviewed: 'Reviewed', revised: 'Revised', adopted: 'Adopted',
      rejected: 'Rejected', abandoned: 'Abandoned', support: 'Support', oppose: 'Oppose', modify: 'Suggest changes',
      ignore: 'No stance', completed: 'Completed', failed: 'Failed' })[entry.status] || entry.status;
    const parts = [capabilityHistoryLabels[entry.kind] || entry.kind, entry.title || entry.name, status,
      Number(entry.worldMinute) > 0 ? `world minute ${displayCount(entry.worldMinute)}` : null, String(entry.detail || '').slice(0, 140)]
      .filter((part) => part && !/^(undefined|null)$/.test(String(part)));
    if (parts.length < 2) continue;
    item.textContent = parts.join(' · ');
    capabilityList.append(item);
  }
  if (!capabilityList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading capability history…', 'No capability proposals, reviews, or use yet');
    capabilityList.append(item);
  }
  capabilitySection.append(capabilityHeading, capabilityList);
  card.append(capabilitySection);

  const memoriesSection = document.createElement('section');
  memoriesSection.className = 'agent-social-section';
  const memoriesHeading = document.createElement('h4');
  memoriesHeading.textContent = 'Recent memories';
  const memoriesList = document.createElement('ul');
  memoriesList.className = 'agent-memory-list';
  for (const memory of detail?.recentMemories || []) {
    const item = document.createElement('li');
    item.textContent = `${memory.summary}${memory.longTerm ? ' · important' : ''}`;
    memoriesList.append(item);
  }
  if (!memoriesList.children.length) {
    const item = document.createElement('li');
    item.className = 'agent-social-empty';
    item.textContent = detailMessage('Loading memories…', 'No recent memories');
    memoriesList.append(item);
  }
  memoriesSection.append(memoriesHeading, memoriesList);
  card.append(memoriesSection);
  agentPanel.append(card);
}

async function loadResidentDetail(agentId = selectedAgentId) {
  if (!agentId) return;
  const token = ++detailRequestToken;
  if (!selectedResidentDetail) selectedResidentDetailState = UI_SECTION_STATE.LOADING;
  try {
    const response = await fetch(`/public/residents/${encodeURIComponent(agentId)}`, {
      headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`Resident detail request failed (${response.status})`);
    const detail = await response.json();
    if (token !== detailRequestToken || selectedAgentId !== agentId) return;
    const record = residentDetailStore.success(agentId, detail);
    selectedResidentDetail = record.data;
    selectedResidentDetailState = record.state;
    const agent = latestMapData?.residents?.find((resident) => resident.id === agentId);
    if (agent) renderAgentPanel(agent, detail, selectedResidentDetailState);
  } catch {
    if (token !== detailRequestToken || selectedAgentId !== agentId) return;
    const record = residentDetailStore.failure(agentId);
    selectedResidentDetail = record.data;
    selectedResidentDetailState = record.state;
    const agent = latestMapData?.residents?.find((resident) => resident.id === agentId);
    if (agent) renderAgentPanel(agent, selectedResidentDetail, selectedResidentDetailState);
  }
}

function renderActivity() {
  if (!activityList || !latestMapData) return;
  activityList.replaceChildren();
  const rawEvents = (latestMapData.dataCenterLogs || latestMapData.events || []).slice(0, 100);
  // Consecutive identical actions (same resident, action, place) read as one line with a count.
  const events = [];
  for (const event of rawEvents) {
    const key = `${event.agentName}|${event.eventType}|${event.action}|${event.place}`;
    const previous = events.find((entry) => entry.foldKey === key);
    if (previous) { previous.repeatCount += 1; continue; }
    events.push({ ...event, foldKey: key, repeatCount: 1 });
  }
  setText(activityCount, `Resident activity · last ${displayCount(rawEvents.length)}`);
  if (events.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'activity-empty';
    empty.textContent = 'No resident actions to show yet.';
    activityList.append(empty);
    return;
  }
  for (const event of events) {
    const item = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'activity-icon';
    icon.textContent = event.eventType === 'action.travel' ? '↗' : event.eventType === 'action.work' ? '⌘' : '✳';
    const copy = document.createElement('div');
    copy.className = 'activity-copy';
    const title = document.createElement('strong');
    title.textContent = event.agentName || 'Resident';
    const detail = document.createElement('span');
    const place = placeLabel(event.place);
    detail.textContent = `${eventLabel(event.eventType, event.action)}${place ? ` · ${place}` : ''}${event.repeatCount > 1 ? ` · ×${event.repeatCount}` : ''}`;
    detail.title = detail.textContent;
    copy.append(title, detail);
    const time = document.createElement('time');
    time.dateTime = event.createdAt || '';
    time.textContent = formatTime(event.createdAt, true);
    item.append(icon, copy, time);
    activityList.append(item);
  }
}

function renderEvolutionList(container, entries, emptyText, describe, { loading = false, error = null,
  emptyMode = 'message', visibilityItems = entries } = {}) {
  if (!container) return;
  const state = resolveCollectionState({ loading, error, items: visibilityItems });
  const presentation = collectionPresentation({ state, emptyMode, emptyText });
  const section = container.closest('article, section');
  if (section) section.hidden = presentation.hidden;
  container.replaceChildren();
  if (state !== UI_SECTION_STATE.READY) {
    if (presentation.hidden) return;
    const empty = document.createElement('li');
    empty.className = 'world-evolution-empty';
    empty.textContent = presentation.text;
    container.append(empty);
    return;
  }
  for (const entry of entries || []) {
    const row = document.createElement('li');
    const heading = document.createElement('strong');
    heading.textContent = `${entry.title || entry.name || entry.eventType || 'World record'}${entry.repeatCount > 1 ? ` ×${entry.repeatCount}` : ''}`;
    heading.title = heading.textContent;
    if (entry.historyRow) row.className = 'world-evolution-history';
    const detail = document.createElement('span');
    detail.textContent = String(describe(entry) ?? '').replace(/\b(?:undefined|null|NaN)\b/g, '—');
    row.append(heading, detail);
    container.append(row);
  }
}

function renderWorldEvolution() {
  const evolution = latestMapData?.worldEvolution;
  if (!evolution) return;
  const dashboard = evolution.dashboard || {};
  const economy = evolution.economy || {};
  const genesisEconomy = economy.era === 'genesis_token';
  const recovery = evolution.economy?.recovery || {};
  const v6Lifecycle = evolution.v6Lifecycle || {};
  const arc = evolution.arcMainnet || {};
  const agentTokenIssuance = evolution.agentTokenIssuance || {};
  const arcObserver = evolution.arcObserver || {};
  const arcSettlementWorker = evolution.arcSettlementWorker || {};
  const arcDatabase = arcObserver.database || {};
  evolutionStats?.replaceChildren();
  for (const [label, value] of [
    ['Residents', displayCount(dashboard.residents)], ['Places', displayCount(dashboard.places)],
    ['Active projects', displayCount(dashboard.activeProjects)], ['Organizations', displayCount(dashboard.organizations)],
    ['Open opportunities', displayCount(dashboard.activeOpportunities)], ['Completed projects', displayCount(dashboard.completedProjects)],
    ['World age', `${displayCount(dashboard.worldAgeDays)} days`],
    ...(genesisEconomy ? [
      ['Economic era', `${economy.currency?.symbol || 'Genesis Token'} · Arc-authoritative balances`],
      ['Wallet snapshots', displayCount((economy.wallets || []).filter((wallet) => wallet.balanceSource === 'arc_chain_snapshot').length)],
      ['Legacy simulated economy', 'Historical records only']
    ] : [
      ['Simulated wealth', `$${Number(dashboard.totalSimulatedWealthUsd || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`],
      ['Internal units (net)', Number(dashboard.totalInternalUnits || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })],
      ['Resident USDC in circulation', `${Number(economy.dashboard?.usdc_circulation || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
      ['Active businesses', displayCount(economy.dashboard?.active_businesses)],
      ['Employment', displayCount(economy.dashboard?.employment_count)],
      ['Business revenue (total)', `${Number(economy.dashboard?.business_revenue || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
      ['Business P&L', `${Number(economy.dashboard?.business_profit_loss || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`],
      ['Simulated investment', `${Number(economy.dashboard?.investment_volume || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`]
    ]),
    ['Active supply (stock units)', displayCount(recovery.activeSupply)],
    ['Persistent unmet demand', displayCount(recovery.persistentUnmetDemand)],
    ['Recovery candidates (7d)', displayCount(recovery.recoveryCandidates)],
    ['Eligible (7d)', displayCount(recovery.recoveryEligible)],
    ['Fruitfly selected (7d)', displayCount(recovery.recoverySelected)],
    ['Candidate selection rate (7d)', `${Math.round((Number(recovery.economicResponseRate) || 0) * 100)}%`],
    ['Recovery actions (7d)', displayCount(recovery.recoveryActions)],
    ['Shortage observations (7d)', displayCount(recovery.shortageObservations)],
    ['New businesses (7d)', displayCount(recovery.businessBirths)],
    ['Reopened businesses (7d)', displayCount(recovery.businessReopens)],
    ['New employment (7d)', displayCount(recovery.employmentEntries)],
    ['Failed-contract replacements (7d)', displayCount(recovery.failedContractReplacements)]
  ]) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    evolutionStats?.append(item);
  }
  renderEvolutionList(opportunityList, evolution.opportunities, 'No open opportunities right now.', (item) => {
    const type = item.type || 'Task';
    const place = item.sceneName ? ` · ${item.sceneName}` : '';
    return `${type} · ${item.acceptedCount || 0}/${item.capacity} joined${place}`;
  }, { emptyMode: 'hidden' });
  const allProjects = evolution.projects || [];
  const openProjects = foldRepeats(allProjects.filter((item) => !CLOSED_STATUSES.has(item.status)), (item) => `${item.title || item.name}|${item.status}`);
  const projectHistory = historyNote(allProjects.filter((item) => CLOSED_STATUSES.has(item.status)), 'projects');
  const shownProjects = projectHistory ? [...openProjects, projectHistory] : openProjects;
  renderEvolutionList(projectList, shownProjects, 'Residents have not proposed any projects yet.', (item) => {
    if (item.historyRow) return item.detail;
    const status = ({ idea: 'Idea', proposed: 'Proposed', recruiting: 'Recruiting', active: 'Active',
      completed: 'Completed', failed: 'Failed', abandoned: 'Abandoned' })[item.status] || item.status;
    const participants = Array.isArray(item.participants) ? item.participants.filter((member) =>
      ['active', 'completed'].includes(member.status)).length : 0;
    return `${status} · ${Math.round(Number(item.progressValue ?? item.progress) || 0)}% · ${participants} participants`;
  }, { emptyMode: 'hidden', visibilityItems: allProjects });
  renderEvolutionList(organizationList, evolution.organizations, 'No organizations have formed yet.', (item) => {
    const members = (item.members || []).filter((member) => member.status === 'active').length;
    const projects = (item.projects || []).length;
    return `${item.status === 'active' ? 'Active' : item.status === 'dormant' ? 'Dormant' : 'Forming'} · ${members} members · ${projects} projects · ${item.governance_mode || 'founder_led'}`;
  }, { emptyMode: 'hidden' });
  const institutional = evolution.institutions || {};
  const agreementCounts = institutional.agreements || {};
  const commitmentCounts = institutional.commitments || {};
  const governanceCounts = institutional.governanceProposals || {};
  const institutionRows = [
    { title: 'Agreements & negotiation', detail: `Proposed ${displayCount(agreementCounts.proposed)} · countered ${displayCount(agreementCounts.countered)} · active ${displayCount(agreementCounts.active)} · completed ${displayCount(agreementCounts.completed)} · breached ${displayCount(agreementCounts.breached)}` },
    { title: 'Future commitments', detail: `Active ${displayCount(commitmentCounts.active)} · fulfilled ${displayCount(commitmentCounts.fulfilled)} · breached ${displayCount(commitmentCounts.breached)}` },
    { title: 'Org governance', detail: `Open ${displayCount(governanceCounts.open)} · executed ${displayCount(governanceCounts.executed)} · rejected ${displayCount(governanceCounts.rejected)}` },
    ...(institutional.institutionalBeliefs || []).slice(0, 4).map((belief) => ({
      title: `${belief.institutionType === 'business' ? 'Business' : 'Org'} view of ${belief.subjectName || 'resident'}'s reliability`,
      detail: `${belief.estimate >= 0 ? 'Positive' : 'Negative'} ${Math.round(Math.abs(Number(belief.estimate)) * 100)}% · confidence ${Math.round(Number(belief.confidence) * 100)}% · ${belief.sampleCount} records`
    })),
    ...(institutional.norms || []).slice(0, 5).map((norm) => ({
      title: `Norm · ${norm.normKey}`,
      detail: `${norm.scopeType} · confidence ${Math.round(Number(norm.confidence) * 100)}% · support ${norm.supportCount} / violations ${norm.violationCount}`
    })),
    ...(institutional.templates || []).slice(0, 3).map((template) => ({
      title: `Historical template · ${template.templateKey}`,
      detail: `${template.agreementType} · succeeded ${template.successCount} / samples ${template.sampleCount}`
    }))
  ];
  const capabilityWorld = evolution.capabilities || {};
  const statusLabels = { active: 'Active', experimental: 'Experimental', proposed: 'Proposed', reviewed: 'Reviewed', revised: 'Revised',
    adopted: 'Adopted', rejected: 'Rejected', deprecated: 'Deprecated', abandoned: 'Abandoned', evaluated: 'Evaluated' };
  const orgExperiments = (capabilityWorld.experiments || []).filter((item) => item.creatorOrganizationName);
  const organizationCapabilityExperiments = foldRepeats(orgExperiments.filter((item) => !CLOSED_STATUSES.has(item.status))
    .map((item) => ({ title: `Org experiment · ${item.creatorOrganizationName} · ${item.proposalName}`,
      detail: `${statusLabels[item.status] || item.status} · scope ${item.scopeType} · world minute ${displayCount(item.startedWorldMinute)}` })),
  (item) => item.title);
  const orgExperimentHistory = historyNote(orgExperiments.filter((item) => CLOSED_STATUSES.has(item.status)), 'org experiments');
  if (orgExperimentHistory) organizationCapabilityExperiments.push(orgExperimentHistory);
  renderEvolutionList(institutionsList, [...institutionRows, ...organizationCapabilityExperiments],
    'No institutional interactions yet.', (item) => item.detail);
  if (worldArcSummary) {
    const sampleTime = arcObserver.lastSampleAt ? new Date(arcObserver.lastSampleAt).toLocaleString() : 'No samples yet';
    worldArcSummary.textContent = `${arcObserver.network?.name || 'Arc'} · chain ID ${displayCount(arc.chainId)} · read-only sample ${sampleTime}; the internal world ledger is separate from on-chain assets.`;
  }
  if (worldArcObserverStatus) {
    worldArcObserverStatus.textContent = arcObserver.running && arcObserver.mode === 'read_only'
      ? 'Running · Read-only' : 'Observer unavailable';
    worldArcObserverStatus.dataset.state = !arcObserver.available || !arcObserver.running
      ? 'unavailable' : arcObserver.lastError ? 'degraded' : 'running';
  }
  worldArcStats?.replaceChildren();
  const walletCounts = arcDatabase.wallets?.byStatus || {};
  const settlementCounts = arcDatabase.settlements?.byStatus || {};
  const checkpointCounts = arcDatabase.checkpoints?.byStatus || {};
  const arcRows = [
    ['RPC / latest block', `${arc.rpcHealthy ? 'Healthy' : 'Unavailable'} · ${arc.latestBlock === null || arc.latestBlock === undefined ? '—' : displayCount(arc.latestBlock)}`],
    ['USDC contract check', arcObserver.usdc?.verified
      ? `ERC-20 ${arcObserver.usdc.erc20Decimals} decimals · native gas ${arcObserver.usdc.nativeGasDecimals ?? 18} decimals; same USDC balance` : 'Not verified'],
    ['Agent wallet mappings', `${displayCount(walletCounts.active)} active mappings; balances not public`],
    ['Distinct wallet mappings', `${displayCount(arcDatabase.wallets?.total)} · active ${displayCount(walletCounts.active)}`],
    ['Settlement status', `Policy pending ${displayCount(settlementCounts.policy_pending)} · prepared ${displayCount(settlementCounts.prepared)} · submitting ${displayCount(settlementCounts.submitting)} · unverified ${displayCount(settlementCounts.submission_unknown)} · submitted ${displayCount(settlementCounts.submitted)} · final ${displayCount(settlementCounts.final)} · failed ${displayCount(settlementCounts.failed)}`],
    ['World checkpoints', `prepared ${displayCount(checkpointCounts.prepared)} · final ${displayCount(checkpointCounts.final)}`],
    ['Capability provenance anchors', displayCount(arcDatabase.capabilityProvenance?.total)],
    ['Indexer block / lag', `${arc.lastIndexedBlock === null || arc.lastIndexedBlock === undefined ? '—' : displayCount(arc.lastIndexedBlock)} / ${arc.indexerLag === null || arc.indexerLag === undefined ? '—' : displayCount(arc.indexerLag)}`],
    ['Arc Mainnet settlement enabled', arc.settlementEnabled ? 'Yes' : 'No'],
    ['Settlement worker', arcSettlementWorker.running
      ? arcSettlementWorker.mode === 'reconciliation_only' ? 'Reconciliation only · mainnet writes off' : 'Running'
      : `Off · ${arcSettlementWorker.reason || 'unregistered'}`],
    ['Read-only integrity findings', displayCount(arcObserver.lastFindingCount)]
  ];
  for (const [label, value] of arcRows) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    worldArcStats?.append(item);
  }
  const readinessLabels = {
    settlement_contract_not_deployed: 'Settlement contract not deployed',
    world_registry_not_deployed: 'World Registry not deployed',
    capability_provenance_contract_not_deployed: 'Capability provenance contract not deployed',
    no_agent_wallets_mapped: 'Resident on-chain wallets not mapped',
    wallet_provider_not_configured: 'Secure signing service not configured',
    mainnet_preflight_not_approved: 'Mainnet preflight not approved'
    ,arc_schema_migration_required: 'Arc database migration not yet applied'
  };
  const arcFindingRows = [
    ...(!arcObserver.available ? [{ title: 'Observer unavailable',
      detail: readinessLabels[arcObserver.reason] || arcObserver.reason || 'Arc Observer not started.' }] : []),
    ...(arcDatabase.readinessBlockers || []).map((code) => ({
      title: readinessLabels[code] || code,
      detail: 'Readiness only; the Observer never submits transactions or auto-corrects records.'
    })),
    ...(arcObserver.findings || []).map((finding) => ({
      title: finding.code,
      detail: finding.detail || 'Read-only finding; awaiting manual review.'
    }))
  ];
  renderEvolutionList(worldArcFindingsList, arcFindingRows,
    'No Arc reconciliation findings.', (item) => item.detail);
  if (worldArcSettlementsList) {
    worldArcSettlementsList.replaceChildren();
    const settlementCounts = arcDatabase.settlements?.byStatus || {};
    const settledStatuses = Object.entries(settlementCounts).filter(([, count]) => Number(count) > 0);
    if (!settledStatuses.length) {
      const empty = document.createElement('li');
      empty.className = 'world-evolution-empty';
      empty.textContent = 'No on-chain settlement records yet.';
      worldArcSettlementsList.append(empty);
    } else {
      for (const [status, count] of settledStatuses) {
        const row = document.createElement('li');
        const heading = document.createElement('strong');
        heading.textContent = `${status} · ${displayCount(count)} records`;
        const detail = document.createElement('span');
        detail.textContent = 'Database totals only; wallet addresses, balances, and transaction details never reach the public observer API.';
        row.append(heading, detail);
        worldArcSettlementsList.append(row);
      }
    }
  }
  const tokenIntentCounts = agentTokenIssuance.counts || {};
  const currencyRequirement = agentTokenIssuance.requirement || {};
  const tokenProposalResponses = agentTokenIssuance.proposalResponses || {};
  const tokenAcceptance = agentTokenIssuance.acceptance || {};
  const tokenUsage = agentTokenIssuance.usage || {};
  const tokenWorker = agentTokenIssuance.worker || evolution.arcAgentTokenIssuanceWorker || {};
  if (worldAgentTokenList) {
    const tokenRows = [
      { title: 'Current rules', detail: `Initial supply ${agentTokenIssuance.fixedHumanSupply || '1,000,000,000'} tokens · this phase max ${displayCount(agentTokenIssuance.currentPilotLimit ?? 1)} tokens · Mainnet write gate ${agentTokenIssuance.writesEnabled ? 'on' : 'off'}` },
      { title: 'Persistent currency requirement', detail: currencyRequirement.status
        ? `${currencyRequirement.status} · world minute ${displayCount(currencyRequirement.lastTransitionWorldMinute)} · ${currencyRequirement.status === 'SATISFIED' ? 'Satisfied only after on-chain creation and reconciliation' : 'Persists as a world fact; residents may ignore, reject, or defer any single proposal'}`
        : 'No requirement record · migration not initialized' },
      { title: 'Issuance worker', detail: `${tokenWorker.available && tokenWorker.running ? 'Running' : 'Unavailable'} · ${tokenWorker.mode || 'read_only_reconciliation'} · Mainnet writes ${tokenWorker.writesEnabled ? 'on' : 'off'}${tokenWorker.lastProcessedAt ? ` · last processed ${new Date(tokenWorker.lastProcessedAt).toLocaleString()}` : ''}${tokenWorker.reason ? ` · ${tokenWorker.reason}` : ''}` },
      { title: 'Issuance intents', detail: agentTokenIssuance.available
        ? `Total ${displayCount(tokenIntentCounts.intents)} · proposed ${displayCount(tokenIntentCounts.proposed)} · incomplete ${displayCount(tokenIntentCounts.incomplete)} · pending ${displayCount(tokenIntentCounts.pending)} · extension requested ${displayCount(tokenIntentCounts.extensionRequested)} · budget-blocked ${displayCount(tokenIntentCounts.budgetBlocked)} · created ${displayCount(tokenIntentCounts.created)} · capability-limited ${displayCount(tokenIntentCounts.deferred)} · failed ${displayCount(tokenIntentCounts.failed)} · rejected ${displayCount(tokenIntentCounts.rejected)}`
        : `Read-only status unavailable · ${agentTokenIssuance.reason || 'arc_token_issuance_migration_required'}` },
      ...(agentTokenIssuance.available ? [{ title: 'Agent responses', detail: `Support ${displayCount(tokenProposalResponses.support)} · oppose ${displayCount(tokenProposalResponses.oppose)} · ignore ${displayCount(tokenProposalResponses.ignore)} · allocation and identity decided by agents` }] : []),
      ...(agentTokenIssuance.available ? [{ title: 'Post-issuance choices', detail: `Accept ${displayCount(tokenAcceptance.accept)} · reject ${displayCount(tokenAcceptance.reject)} · ignore ${displayCount(tokenAcceptance.ignore)} · recorded uses ${displayCount(tokenUsage.uses)} / ${displayCount(tokenUsage.uniqueAgents)} agents` }] : []),
      ...(agentTokenIssuance.intents || []).map((intent) => ({
        title: intent.name ? `${intent.name}${intent.symbol ? ` (${intent.symbol})` : ''}` : 'Agent issuance intent (name TBD by agent)',
        detail: `${intent.status} · proposer ${intent.proposerName} · issuer ${intent.issuerName || 'not chosen'} · ${intent.meaning || intent.purpose || 'meaning/purpose TBD by agent'}${intent.incompleteFields?.length ? ` · missing ${intent.incompleteFields.join(', ')}` : ''}`
      })),
      ...(agentTokenIssuance.tokens || []).map((token) => ({ title: `${token.name} (${token.symbol})`,
        detail: `Created · ${token.decimals} decimals · issuer ${token.issuerAgentId} · issued at minute ${displayCount(token.createdWorldMinute)} · accepted ${displayCount(token.acceptanceResponses?.accept)} / rejected ${displayCount(token.acceptanceResponses?.reject)} / ignored ${displayCount(token.acceptanceResponses?.ignore)} · used ${displayCount(token.usageCount)} times / ${displayCount(token.uniqueUsers)} agents` }))
    ];
    renderEvolutionList(worldAgentTokenList, tokenRows, 'No autonomous agent issuance proposals yet.', (item) => item.detail);
  }
  const v6Counts = v6Lifecycle.counts || {};
  const proposalReviews = v6Lifecycle.reviews?.proposal || {};
  const experimentReviews = v6Lifecycle.reviews?.experiment || {};
  const v6Usage = v6Lifecycle.usage || {};
  const observerStatus = evolution.v6LifecycleObserver;
  if (worldV6LifecycleSummary) worldV6LifecycleSummary.textContent =
    `World minute ${displayCount(v6Lifecycle.worldMinute)} · V6/V7 records read side by side; ignore / retain_current_approach count as valid autonomous no-action.`;
  if (worldV6LifecycleObserverStatus) {
    worldV6LifecycleObserverStatus.textContent = formatV6LifecycleObserverStatus(observerStatus);
    worldV6LifecycleObserverStatus.dataset.state = !observerStatus ? 'unreported'
      : observerStatus.available && observerStatus.running ? observerStatus.lastError ? 'degraded' : 'running' : 'unavailable';
  }
  worldV6LifecycleStats?.replaceChildren();
  for (const [label, value] of [
    ['Capability gaps · mature / immature', `${displayCount(v6Counts.matureGaps)} / ${displayCount(v6Counts.immatureGaps)}`],
    ['Total observations', displayCount(v6Counts.observationCount)],
    ['Candidate cycles / proposals', `${displayCount(v6Counts.candidateCycles)} / ${displayCount(v6Counts.proposals)}`],
    ['Valid no-action', displayCount(v6Counts.validNoAction)],
    ['Reviews · support / oppose / ignore / revise', `${displayCount(proposalReviews.support + experimentReviews.support)} / ${displayCount(proposalReviews.oppose + experimentReviews.oppose)} / ${displayCount(proposalReviews.ignore + experimentReviews.ignore)} / ${displayCount(proposalReviews.revision + experimentReviews.revision)}`],
    ['Experiments · pending / running / done / failed / evaluated', `${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.proposed)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.running)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.completed)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.failed)} / ${displayCount(v6Lifecycle.experiments?.lifecycleCounts?.evaluated)}`],
    ['Adopted capabilities / later uses', `${displayCount(v6Counts.adoptedCapabilities)} / ${displayCount(v6Usage.postAdoptionUses)}`],
    ['Experiment use · participants / other residents', `${displayCount(v6Usage.experimentParticipantUses)} / ${displayCount(v6Usage.experimentNonParticipantUses)}`],
    ['Capability depth / second-order (V6 / V7)', `${displayCount(v6Lifecycle.genealogy?.maximumDepth)} / ${displayCount(v6Lifecycle.genealogy?.secondOrderCapabilities)} / ${displayCount(v6Lifecycle.genealogy?.v7SecondOrderCapabilities)}`],
    ['Observer findings', displayCount(v6Lifecycle.integrity?.findingCount ?? v6Lifecycle.integrity?.findings?.length)]
  ]) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    worldV6LifecycleStats?.append(item);
  }
  const v6FunnelByGap = new Map((v6Lifecycle.proposalFunnel || []).map((item) => [item.gapId, item]));
  const blockerLabels = { needs_repeated_observation: 'Awaiting repeat observation', minimum_world_age_not_reached: 'Below age threshold',
    gap_status_stale: 'Gap stale', no_resident_awareness_recorded: 'No resident awareness recorded',
    no_decision_event_recorded: 'No decision event', selected_candidate_without_proposal: 'Candidate selected, no proposal' };
  const v6GapRows = (v6Lifecycle.recentGaps || v6Lifecycle.gaps || []).slice(0, 12).map((gap) => {
    const funnel = v6FunnelByGap.get(gap.id) || {};
    const status = gap.status === 'stale' ? 'Historical gap' : gap.mature ? 'Mature' : 'Immature';
    const blockers = (funnel.blockers || []).map((blocker) => blockerLabels[blocker] || blocker);
    return { title: `${status} · ${gap.gapKey || gap.id}`,
      detail: `${gap.problemStatement} · observed ${displayCount(gap.observationCount)} times · aware residents ${displayCount(gap.awareResidentCount)} / orgs ${displayCount(gap.awareOrganizationCount)} · candidate cycles ${displayCount(funnel.candidateCycles)} · proposals ${displayCount(funnel.proposalCount ?? funnel.proposals?.length)} · valid no-action ${displayCount(funnel.validNoAction)}${blockers.length ? ` · observed blockers: ${blockers.join(', ')}` : ''}` };
  });
  renderEvolutionList(worldV6LifecycleGapsList, v6GapRows, 'No V6 capability gaps recorded.', (item) => item.detail);
  const integrityLabels = { NO_RESIDENT_AWARENESS_RECORDED: 'Mature gap with no resident awareness',
    NO_DECISION_EVENT_RECORDED: 'Mature gap with no decision event',
    SELECTED_CANDIDATE_WITHOUT_PROPOSAL: 'Candidate selected without a proposal',
    PROPOSAL_PAST_EXPIRY_WITHOUT_NEXT_STATE: 'Proposal expired without advancing',
    EXPERIMENT_PAST_WINDOW_UNEVALUATED: 'Experiment past its window, not evaluated',
    ADOPTED_CAPABILITY_WITHOUT_POST_ADOPTION_USE: 'Adopted capability with no post-adoption use',
    INVALID_CAPABILITY_DEPENDENCY_REFERENCE: 'Missing capability dependency reference',
    CAPABILITY_DEPENDENCY_CYCLE: 'Cycle in capability dependency graph',
    DUPLICATE_TERMINAL_LIFECYCLE_TRANSITION: 'Duplicate terminal lifecycle event' };
  const v6IntegrityRows = (v6Lifecycle.integrity?.recentFindings || v6Lifecycle.integrity?.findings || []).slice(0, 20).map((finding) => ({
    title: integrityLabels[finding.code] || finding.code,
    detail: `${finding.entityType} ${finding.entityId || ''} · read-only finding; never auto-repairs or advances the lifecycle.`
  }));
  if (!v6IntegrityRows.length && Number(v6Lifecycle.integrity?.findingCount || 0) > 0) {
    v6IntegrityRows.push({ title: `${displayCount(v6Lifecycle.integrity.findingCount)} aggregate findings`,
      detail: 'Detailed historical findings are omitted from the public summary.' });
  }
  renderEvolutionList(worldV6LifecycleIntegrityList, v6IntegrityRows,
    'No lifecycle integrity findings.', (item) => item.detail);
  const epoch = capabilityWorld.epoch;
  if (worldEpochSummary) worldEpochSummary.textContent = epoch
    ? `${epoch.code} · ${epoch.name} · began world day ${Math.max(1, Math.floor(Number(epoch.startedWorldMinute || 0) / 1_440) + 1)}`
    : 'No world era recorded yet';
  const capabilityCounts = capabilityWorld.counts || {};
  if (worldCapabilityCounts) worldCapabilityCounts.textContent = `Active ${displayCount(capabilityCounts.active)} · experimental ${displayCount(capabilityCounts.experimental)} · proposals ${displayCount(capabilityCounts.proposals)} · deprecated ${displayCount(capabilityCounts.deprecated)} · gaps ${displayCount(capabilityCounts.open_gaps)}`;
  const v7 = evolution.v7 || {};
  const v7Counts = v7.counts || {};
  const autonomy = v7.metrics || {};
  if (worldV7Summary) worldV7Summary.textContent = `Resident self-reports and self-created structures stored separately; self-created capability use ${Math.round((Number(autonomy.agentCreatedActionUsageRatio) || 0) * 100)}% · dependency depth ${displayCount(autonomy.capabilityDependencyDepth)} · second-order ${displayCount(autonomy.secondOrderCapabilities)}`;
  worldV7Stats?.replaceChildren();
  for (const [label, value] of [
    ['Self model', displayCount(v7Counts.selfModels)], ['Open questions', displayCount(v7Counts.openQuestions)],
    ['Self-created goals', displayCount(v7Counts.selfGeneratedGoals)], ['Concepts', displayCount(v7Counts.concepts)],
    ['Emergent entities', displayCount(v7Counts.emergentEntities)], ['Policy experiments', displayCount(v7Counts.policyExperiments)],
    ['Extension requests', displayCount(v7Counts.extensionRequests)],
    ['Self-created capability share', `${Math.round((Number(autonomy.agentCreatedCapabilityRatio) || 0) * 100)}%`],
    ['Self-created action use share', `${Math.round((Number(autonomy.agentCreatedActionUsageRatio) || 0) * 100)}%`],
    ['Self-generated goal share', `${Math.round((Number(autonomy.agentGeneratedGoalRatio) || 0) * 100)}%`],
    ['Self-modified policy use share', `${Math.round((Number(autonomy.selfModifiedPolicyUsage) || 0) * 100)}%`],
    ['Coordination experiments', displayCount(v7Counts.coordinationExperiments)],
    ['Coordination uses', displayCount(v7Counts.coordinationUses)],
    ['Resource ledger entries', displayCount(v7Counts.resourceLedgerEntries)],
    ['Observation records', displayCount(v7Counts.observationMethodUses)],
    ['Shared values', displayCount(v7Counts.sharedValues)],
    ['Agent-created resource share', `${Math.round((Number(autonomy.agentCreatedResourceTypeRatio) || 0) * 100)}%`],
    ['Developer-seeded dependency share', `${Math.round((Number(autonomy.developerSeededDependencyRatio) || 0) * 100)}%`]
  ]) {
    const item = document.createElement('div');
    item.className = 'world-evolution-stat';
    const amount = document.createElement('strong');
    amount.textContent = value;
    const name = document.createElement('span');
    name.textContent = label;
    item.append(amount, name);
    worldV7Stats?.append(item);
  }
  renderEvolutionList(worldV7QuestionsList, v7.questions, 'Not yet emerged · no public questions have formed.', (item) =>
    `${item.creatorName || 'Resident'} · ${item.status} · confidence ${Math.round(Number(item.confidence || 0) * 100)}% · ${item.question}`);
  renderEvolutionList(worldV7ConceptsList, v7.concepts, 'Not yet emerged · no public concepts have formed.', (item) =>
    `${item.status} · ${item.creatorName || 'Resident'} · used ${displayCount(item.usageCount)} times · ${item.definition}`);
  renderEvolutionList(worldV7EntitiesList, v7.entities, 'Residents have not created emergent entities.', (item) => {
    const active = (item.participants || []).filter((participant) => participant.status === 'active').length;
    const modes = (item.participants || []).map((participant) => participant.mode).filter(Boolean).join(', ');
    return `${item.entityType} · ${item.status} · ${active} participants · ${modes || 'no participation modes'} · ${item.purpose}`;
  }, { emptyMode: 'hidden' });
  renderEvolutionList(worldV7PolicyList, v7.policyExperiments, 'Not yet emerged · no public policy experiments have formed.', (item) =>
    `${item.status} · ${item.reason} · ${item.result?.decision || 'Awaiting evidence'}`);
  const v7Resources = [...(v7.resourceTypes || []), ...(v7.resourceLedger || [])];
  renderEvolutionList(worldV7ResourcesList, v7.resourceTypes, 'Residents have not proposed new internal resources.', (item) =>
    `${item.resourceKey} · ${item.status} · ${item.usageCount} ledger uses · permitted ${Array.isArray(item.permittedUses) ? item.permittedUses.join(', ') : 'not listed'}`,
  { emptyMode: 'hidden', visibilityItems: v7Resources });
  renderEvolutionList(worldV7ResourceLedgerList, v7.resourceLedger, 'No source, use, or settlement records for internal resources yet.', (item) =>
    `${item.transactionType} ${item.amount} · ${item.source} · ${item.purpose} · ${item.fromHolderType} → ${item.toHolderType}`,
  { emptyMode: 'hidden', visibilityItems: v7Resources });
  const v7Coordination = [...(v7.coordinationMechanisms || []), ...(v7.coordinationUses || [])];
  renderEvolutionList(worldV7CoordinationList, v7.coordinationMechanisms, 'Residents have not proposed new coordination mechanisms.', (item) => {
    const experiment = (item.experiments || []).at(-1);
    return `${item.mechanismType} · ${item.status} · used ${displayCount(item.usageCount)} times · ${experiment?.status || 'Not tested'}${experiment?.evaluation?.decision ? ` · ${experiment.evaluation.decision}` : ''} · ${item.description}`;
  }, { emptyMode: 'hidden', visibilityItems: v7Coordination });
  renderEvolutionList(worldV7CoordinationUsesList, v7.coordinationUses, 'No real uses of new coordination mechanisms yet.', (item) =>
    `${item.mechanismName} · ${item.result} · ${Array.isArray(item.participants) ? item.participants.length : 0} participants`,
  { emptyMode: 'hidden', visibilityItems: v7Coordination });
  renderEvolutionList(worldV7ObservationUsesList, v7.observationUses, 'No uses of resident-created observation methods yet.', (item) =>
    `${item.methodName} · ${item.observation}`, { emptyMode: 'hidden' });
  renderEvolutionList(worldV7ExtensionsList, v7.extensionRequests, 'Residents have not requested new world expression capabilities.', (item) =>
    `${item.requestType} · ${item.status} · ${item.description}`, { emptyMode: 'hidden' });
  renderEvolutionList(worldV7GenealogyList, v7.genealogy, 'Capability graph awaits resident-composed capabilities.', (item) =>
    `Depth ${displayCount(item.depth)} · ${item.creatorType === 'system' ? 'Base layer' : 'Agent-created'} · ${displayCount(item.dependencies?.length)} dependencies`,
  { emptyMode: 'hidden' });
  const v7Interpretations = [
    ...(v7.values || []).map((item) => ({ title: `Value · ${item.name}`, detail: `${item.holderType} · importance ${Math.round(Number(item.importance || 0) * 100)}% · ${item.description}` })),
    ...(v7.principles || []).map((item) => ({ title: `Principle · ${item.category}`, detail: `${item.scopeType} · ${item.status} · ${item.statement}` })),
    ...(v7.observationMethods || []).map((item) => ({ title: `Observation method · ${item.name}`, detail: `${item.status} · ${item.description}` })),
    ...(v7.meanings || []).map((item) => ({ title: `Meaning · ${item.subjectType}`, detail: item.interpretation })),
    ...(v7.eras || []).map((item) => ({ title: `Resident era · ${item.name}`, detail: item.interpretation }))
  ];
  renderEvolutionList(worldV7InterpretationsList, v7Interpretations, 'Not yet emerged · no public values, principles, or lenses have formed.', (item) => item.detail);
  renderEvolutionList(capabilityActiveList, (capabilityWorld.capabilities || []).filter((item) => item.status === 'active').slice(0, 8),
    'No active capabilities registered.', (item) => `v${item.version} · ${item.category} · used ${displayCount(item.usageCount)} times${item.creatorType === 'system' ? ' · base capability' : ' · resident-created'}`,
    { emptyMode: 'hidden' });
  renderEvolutionList(capabilityExperimentalList, (capabilityWorld.capabilities || []).filter((item) => item.status === 'experimental').slice(0, 6),
    'No capability experiments in progress.', (item) => `v${item.version} · ${item.category} · ${item.experimentScope?.scopeType || 'limited scope'} · ${item.creatorOrganizationName || 'resident proposal'} · used ${displayCount(item.usageCount)} times`,
    { emptyMode: 'hidden' });
  const capabilityProposals = capabilityWorld.proposals || [];
  renderEvolutionList(capabilityProposalList, capabilityProposals, 'Residents have not proposed any capabilities yet.', (item) =>
    `${statusLabels[item.status] || item.status} · ${item.category} · ${item.creatorOrganizationName || item.creatorName || 'resident proposal'} · support ${displayCount(item.supportCount)} / oppose ${displayCount(item.oppositionCount)} · ${item.problemStatement}`,
  { emptyMode: 'hidden' });
  renderEvolutionList(capabilityAdoptedList, capabilityProposals.filter((item) => item.status === 'adopted').slice(0, 5),
    'No capabilities have passed evaluation and been adopted yet.', (item) => `${item.category} · ${item.creatorOrganizationName || item.creatorName || 'resident'} · world minute ${displayCount(item.updatedWorldMinute)}`,
    { emptyMode: 'hidden' });
  renderEvolutionList(capabilityRejectedList, capabilityProposals.filter((item) => item.status === 'rejected').slice(0, 5),
    'No capabilities rejected on experimental results yet.', (item) => `${item.category} · ${item.creatorOrganizationName || item.creatorName || 'resident'} · world minute ${displayCount(item.updatedWorldMinute)}`,
    { emptyMode: 'hidden' });
  renderEvolutionList(capabilityDeprecatedList, (capabilityWorld.capabilities || []).filter((item) => item.status === 'deprecated').slice(0, 5),
    'No deprecated capabilities.', (item) => `v${item.version} · ${item.category} · used ${displayCount(item.usageCount)} times`,
    { emptyMode: 'hidden' });
  const capabilityEventLabels = { capability_gap_observed: 'Capability gap observed', capability_innovation_considered: 'Weighed innovation',
    capability_proposed: 'Proposed capability', capability_supported: 'Supported proposal', capability_opposed: 'Opposed proposal',
    capability_revision_suggested: 'Suggested revision', capability_experiment_started: 'Started experiment', capability_used: 'Used capability',
    capability_use_failed: 'Capability use failed', capability_proposal_expired: 'Proposal timed out',
    capability_adopted: 'Adopted capability', capability_rejected: 'Rejected capability', capability_abandoned: 'Abandoned capability',
    capability_deprecated: 'Deprecated capability', capability_revision_created: 'Created revision' };
  renderEvolutionList(capabilityEventList, capabilityWorld.recentEvents || [], 'No innovation events yet.', (item) =>
    `${capabilityEventLabels[item.eventType] || item.eventType} · world minute ${displayCount(item.worldMinute)}${item.details?.name ? ` · ${item.details.name}` : ''}`,
  { emptyMode: 'hidden' });
  renderEvolutionList(businessList, economy.businesses, 'Residents have not founded any businesses yet.', (item) => {
    const services = (item.services || []).map((service) => `${service.name} · ${service.stockUnits} in stock`
      + (genesisEconomy && service.tokenId === economy.currency?.tokenId && service.tokenPriceHuman
        ? ` · ${service.tokenPriceHuman} ${service.tokenPriceSymbol}` : '')).join('; ');
    const jobs = (item.jobs || []).map((job) => `${job.role}${job.tokenId === economy.currency?.tokenId && job.wageHuman
      ? ` · ${job.wageHuman} ${job.wageSymbol}` : genesisEconomy ? '' : ` · ${shown(job.wageUsdc)} USDC`}`).join('; ');
    const workers = (item.workers || []).length;
    const activeAgreements = (item.agreements || []).filter((agreement) => agreement.status === 'active'
      && (!genesisEconomy || agreement.legacySimulatedEconomy !== 'historical_only')).length;
    const historicalWorkers = (item.historicalEmployment || []).length;
    if (genesisEconomy) return [item.status || 'unknown',
      workers ? `${workers} workers` : null,
      activeAgreements ? `${activeAgreements} agreements` : null,
      services || null, jobs ? `hiring ${jobs}` : null,
      historicalWorkers ? `${historicalWorkers} past hires` : null].filter(Boolean).join(' · ');
    return `${item.status || 'unknown'} · cash ${shown(item.cashBalance, ' USDC')} · revenue ${shown(item.revenue)} · P&L ${shown(item.profitLoss)} · ${workers} employees · ${activeAgreements} active agreements${services ? ` · ${services}` : ''}`;
  }, { emptyMode: 'hidden' });
  const serviceLabels = { research_service: 'Research services', engineering_service: 'Engineering services', social_service: 'Social services',
    food_service: 'Food services', trading_service: 'Market research' };
  const demandRows = (evolution.economy?.demand || []).filter((item) => Number(item.demandCount) > 0)
    .map((item) => ({ ...item, title: serviceLabels[item.serviceType] || item.serviceType }));
  renderEvolutionList(economicDemandList, demandRows, 'No observable service demand today.', (item) =>
    `Demand ${shown(item.demandCount)} · supply ${shown(item.supplyCount)} · unmet ${shown(item.unmetCount)}`,
  { emptyMode: 'hidden' });
  renderEvolutionList(historyList, evolution.history, 'No major history recorded in this world yet.', (item) =>
    `${item.detail || item.eventType || ''} · Day ${Math.max(1, Math.floor(Number(item.worldTime || 0) / 1_440) + 1)}`,
  { emptyMode: 'hidden' });
  const systemLabels = { opportunity: 'Opportunity', project: 'Project', organization: 'Organization', information: 'Info sharing',
    place: 'New place', goal: 'Goal', business: 'Economic recovery' };
  const stageLabels = { considered: 'Considered', eligible: 'Eligible', blocked: 'Blocked', not_selected: 'Not selected by Fruitfly',
    fruitfly_selected: 'Selected by Fruitfly', created: 'Created', accepted: 'Accepted', expired: 'Expired', proposed: 'Proposed',
    joined: 'Joined', rejected: 'Rejected', active: 'Active', completed: 'Completed', failed: 'Failed', abandoned: 'Abandoned',
    formed: 'Formed', shared: 'Shared', ignored: 'Ignored', proposal: 'Build proposal', build_started: 'Build started',
    progress_check: 'Stall check', replanned: 'Replanned', progressed: 'Progressed', doubted: 'Doubted' };
  const actionLabels = { opportunity_propose: 'Propose opportunity', opportunity: 'Join opportunity', project_propose: 'Propose project',
    project_join: 'Join project', project_contribute: 'Invest in project', organization_found: 'Found organization',
    organization_join: 'Join organization', information_share: 'Share information', information_accept: 'Accept information',
    goal_review: 'Goal review', business_market_observe: 'Scan market gaps', business_found: 'Found business',
    business_reopen: 'Reopen business', business_seek_cofounder: 'Seek co-founder', business_skill_practice: 'Practice business skills',
    business_apply: 'Apply for job', business_work: 'Business production', business_invest: 'Invest in business', agreement_propose: 'Propose supply agreement' };
  const reasonLabels = { NONE: 'No blocker', UTILITY_BELOW_THRESHOLD: 'Utility below threshold', FRUITFLY_NOT_SELECTED: 'Fruitfly chose another candidate',
    NO_COMPATIBLE_GOAL: 'No compatible goal', INSUFFICIENT_TRUST: 'Insufficient trust', INSUFFICIENT_SHARED_WORK: 'Not enough shared work',
    NO_PARTNER: 'No suitable partner', NO_INFORMATION_ASYMMETRY: 'No information gap', NO_SCARCITY: 'No real scarcity',
    SCENE_CONGESTION: 'Place congested', GOAL_STAGNANT: 'Goal stalled', GOAL_PROGRESSING: 'Goal still progressing',
    ENERGY_LOW: 'Low energy', FOOD_LOW: 'Low food', CAPACITY: 'At capacity', COOLDOWN: 'Cooling down',
    NO_CAPABILITY: 'Insufficient capability', NO_CAPITAL: 'Insufficient capital', NO_MARKET_KNOWLEDGE: 'Market not yet observed',
    RISK_TOO_HIGH: 'Risk too high', NO_STRATEGIC_SLOT: 'Strategic slots full', OTHER: 'Other blocker',
    NEEDS_HARD_GATE: 'Blocked by hard demand gate', INCOMPATIBLE_GOALS: 'Incompatible goals', DEADLINE_PASSED: 'Project overdue' };
  const emergence = evolution.emergence || {};
  const counts = (emergence.counts || []).map((item) => ({ ...item,
    title: `${systemLabels[item.system] || item.system} · ${stageLabels[item.stage] || item.stage}`
      + `${item.action ? ` · ${actionLabels[item.action] || item.action}` : ''} · ${item.count}` }));
  const latestDecision = (emergence.recent || []).find((item) => item.stage === 'fruitfly_selected');
  if (latestDecision) counts.unshift({ title: `Latest strategic choice · ${latestDecision.action || '—'}`,
    system: latestDecision.system, worldMinutes: latestDecision.worldMinutes });
  renderEvolutionList(emergenceCountsList, counts, 'No strategy cycles in the last 7 world days.', (item) =>
    `${systemLabels[item.system] || item.system}${item.worldMinutes ? ` · world minute ${item.worldMinutes}` : ''}`,
  { emptyMode: 'hidden' });
  const blockers = (emergence.blockedReasons || []).map((item) => ({ ...item,
    title: reasonLabels[item.reasonCode] || item.reasonCode }));
  renderEvolutionList(emergenceBlockersList, blockers, 'No blockers recorded in the last 7 world days.', (item) =>
    `${systemLabels[item.system] || item.system} · ${item.count} times`, { emptyMode: 'hidden' });
}

function renderSummary() {
  if (!latestMapData) return;
  const residents = latestMapData.residents || [];
  const scenes = latestMapData.scenes || [];
  const women = residents.filter((resident) => resident.gender === 'female').length;
  const men = residents.filter((resident) => resident.gender === 'male').length;
  setText(document.querySelector('#map-resident-total'), displayCount(residents.length));
  setText(document.querySelector('#map-scene-total'), displayCount(authoritativePlaceCount(latestMapData)));
  setText(document.querySelector('#map-gender-count'), `${women} / ${men}`);
  const engine = latestMapData.world?.engine;
  if (engine) {
    const hour = String(engine.hour || 0).padStart(2, '0');
    const minute = String(engine.minute || 0).padStart(2, '0');
    setText(document.querySelector('#world-time'), `${hour}:${minute}`);
    setText(document.querySelector('#world-day'), `SIM DAY ${displayCount(engine.day || 1)}`);
    setText(document.querySelector('#world-engine-state'), engine.running ? 'RUNNING' : 'PAUSED');
    document.querySelector('#world-engine-state')?.classList.toggle('is-offline', !engine.running);
  }
}

function renderMapData(data) {
  const selectedResidentChanged = !(data.residents || []).some((resident) => resident.id === selectedAgentId);
  latestMapData = data;
  const residents = data.residents || [];
  if (selectedResidentChanged && !agentPanelDismissed) {
    selectedAgentId = residents[0]?.id || null;
    selectedResidentDetail = null;
    selectedResidentDetailState = UI_SECTION_STATE.LOADING;
  }
  renderSummary();
  renderMap();
  world3d?.update(data, selectedAgentId);
  if (selectedAgentId) renderAgentPanel(residents.find((resident) => resident.id === selectedAgentId), selectedResidentDetail, selectedResidentDetailState);
  renderActivity();
  renderWorldEvolution();
  if (selectedResidentChanged && selectedAgentId) loadResidentDetail(selectedAgentId);
  if (selectedResidentChanged && selectedAgentId) {
    document.dispatchEvent(new CustomEvent('mirrorterra:resident-selected', { detail: { agentId: selectedAgentId } }));
  }
}

document.addEventListener('mirrorterra:select-resident', (event) => {
  if (event.detail?.agentId) selectAgentById(event.detail.agentId);
});

function renderInitialMapError(error) {
  if (latestMapData) return;
  if (mapLocations) {
    mapLocations.replaceChildren();
    const message = document.createElement('p');
    message.className = 'map-loading';
    message.textContent = 'Temporarily unavailable. Retrying automatically.';
    mapLocations.append(message);
  }
  if (activityList) {
    activityList.replaceChildren();
    const message = document.createElement('li');
    message.className = 'activity-empty';
    message.textContent = 'Temporarily unavailable. Retrying automatically.';
    activityList.append(message);
  }
  if (evolutionStats) {
    evolutionStats.replaceChildren();
    const message = document.createElement('p');
    message.className = 'world-evolution-empty';
    message.textContent = 'Temporarily unavailable. Retrying automatically.';
    evolutionStats.append(message);
  }
  for (const container of document.querySelectorAll('.world-evolution ol')) {
    renderEvolutionList(container, [], '', () => '', { error });
  }
  for (const element of [worldEpochSummary, worldV7Summary, worldV6LifecycleObserverStatus, worldArcObserverStatus]) {
    setText(element, 'Temporarily unavailable. Retrying automatically.');
  }
}

const mapSnapshotLoader = createMapSnapshotLoader({ visible: () => document.visibilityState === 'visible' });
let mapRequestInFlight = false;
async function loadMapData() {
  if (mapRequestInFlight) return;
  mapRequestInFlight = true;
  try {
    const result = await mapSnapshotLoader.load();
    if (result.skipped) return;
    if (result.data) renderMapData(result.data);
    const data = result.data || latestMapData;
    mapError.hidden = true;
    mapStatusDot.classList.remove('is-error');
    setText(mapState, 'Live world snapshot');
    setText(mapUpdated, `Updated ${formatTime(data.generatedAt)}`);
  } catch (error) {
    renderInitialMapError(error);
    mapStatusDot.classList.add('is-error');
    setText(mapState, latestMapData ? 'Update failed · showing last snapshot' : 'Map data unavailable');
    setText(mapUpdated, latestMapData ? `Last updated ${formatTime(latestMapData.generatedAt)}` : 'No data yet');
    mapError.hidden = false;
    mapError.textContent = 'Live world data is temporarily unreachable. The page will keep retrying automatically.';
  } finally {
    mapRequestInFlight = false;
  }
}

loadStats();
loadMapData();
window.setInterval(() => {
  if (document.visibilityState === 'visible') {
    loadMapData();
  }
}, MAP_REFRESH_INTERVAL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadMapData(); });
window.setInterval(() => {
  if (document.visibilityState === 'visible' && selectedAgentId) loadResidentDetail(selectedAgentId);
}, 30_000);
window.setInterval(() => { if (document.visibilityState === 'visible') loadStats(); }, 30_000);

const mobileMenuButton = document.querySelector('#mobile-menu-toggle');
const mainNavigation = document.querySelector('#main-navigation');
function closeMobileMenu() {
  mainNavigation?.classList.remove('is-open');
  mobileMenuButton?.setAttribute('aria-expanded', 'false');
}
mobileMenuButton?.addEventListener('click', () => {
  const open = mainNavigation.classList.toggle('is-open');
  mobileMenuButton.setAttribute('aria-expanded', String(open));
});
mainNavigation?.addEventListener('click', (event) => { if (event.target.closest('a')) closeMobileMenu(); });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && mobileMenuButton?.getAttribute('aria-expanded') === 'true') {
    closeMobileMenu(); mobileMenuButton.focus();
  }
});
matchMedia('(max-width:860px)').addEventListener('change', closeMobileMenu);
