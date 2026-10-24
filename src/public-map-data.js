import { worldClock } from './world-engine.js';
import { enrichMapEnvironment } from './world-environment.js';
import { readEmergenceReport } from './world-emergence.js';
import { listWorldProjects } from './world-projects.js';
import { listWorldOrganizations } from './world-organizations.js';
import { readWorldCapabilitySummary } from './world-capabilities.js';
import { readPublicWorldV6Lifecycle } from './public-world-evolution.js';
import { listWorldInstitutionSummary } from './world-institutions.js';
import { economicDashboardSql, readEconomicRecoveryMetrics } from './world-businesses.js';
import { formatGenesisTokenRaw, readGenesisCurrencyActivation,
  readGenesisTokenWalletSnapshots } from './genesis-economy.js';
import { readWorldV7Summary } from './world-v7.js';
import { listWorldTokenIssuance, readWorldAgentTokenSummary } from './world-token-issuance.js';
import { AGENT_TOKEN_HUMAN_SUPPLY, AGENT_TOKEN_PILOT_GENERATION,
  AGENT_TOKEN_PILOT_MAX_CREATIONS } from './arc/token-issuance.js';
import { presentPublicMapData } from './public-display.js';
import { ferryIslandEnabled } from './ferry-island-flags.js';
import { readFerryMapBlock } from './ferry-island-store.js';
import { centralBankUnavailable, presentCentralBankScene, readCentralBankSummary } from './central-bank.js';

function workerStatus(worker, fallback) {
  return worker?.getStatus?.() || fallback;
}

