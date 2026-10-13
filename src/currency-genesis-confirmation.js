import { createHash } from 'node:crypto';
import { actionIdentifier, requireWorldMember, worldError } from './world-domain.js';
import { agentTokenSpecificationFromIntentRow, classifyCurrencyReviewResult, currencyAuthoringInput,
  currencyReviewErrorOutcome, recordCurrencyReviewOutcome, confirmWorldTokenIssuance } from './world-token-issuance.js';
import { inspectSyncTokenomicsSpecification, SYNC_GENESIS_ISSUER_AGENT_ID,
  TOKENOMICS_MANIFEST_HASH } from './arc/sync-tokenomics.js';

const HASH = /^0x[0-9a-f]{64}$/;
export const GENESIS_CONFIRMATION_MODE = 'confirmation_cognition';
export const GENESIS_CONFIRMATION_OPTIONS = Object.freeze([
  Object.freeze({ id: 'confirm', label: 'Confirm my existing specification',
    description: 'I explicitly accept this exact complete specification as my Genesis design. This records my decision only; it does not sign, deploy or broadcast a blockchain transaction.' }),
  Object.freeze({ id: 'revise', label: 'I want to revise my design',
    description: 'I am not ready to confirm this exact specification because I want to change my design. Record this decision and stop; this session cannot change any field or call authoring.' }),
  Object.freeze({ id: 'defer', label: 'Defer my confirmation',
    description: 'I do not choose to confirm or revise now. Record this decision and stop without changing the specification.' }),
  Object.freeze({ id: 'reject', label: 'Reject this specification',
    description: 'I do not accept this specification. Record this decision and stop. Rejecting this proposal does not cancel the mandatory world currency requirement.' })
]);

export function validateGenesisConfirmationRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['mode','actionId','expectedSpecificationHash','expectedManifestHash'].includes(key))
      || body.mode !== GENESIS_CONFIRMATION_MODE) {
    throw worldError('TOKEN_CONFIRMATION_COGNITION_REQUIRED', 400);
  }
  actionIdentifier(body.actionId);
  if (!HASH.test(body.expectedSpecificationHash || '') || body.expectedManifestHash !== TOKENOMICS_MANIFEST_HASH) {
    throw worldError('TOKEN_CONFIRMATION_BINDING_INVALID', 400);
  }
}

function validateBinding(intent, expectedSpecificationHash, expectedManifestHash) {
  const validation = inspectSyncTokenomicsSpecification(agentTokenSpecificationFromIntentRow(intent));
  if (Number(intent.capability_generation) !== 1 || intent.issuer_agent_id !== SYNC_GENESIS_ISSUER_AGENT_ID
      || intent.issuer_selection_source !== 'creator_genesis_assignment'
      || intent.metadata?.tokenomicsManifestHash !== expectedManifestHash
      || expectedManifestHash !== TOKENOMICS_MANIFEST_HASH
      || validation.specificationHash !== expectedSpecificationHash) {
    throw worldError('TOKEN_CONFIRMATION_SPECIFICATION_CHANGED', 409);
  }
  return validation;
}

