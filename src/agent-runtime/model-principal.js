// Provider admission is a platform boundary, not a resident-controlled flag.
// Look up every request; never cache an internal classification across joins.
export function modelPrincipalError(code, cause) {
  return Object.assign(new Error(code, cause ? { cause } : undefined), { code, statusCode: 403 });
}

export function isModelPrincipalDenial(error) {
  return String(error?.code || '').startsWith('MODEL_PRINCIPAL_')
    || error?.code === 'EXTERNAL_MODEL_CALL_FORBIDDEN';
}

export async function assertPlatformModelPrincipal(db, { worldId, agentId } = {}) {
  if (!worldId || !agentId) throw modelPrincipalError('MODEL_PRINCIPAL_REQUIRED');
  if (!db || typeof db.query !== 'function') throw modelPrincipalError('MODEL_PRINCIPAL_UNAVAILABLE');
  let result;
  try {
    result = await db.query(`SELECT
        EXISTS(SELECT 1 FROM world_external_residents e WHERE e.agent_id=a.id) AS external,
        EXISTS(SELECT 1 FROM world_members m WHERE m.agent_id=a.id AND m.world_id=$1::uuid) AS member
      FROM agents a WHERE a.id=$2::uuid`, [worldId, agentId]);
  } catch (cause) { throw modelPrincipalError('MODEL_PRINCIPAL_UNAVAILABLE', cause); }
  const principal = result.rows?.[0];
  if (principal?.external === true) throw modelPrincipalError('EXTERNAL_MODEL_CALL_FORBIDDEN');
  if (!principal || principal.member !== true || principal.external !== false) {
    throw modelPrincipalError('MODEL_PRINCIPAL_NOT_INTERNAL');
  }
  return { worldId, agentId };
}

// An institution judge is the only model principal without a resident ID. The
// caller must identify a still-pending research1 judgment in the database;
// prompt text, goal names and an external resident's signature confer no access.
export async function assertResearchInstitutionPrincipal(db, { worldId, agentId, source, trigger, goalId,
  institutionReview } = {}) {
  const { callId, submissionId, judge } = institutionReview || {};
  if (agentId || source !== 'openCognition' || trigger !== 'research'
      || !worldId || !/^[0-9a-f-]{36}$/i.test(String(callId || ''))
      || !/^[1-9][0-9]*$/.test(String(submissionId || ''))
      || !['method', 'value', 'boldness'].includes(judge)
      || goalId !== `research:judge:${judge}:${submissionId}`) {
    throw modelPrincipalError('MODEL_PRINCIPAL_INSTITUTION_INVALID');
  }
  if (!db || typeof db.query !== 'function') throw modelPrincipalError('MODEL_PRINCIPAL_UNAVAILABLE');
  let result;
  try {
    result = await db.query(`SELECT 1 FROM world_research_submissions s
      JOIN world_research_calls c ON c.world_id=s.world_id AND c.id=s.call_id
      WHERE s.world_id=$1::uuid AND s.call_id=$2::uuid AND s.id=$3::bigint
        AND s.kind='proposal' AND c.status='judging'
        AND NOT EXISTS (SELECT 1 FROM world_research_judgments j
          WHERE j.world_id=s.world_id AND j.submission_id=s.id AND j.judge=$4)
      LIMIT 1`, [worldId, callId, submissionId, judge]);
  } catch (cause) { throw modelPrincipalError('MODEL_PRINCIPAL_UNAVAILABLE', cause); }
  if (result.rowCount !== 1) throw modelPrincipalError('MODEL_PRINCIPAL_INSTITUTION_NOT_PENDING');
  return { worldId, institution: 'research_judge', callId, submissionId, judge };
}