async function listPublicWorldBusinesses(client, { worldId, limit, genesisCurrency }) {
  const result = await client.query(`WITH page AS (
      SELECT business.id,business.name,business.founder_agent_id AS "founderAgentId",founder.name AS "founderName",
        business.business_type AS "businessType",business.purpose,business.status,
        business.reputation::text AS reputation,business.founded_world_time AS "createdWorldTime",
        business.place_id AS "placeId",place.name AS "placeName"
      FROM world_businesses business JOIN agents founder ON founder.id=business.founder_agent_id
      LEFT JOIN world_scenes place ON place.world_id=business.world_id AND place.id=business.place_id
      WHERE business.world_id=$1 ORDER BY business.founded_world_time DESC,business.id LIMIT $2
    ), service_items AS (
      SELECT service.business_id,jsonb_agg(jsonb_build_object('id',service.id,'type',service.service_type,
        'name',service.name,'description',service.description,'basePriceUsdc',service.base_price_usdc::text,
        'stockUnits',service.stock_units,'active',service.active,'tokenId',terms.token_id,
        'tokenPriceRaw',terms.price_raw::text,'tokenPriceEffectiveWorldMinute',terms.effective_world_minute)
        ORDER BY service.created_world_time,service.id) AS items
      FROM page JOIN world_business_services service ON service.world_id=$1 AND service.business_id=page.id
      LEFT JOIN world_business_service_token_terms terms ON terms.world_id=service.world_id
        AND terms.service_id=service.id AND ($3::uuid IS NULL OR terms.token_id=$3::uuid)
      GROUP BY service.business_id
    ), job_items AS (
      SELECT job.business_id,jsonb_agg(jsonb_build_object('id',job.id,'role',job.role,
        'requiredSkill',job.required_skill,'wageUsdc',job.wage_usdc::text,'status',job.status,
        'employeeId',employment.agent_id,'employeeName',employee.name,'tokenId',terms.token_id,
        'wageRaw',terms.wage_raw::text,'wageEffectiveWorldMinute',terms.effective_world_minute)
        ORDER BY job.created_world_time,job.id) AS items
      FROM page JOIN world_business_jobs job ON job.world_id=$1 AND job.business_id=page.id
      LEFT JOIN world_business_employment employment ON employment.world_id=job.world_id
        AND employment.job_id=job.id AND employment.status='active'
      LEFT JOIN agents employee ON employee.id=employment.agent_id
      LEFT JOIN world_business_job_token_terms terms ON terms.world_id=job.world_id
        AND terms.job_id=job.id AND ($3::uuid IS NULL OR terms.token_id=$3::uuid)
      GROUP BY job.business_id
    ), worker_items AS (
      SELECT employment.business_id,jsonb_agg(jsonb_build_object('employmentId',employment.id,'jobId',job.id,
        'agentId',employment.agent_id,'name',employee.name,'role',job.role,'wageUsdc',employment.wage_usdc::text,
        'wageTokenId',employment.wage_token_id,'wageRaw',employment.wage_raw::text,
        'startedWorldTime',employment.started_world_time) ORDER BY employment.started_world_time,employment.agent_id) AS items
      FROM page JOIN world_business_employment employment ON employment.world_id=$1
        AND employment.business_id=page.id AND employment.status='active'
      JOIN agents employee ON employee.id=employment.agent_id
      JOIN world_business_jobs job ON job.world_id=employment.world_id AND job.id=employment.job_id
      GROUP BY employment.business_id
    ), agreement_items AS (
      SELECT page.id AS business_id,jsonb_agg(jsonb_build_object('id',agreement.id,'type',agreement.agreement_type,
        'status',agreement.status,'terms',agreement.terms,'updatedWorldTime',agreement.updated_world_time)
        ORDER BY agreement.updated_world_time DESC,agreement.created_at DESC) AS items
      FROM page JOIN world_agreements agreement ON agreement.world_id=$1
        AND agreement.terms->>'businessId'=page.id::text
      GROUP BY page.id
    )
    SELECT page.*,COALESCE(service_items.items,'[]'::jsonb) AS services,
      COALESCE(job_items.items,'[]'::jsonb) AS jobs,COALESCE(worker_items.items,'[]'::jsonb) AS workers,
      COALESCE(agreement_items.items,'[]'::jsonb) AS agreements
    FROM page LEFT JOIN service_items ON service_items.business_id=page.id
    LEFT JOIN job_items ON job_items.business_id=page.id
    LEFT JOIN worker_items ON worker_items.business_id=page.id
    LEFT JOIN agreement_items ON agreement_items.business_id=page.id
    ORDER BY page."createdWorldTime" DESC,page.id`,
  [worldId, Math.max(1, Math.min(50, Number(limit) || 12)), genesisCurrency?.tokenId || null]);
  if (!genesisCurrency) return result.rows;
  return result.rows.map((business) => {
    const workers = (business.workers || []).map((worker) => {
      const current = worker.wageTokenId === genesisCurrency.tokenId && worker.wageRaw !== null
        && worker.wageRaw !== undefined && BigInt(worker.wageRaw) > 0n;
      return { ...worker, wageUsdc: null, wageTokenId: current ? worker.wageTokenId : null,
        wageRaw: current ? worker.wageRaw : null,
        wageHuman: current ? formatGenesisTokenRaw(worker.wageRaw, genesisCurrency.decimals) : null,
        wageSymbol: current ? genesisCurrency.symbol : null,
        economicStatus: current ? 'active_token_wage' : 'historical_only' };
    });
    return { ...business, cashBalance: null, revenue: null, expenses: null, profitLoss: null,
      legacySimulatedEconomy: 'historical_only',
      services: (business.services || []).map((service) => ({ ...service, basePriceUsdc: null,
        tokenPriceHuman: service.tokenPriceRaw
          ? formatGenesisTokenRaw(service.tokenPriceRaw, genesisCurrency.decimals) : null,
        tokenPriceSymbol: service.tokenId ? genesisCurrency.symbol : null })),
      jobs: (business.jobs || []).map((job) => ({ ...job, wageUsdc: null,
        wageHuman: job.wageRaw ? formatGenesisTokenRaw(job.wageRaw, genesisCurrency.decimals) : null,
        wageSymbol: job.tokenId ? genesisCurrency.symbol : null })),
      workers: workers.filter((worker) => worker.economicStatus === 'active_token_wage'),
      historicalEmployment: workers.filter((worker) => worker.economicStatus === 'historical_only'),
      agreements: (business.agreements || []).map((agreement) => {
        const terms = agreement.terms || {};
        const legacy = Object.keys(terms).some((key) =>
          /^(?:wageusdc|priceusdc|amountusdc|capitalusdc|basepriceusdc)$/i.test(key))
          || terms.resourceKey === 'simulated_usdc';
        return { ...agreement, ...(legacy ? { legacySimulatedEconomy: 'historical_only' } : {}) };
      }) };
  });
}