export async function loadGenesisConfirmationAgent(client, worldId, agentId) {
  const result = await client.query(`SELECT member.agent_id AS "agentId",agent.name,
      member.energy,member.food,member.social,member.location,state.knowledge,state.risk_tolerance,
      COALESCE(mind.current_goal,state.goal,'balanced') AS "currentGoal",
      COALESCE(profile.primary_goal,'BALANCED_LIFE') AS "primaryGoal",
      COALESCE(mind.traits,'{}'::jsonb) AS traits,
      profile.risk_modifier,profile.curiosity,profile.sociability,profile.discipline,profile.ambition,
      COALESCE((SELECT jsonb_object_agg(skill_name,skill_value) FROM world_agent_skills skill
        WHERE skill.world_id=member.world_id AND skill.agent_id=member.agent_id),'{}'::jsonb) AS skills,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('goalType',goal_type,'description',description,
        'priority',priority,'progress',progress,'status',status,'source',source)
        ORDER BY priority DESC,updated_world_minutes DESC) FROM world_agent_goals goal
        WHERE goal.world_id=member.world_id AND goal.agent_id=member.agent_id AND goal.status='active'),'[]'::jsonb) AS goals,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('memoryType',memory_type,'summary',summary,
        'importance',importance,'worldMinutes',world_minutes,'metadata',metadata)
        ORDER BY world_minutes DESC,id DESC) FROM (SELECT id,memory_type,summary,importance,world_minutes,metadata
        FROM agent_memories memory WHERE memory.world_id=member.world_id AND memory.agent_id=member.agent_id
        ORDER BY world_minutes DESC,id DESC LIMIT 12) recent),'[]'::jsonb) AS "recentMemories"
    FROM world_members member JOIN agents agent ON agent.id=member.agent_id
    JOIN world_agent_states state ON state.world_id=member.world_id AND state.agent_id=member.agent_id
    LEFT JOIN agent_minds mind ON mind.world_id=member.world_id AND mind.agent_id=member.agent_id
    LEFT JOIN world_social_profiles profile ON profile.world_id=member.world_id AND profile.agent_id=member.agent_id
    WHERE member.world_id=$1 AND member.agent_id=$2`, [worldId, agentId]);
  if (result.rowCount !== 1) throw worldError('TOKEN_SELECTED_ISSUER_REQUIRED', 403);
  const row = result.rows[0];
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  return { ...row, riskTolerance: Math.max(0, Math.min(1, finite(row.risk_tolerance) + finite(row.risk_modifier))),
    curiosity: finite(row.curiosity, 0.5), sociability: finite(row.sociability, 0.5),
    discipline: finite(row.discipline, 0.5), ambition: finite(row.ambition, 0.5) };
}

// Invoked inside the existing authenticated API transaction. The row lock binds
// the model's decision to this proposal's exact content; there is no authoring callback.
export async function reviewGenesisExplicitConfirmation(client, { worldId, agentId, intentId, body,
  worldMinute, chooseWithTypeSafe, confirmIssuance = confirmWorldTokenIssuance, onDecision = null }) {
  validateGenesisConfirmationRequest(body);
  await requireWorldMember(client, worldId, agentId);
  const selected = await client.query('SELECT * FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2 FOR UPDATE',
    [worldId, intentId]);
  if (selected.rowCount !== 1) throw worldError('TOKEN_ISSUANCE_INTENT_NOT_FOUND', 404);
  const intent = selected.rows[0];
  if (agentId !== SYNC_GENESIS_ISSUER_AGENT_ID || intent.issuer_agent_id !== agentId) {
    throw worldError('TOKEN_SELECTED_ISSUER_REQUIRED', 403);
  }
  const validation = validateBinding(intent, body.expectedSpecificationHash, body.expectedManifestHash);
  const reviewId = `confirmation-${createHash('sha256').update(`${worldId}:${agentId}:${body.actionId}`).digest('hex').slice(0, 40)}`;
  const prior = await client.query(`SELECT details FROM world_v7_events WHERE world_id=$1
    AND actor_agent_id=$2 AND action_id=$3 AND event_type='currency_genesis.confirmation_review'`,
  [worldId, agentId, reviewId]);
  if (prior.rowCount) {
    if (prior.rows[0].details?.specificationHash !== body.expectedSpecificationHash
        || prior.rows[0].details?.manifestHash !== body.expectedManifestHash
        || prior.rows[0].details?.intentId !== intentId) throw worldError('ACTION_ID_CONFLICT', 409);
    return { ...prior.rows[0].details.result, idempotent: true };
  }
  if (intent.status !== 'proposed') throw worldError('TOKEN_ISSUANCE_NOT_CONFIRMABLE', 409);
  const assignment = await client.query(`SELECT issuer_agent_id,selection_source FROM world_genesis_issuer_assignments
    WHERE world_id=$1 AND capability_generation=1`, [worldId]);
  if (assignment.rowCount !== 1 || assignment.rows[0].issuer_agent_id !== agentId
      || assignment.rows[0].selection_source !== 'creator_genesis_assignment') {
    throw worldError('TOKEN_ISSUER_CREATOR_ASSIGNMENT_REQUIRED', 409);
  }
  const wallet = await client.query(`SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2
    AND chain_id=5042 AND status='active'`, [worldId, agentId]);
  if (wallet.rowCount !== 1 || !/^0x[0-9a-f]{40}$/i.test(wallet.rows[0].address || '')
      || intent.issuer_wallet && intent.issuer_wallet.toLowerCase() !== wallet.rows[0].address.toLowerCase()) {
    throw worldError('TOKEN_ISSUER_WALLET_NOT_READY', 409);
  }
  const requirement = (await client.query('SELECT * FROM arc_currency_genesis_requirements WHERE world_id=$1', [worldId])).rows[0];
  if (!requirement || requirement.status === 'SATISFIED') throw worldError('CURRENCY_GENESIS_REQUIREMENT_NOT_CONFIRMABLE', 409);
  const agent = await loadGenesisConfirmationAgent(client, worldId, agentId);
  const context = await currencyAuthoringInput(client, { worldId, agent, worldMinute, requirement, intent });
  let response;
  try {
    response = typeof chooseWithTypeSafe === 'function' ? await chooseWithTypeSafe({ worldId, agentId, agent,
      worldMinute, choiceType: 'currency_genesis', options: GENESIS_CONFIRMATION_OPTIONS,
      state: { phase: 'explicit_confirmation_only', requirement: 'CURRENCY_GENESIS_REQUIRED',
        requirementStatus: requirement.status, worldFacts: context.worldFacts,
        currentProposal: { id: intentId, status: intent.status, specification: agentTokenSpecificationFromIntentRow(intent),
          specificationHash: validation.specificationHash, tokenomicsManifestHash: body.expectedManifestHash,
          author: agentId, canonicalValidationPassed: true, economicInvariantsPassed: true },
        ownRecentMemories: agent.recentMemories, activeGoals: agent.goals,
        sessionBoundaries: { authoringAllowed: false, specificationChangesAllowed: false,
          priorConfirmationInherited: false, blockchainSigningAllowed: false, broadcastAllowed: false,
          confirmationCreatesTransactionOrOutbox: false } } })
      : { currencyReviewDiagnostic: { outcome: 'provider_unavailable', reasonCode: 'provider_callback_unavailable',
        providerAttempted: false } };
  } catch (error) {
    response = { currencyReviewDiagnostic: { ...currencyReviewErrorOutcome(error), providerAttempted: true } };
  }
  const review = classifyCurrencyReviewResult(response, GENESIS_CONFIRMATION_OPTIONS);
  await recordCurrencyReviewOutcome(client, { worldId, agent, worldMinute, requirement, ...review.diagnostic,
    reviewActionId: `${reviewId}:outcome` });
  const decision = review.selected?.id || null;
  // Retain only public decision diagnostics if a subsequent SQL mutation fails.
  // Authentication credentials, signatures and arbitrary provider text are excluded.
  if (typeof onDecision === 'function') onDecision({ worldId, agentId, intentId, worldMinute, decision,
    specificationHash: validation.specificationHash, manifestHash: body.expectedManifestHash,
    confidence: review.diagnostic.confidence ?? null, providerAttempted: review.diagnostic.providerAttempted === true,
    outcome: review.diagnostic.outcome, actionId: body.actionId });
  let confirmed = false;
  if (decision === 'confirm') {
    const result = await confirmIssuance(client, { worldId, agentId, intentId, decision: 'issue',
      actionId: body.actionId, worldMinute, expectedSpecificationHash: body.expectedSpecificationHash,
      expectedManifestHash: body.expectedManifestHash });
    confirmed = result.confirmed === true;
    if (!confirmed || result.readyForExecution || result.outboxCreated) {
      throw worldError('TOKEN_CONFIRMATION_EXECUTION_BOUNDARY_VIOLATION', 409);
    }
  }
  const result = { intentId, decision, confirmed, proposalStatus: confirmed ? 'issuer_confirmed' : 'proposed',
    specificationHash: validation.specificationHash, manifestHash: body.expectedManifestHash,
    worldMinute, cognition: review.diagnostic, readyForExecution: false, authoringInvoked: false,
    specificationChanged: false, outboxCreated: false, mainnetWriteGate: false };
  await client.query(`INSERT INTO world_v7_events(world_id,actor_agent_id,event_type,entity_type,entity_id,
      world_minute,details,action_id) VALUES($1,$2,'currency_genesis.confirmation_review',
      'agent_token_issuance',$3,$4,$5::jsonb,$6)`,
  [worldId, agentId, intentId, worldMinute, JSON.stringify({ intentId, specificationHash: validation.specificationHash,
    manifestHash: body.expectedManifestHash, authenticatedAgentId: agentId, result }), reviewId]);
  return result;
}