async function buildOtherWorldEvolution({ pool, worldId, worldMinutes, genesisCurrency, runtime,
  readObserverStatus, timing }) {
  const [emergence, recoveryMetrics, economyParts, overviewParts, institutions, capabilities, v7,
    agentTokenIssuance, tokenWalletSnapshot, v6LifecycleObserverStatus] = await Promise.all([
    timing.measure('emergence_ms', () => readEmergenceReport(pool, { worldId, worldMinutes })),
    timing.measure('recovery_ms', () => genesisCurrency
      ? Promise.resolve(null) : readEconomicRecoveryMetrics(pool, { worldId, worldMinutes })),
    timing.measure('economy_ms', () => Promise.all([
      timing.measure('economy_dashboard_ms', () => genesisCurrency
        ? Promise.resolve({ rows: [{}] }) : pool.query(economicDashboardSql(), [worldId])),
      timing.measure('businesses_ms', () => listPublicWorldBusinesses(pool,
        { worldId, limit: 12, genesisCurrency })),
      timing.measure('economic_demand_ms', () => pool.query(`SELECT service_type AS "serviceType",demand_count AS "demandCount",
          supply_count AS "supplyCount",unmet_count AS "unmetCount"
        FROM world_economic_demand WHERE world_id=$1 AND world_day=$2
        ORDER BY unmet_count DESC,demand_count DESC,service_type LIMIT 8`,
      [worldId, Math.floor(worldMinutes / 1_440)])),
      timing.measure('economy_history_ms', () => pool.query(`SELECT event_type AS "eventType",world_time AS "worldTime",title,detail,metadata
        FROM world_history WHERE world_id=$1 AND (event_type LIKE 'business_%'
          OR event_type IN ('project_invested','project_revenue','place_maintenance'))
        ORDER BY world_time DESC,id DESC LIMIT 8`, [worldId]))
    ])),
    timing.measure('overview_ms', () => Promise.all([
      timing.measure('dashboard_counts_ms', () => pool.query(`SELECT
          (SELECT count(*)::int FROM world_members WHERE world_id=$1) AS residents,
          (SELECT count(*)::int FROM world_scenes WHERE world_id=$1 AND status='active') AS places,
          (SELECT count(*)::int FROM world_organizations WHERE world_id=$1 AND status IN ('forming','active')) AS organizations,
          (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status IN ('idea','proposed','recruiting','active')) AS "activeProjects",
          (SELECT count(*)::int FROM world_projects WHERE world_id=$1 AND status='completed') AS "completedProjects",
          (SELECT count(*)::int FROM world_opportunities WHERE world_id=$1 AND status IN ('open','active')
            AND (expires_world_time IS NULL OR expires_world_time>$2)) AS "activeOpportunities"`, [worldId, worldMinutes])),
      timing.measure('opportunities_ms', () => pool.query(`SELECT opportunity.id,opportunity.opportunity_type AS type,opportunity.title,opportunity.description,
          opportunity.status,opportunity.created_world_time AS "createdWorldTime",opportunity.expires_world_time AS "expiresWorldTime",
          opportunity.capacity,count(participant.agent_id) FILTER (WHERE participant.status='accepted')::int AS "acceptedCount",
          scene.name AS "sceneName"
        FROM world_opportunities opportunity LEFT JOIN world_scenes scene
          ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
        LEFT JOIN world_opportunity_participants participant ON participant.world_id=opportunity.world_id
          AND participant.opportunity_id=opportunity.id
        WHERE opportunity.world_id=$1 AND opportunity.status IN ('open','active')
          AND (opportunity.expires_world_time IS NULL OR opportunity.expires_world_time>$2)
        GROUP BY opportunity.id,scene.name ORDER BY opportunity.created_world_time DESC,opportunity.id LIMIT 8`,
      [worldId, worldMinutes])),
      timing.measure('projects_ms', () => listWorldProjects(pool,
        { worldId, statuses: ['idea','proposed','recruiting','active','completed','failed'], limit: 8 })),
      timing.measure('organizations_ms', () => listWorldOrganizations(pool,
        { worldId, statuses: ['forming','active','dormant'], limit: 6 })),
      timing.measure('world_history_ms', () => pool.query(`SELECT id,event_type AS "eventType",entity_type AS "entityType",entity_id AS "entityId",
          world_time AS "worldTime",title,detail,metadata
        FROM world_history WHERE world_id=$1 ORDER BY world_time DESC,id DESC LIMIT 8`, [worldId])),
      timing.measure('internal_units_ms', () => genesisCurrency ? Promise.resolve({ rows: [{ units: null }] })
        : pool.query('SELECT COALESCE(sum(amount),0)::text AS units FROM token_ledger WHERE world_id=$1', [worldId]))
    ])),
    timing.measure('institutions_ms', () => listWorldInstitutionSummary(pool, { worldId, limit: 10 })),
    timing.measure('capabilities_ms', () => readWorldCapabilitySummary(pool, { worldId, limit: 30 })),
    timing.measure('v7_ms', () => readWorldV7Summary(pool, { worldId, limit: 12 })),
    timing.measure('agent_token_ms', () => runtime.arcTokenSchemaReady
      ? Promise.all([readWorldAgentTokenSummary(pool, { worldId }),
        listWorldTokenIssuance(pool, { worldId, limit: 12 })]).then(([summary, intents]) =>
        ({ available: true, ...summary, intents }))
      : Promise.resolve({ available: false, reason: 'arc_token_issuance_migration_required', counts: null,
        tokens: [], intents: [], createdTokenCount: 0 })),
    timing.measure('token_wallet_ms', () => genesisCurrency
      ? readGenesisTokenWalletSnapshots(pool, { worldId }) : Promise.resolve(null)),
    timing.measure('observer_status_ms', () => readObserverStatus(worldId))
  ]);

  const [economyDashboard, businesses, economicDemand, economyHistory] = economyParts;
  const [counts, opportunities, projects, organizations, history, internalUnits] = overviewParts;
  agentTokenIssuance.mode = 'agent_decided';
  agentTokenIssuance.writesEnabled = runtime.arcWritesEnabled;
  agentTokenIssuance.fixedHumanSupply = AGENT_TOKEN_HUMAN_SUPPLY;
  agentTokenIssuance.currentPilotLimit = AGENT_TOKEN_PILOT_MAX_CREATIONS;
  agentTokenIssuance.pilotGeneration = AGENT_TOKEN_PILOT_GENERATION;

  const dashboard = genesisCurrency
    ? { ...counts.rows[0], worldMinutes, worldAgeHours: Math.round(worldMinutes / 60),
      worldAgeDays: Math.floor(worldMinutes / 1_440) + 1,
      currencyEra: 'genesis_token', legacySimulatedEconomy: 'historical_only' }
    : { ...counts.rows[0], worldMinutes, worldAgeHours: Math.round(worldMinutes / 60),
      worldAgeDays: Math.floor(worldMinutes / 1_440) + 1,
      totalSimulatedWealthUsd: Number(economyDashboard.rows[0]?.total_resident_net_worth_usd || 0).toFixed(2),
      totalInternalUnits: internalUnits.rows[0].units };
  const publicArcObserverStatus = runtime.arcPublicStatus();
  const tokenWorkerFallback = { available: runtime.arcTokenSchemaReady, running: false,
    mode: 'read_only_reconciliation', writesEnabled: false,
    reason: runtime.arcTokenSchemaReady ? 'worker_not_registered' : 'arc_token_issuance_migration_required' };
  const tokenWorker = workerStatus(runtime.arcAgentTokenIssuanceWorker, tokenWorkerFallback);
  const worldEvolution = { dashboard, opportunities: opportunities.rows, projects,
    organizations, institutions, capabilities, v6Lifecycle: null, v6LifecycleObserver: v6LifecycleObserverStatus,
    arcMainnet: publicArcObserverStatus.arcMainnet,
    arcObserver: publicArcObserverStatus,
    arcSettlementWorker: workerStatus(runtime.arcSettlementWorker, { available: true, running: false,
      mode: 'mainnet_write_gated', providerName: runtime.arcSignerProviderName || null,
      reason: runtime.arcSignerSetupError || 'mainnet_write_gate_closed' }),
    arcAgentTokenIssuanceWorker: tokenWorker,
    arcSyncOperatingPoolPayoutWorker: workerStatus(runtime.arcSyncOperatingPoolPayoutWorker, {
      available: runtime.arcTokenSchemaReady, running: false, mode: 'disabled', writesEnabled: false,
      reason: runtime.arcTokenSchemaReady ? 'mainnet_write_gate_closed' : 'sync_tokenomics_migration_required' }),
    agentTokenIssuance: { ...agentTokenIssuance, worker: tokenWorker },
    v7, history: history.rows };
  worldEvolution.economy = genesisCurrency
    ? { era: 'genesis_token', currency: { tokenId: genesisCurrency.tokenId,
      tokenAddress: genesisCurrency.tokenAddress, name: genesisCurrency.name,
      symbol: genesisCurrency.symbol, decimals: Number(genesisCurrency.decimals),
      chainId: Number(genesisCurrency.chainId), ownershipAuthority: 'arc_chain' },
      wallets: tokenWalletSnapshot?.wallets || [], businesses, demand: economicDemand.rows,
      historicalEconomy: 'preserved_read_only', settlement: 'agent_wallet_authorized_arc_outbox',
      mainnetWriteGate: runtime.arcWritesEnabled }
    : { dashboard: economyDashboard.rows[0] || {}, businesses,
      demand: economicDemand.rows, history: economyHistory.rows, recovery: recoveryMetrics,
      settlement: 'simulated_internal_ledger', chainSettlementEnabled: false };
  worldEvolution.emergence = emergence;
  return worldEvolution;
}

export async function buildPublicMapData({ pool, engineRunning, runtime, readObserverStatus, timing }) {
  const totalStarted = timing.now();
  const world = await timing.measure('world_state_ms', () => pool.query(`SELECT id,name,created_at AS "createdAt"
    FROM worlds WHERE open=true ORDER BY created_at DESC LIMIT 1`));
  if (!world.rowCount) {
    timing.set('total_ms', timing.now() - totalStarted);
    return { payload: { world: null, scenes: [], residents: [], events: [], dataCenterLogs: [],
      generatedAt: new Date().toISOString() }, timing: timing.snapshot() };
  }
  const worldId = world.rows[0].id;
  const [state, scenes, residents, eventRows] = await Promise.all([
    timing.measure('world_state_ms', () => Promise.all([
      readGenesisCurrencyActivation(pool, worldId), worldClock(pool, worldId, engineRunning)
    ])),
    timing.measure('scenes_ms', () => pool.query(`SELECT s.id,s.name,s.scene_type AS "sceneType",s.status,s.description,s.purpose,s.capacity,s.features,s.position,
      s.created_world_minutes AS "createdWorldTime",s.created_by_project_id AS "createdByProjectId",
      s.created_by_organization_id AS "createdByOrganizationId",s.created_at AS "createdAt",
      (SELECT count(*)::int FROM world_members m WHERE m.world_id=s.world_id AND m.location=s.name) AS "residentCount",
      (SELECT a.name FROM agents a WHERE a.id=s.created_by) AS "founderName"
      FROM world_scenes s WHERE s.world_id=$1 ORDER BY s.created_at,s.id`, [worldId])),
    timing.measure('residents_ms', () => pool.query(`SELECT a.id,a.name,a.gender,m.energy,m.food,m.social,m.location,EXISTS (SELECT 1 FROM world_external_residents xr WHERE xr.world_id=m.world_id AND xr.agent_id=m.agent_id) AS external,
        coalesce(ws.happiness,60) AS happiness,coalesce(ws.knowledge,20) AS knowledge,
        coalesce(ws.goal,'balanced') AS goal,ws.risk_tolerance::text AS "riskTolerance",
        coalesce(ws.status,'idle') AS "currentStatus",
        CASE WHEN ws.planned_action IN ('trade','trade_crypto','trade_meme','trade_hold') THEN NULL
          ELSE ws.planned_action END AS "currentAction",
        coalesce(ws.hygiene,80) AS hygiene,coalesce(ws.fun,70) AS fun,ws.activity_variant AS "activityVariant",
        (SELECT h.status FROM world_resident_homes h WHERE h.world_id=m.world_id AND h.agent_id=m.agent_id) AS "homeStatus",
        (SELECT h.progress FROM world_resident_homes h WHERE h.world_id=m.world_id AND h.agent_id=m.agent_id) AS "homeProgress",
        (SELECT h.built_at FROM world_resident_homes h WHERE h.world_id=m.world_id AND h.agent_id=m.agent_id) AS "homeBuiltAt",
        ws.target_location AS "targetLocation",ws.movement_started_at AS "movementStartedAt",
        ws.movement_ends_at AS "movementEndsAt",ws.action_started_at AS "actionStartedAt",ws.action_ends_at AS "actionEndsAt",
        am.archetype,am.current_goal AS "currentGoal",am.actions_taken AS "actionsTaken",am.updated_at AS "mindUpdatedAt",
        COALESCE((SELECT g.category FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
          AND g.goal_type='primary' AND g.status='active' ORDER BY g.priority DESC,g.id LIMIT 1),sp.primary_goal) AS "primaryGoal",
        COALESCE((SELECT g.progress::text FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
          AND g.goal_type='primary' AND g.status='active' ORDER BY g.priority DESC,g.id LIMIT 1),sp.goal_progress::text) AS "goalProgress",
        sp.dominant_role AS "dominantRole",sp.personality_modifiers AS "personalityModifiers",
        sp.risk_modifier::text AS "riskModifier",sp.price_sensitivity::text AS "priceSensitivity",
        (SELECT g.description FROM world_agent_goals g WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id
          AND g.goal_type='short' AND g.status='active' ORDER BY g.priority DESC,g.updated_world_minutes DESC LIMIT 1) AS "shortGoal",
        sp.sociability::text AS sociability,sp.curiosity::text AS curiosity,sp.discipline::text AS discipline,sp.ambition::text AS ambition,
        COALESCE((SELECT jsonb_object_agg(skill_name,skill_value) FROM world_agent_skills sk
          WHERE sk.world_id=m.world_id AND sk.agent_id=m.agent_id),'{}'::jsonb) AS skills,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('otherAgentId',recent.other_id,'name',recent.other_name,
            'familiarity',recent.familiarity,'trust',recent.trust,'affinity',recent.affinity,
            'interactionCount',recent.interaction_count) ORDER BY recent.familiarity DESC,recent.interaction_count DESC)
          FROM (SELECT CASE WHEN rel.agent_a_id=m.agent_id THEN rel.agent_b_id ELSE rel.agent_a_id END AS other_id,
              other.name AS other_name,rel.familiarity,rel.trust,rel.affinity,rel.interaction_count
            FROM world_relationships rel JOIN agents other ON other.id=CASE WHEN rel.agent_a_id=m.agent_id THEN rel.agent_b_id ELSE rel.agent_a_id END
            WHERE rel.world_id=m.world_id AND (rel.agent_a_id=m.agent_id OR rel.agent_b_id=m.agent_id)
            ORDER BY rel.familiarity DESC,rel.interaction_count DESC LIMIT 10) recent),'[]'::jsonb) AS "relationshipSummary",
        recent.event_type AS "lastEventType",recent.action AS "lastEventAction",recent.created_at AS "lastEventAt",recent.place AS "lastEventPlace"
      FROM world_members m JOIN agents a ON a.id=m.agent_id
      LEFT JOIN world_agent_states ws ON ws.world_id=m.world_id AND ws.agent_id=m.agent_id
      LEFT JOIN agent_minds am ON am.world_id=m.world_id AND am.agent_id=m.agent_id
      LEFT JOIN world_social_profiles sp ON sp.world_id=m.world_id AND sp.agent_id=m.agent_id
      LEFT JOIN LATERAL (
        SELECT e.event_type,e.created_at,coalesce(e.data->>'place',e.data->>'to') AS place,e.data->>'action' AS action
        FROM world_events e WHERE e.world_id=m.world_id AND e.actor_id=m.agent_id
          AND (e.event_type LIKE 'action.%' OR e.event_type LIKE 'world.%')
          AND COALESCE(e.data->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
        ORDER BY e.id DESC LIMIT 1
      ) recent ON true
      WHERE m.world_id=$1 ORDER BY m.joined_at,a.name`, [worldId])),
    timing.measure('events_ms', () => Promise.all([24, 100].map((limit) => pool.query(`SELECT a.name AS "agentName",e.event_type AS "eventType",coalesce(e.data->>'place',e.data->>'to') AS place,
        e.data->>'action' AS action,e.created_at AS "createdAt",e.data->>'variant' AS variant,e.data->>'weather' AS weather
      FROM world_events e JOIN agents a ON a.id=e.actor_id
      WHERE e.world_id=$1 AND (e.event_type LIKE 'action.%' OR e.event_type='scene.created' OR e.event_type LIKE 'world.%')
        AND e.event_type NOT LIKE 'crypto.%'
        AND COALESCE(e.data->>'action','') NOT IN ('trade','trade_crypto','trade_meme','trade_hold')
      ORDER BY e.id DESC LIMIT ${limit}`, [worldId]))))
  ]);
  const [genesisCurrency, clock] = state;
  const [events, dataCenterLogs] = eventRows;
  const worldMinutes = Number(clock?.worldMinutes) || 0;
  const environment = enrichMapEnvironment({ worldSeed: worldId, worldMinutes, scenes: scenes.rows,
    residents: residents.rows, events: [...events.rows, ...dataCenterLogs.rows] });
  // MirrorTerra Central Bank vault (read-only display of the SYNC operating pool), read alongside.
  const centralBankRead = timing.measure('central_bank_ms', () => readCentralBankSummary(pool, { worldId })
    .catch(() => centralBankUnavailable('read_failed')));
  const worldEvolution = await timing.measure('world_evolution_ms', async () => {
    const [v6Lifecycle, other] = await Promise.all([
      readPublicWorldV6Lifecycle(pool, { worldId, worldMinute: worldMinutes, timing }),
      timing.measure('other_world_evolution_ms', () => buildOtherWorldEvolution({ pool, worldId, worldMinutes,
        genesisCurrency, runtime, readObserverStatus, timing }))
    ]);
    other.v6Lifecycle = v6Lifecycle;
    return other;
  });
  const centralBank = await centralBankRead;
  // island1: the ferry / Lantern Isle block (pier, ferry, island buildings, live sailing, passengers). Only with
  // MIRRORTERRA_FERRY_ISLAND on and migration 0036 applied; otherwise the payload is exactly as before.
  const ferryIsland = ferryIslandEnabled() ? await timing.measure('ferry_island_ms', () => readFerryMapBlock(pool, { worldId, worldMinutes })
    .catch(() => null)) : null;
  const payload = { world: { ...world.rows[0], engine: clock || { running: false }, environment },
    scenes: scenes.rows.map(presentCentralBankScene), residents: residents.rows, events: events.rows,
    dataCenterLogs: dataCenterLogs.rows, worldEvolution, centralBank, ...(ferryIsland ? { ferryIsland } : {}),
    generatedAt: new Date().toISOString() };
  timing.set('total_ms', timing.now() - totalStarted);
  return { payload: presentPublicMapData(payload), timing: timing.snapshot() };
}
