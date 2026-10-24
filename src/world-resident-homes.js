// Residents build their own homes, a few work sessions at a time, then sleep in them.
// World-internal only: no money, ledger, wallet or chain logic.
import { writeWorldHistory } from './world-domain.js';

export const HOME_BUILD_STEP = 25;
export const HOME_BUILD_SKILL_GROUP = 'onet:gwa:4.A.3.a.2';

function stableUnit(text) {
  let hash = 2166136261;
  for (const char of String(text)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 4294967295;
}

export function homeBuildGain(agentId, sessions) {
  return HOME_BUILD_STEP + Math.floor(stableUnit(`${agentId}:home:${sessions}`) * 8);
}

export async function loadResidentHomes(client, worldId) {
  const result = await client.query(`SELECT agent_id AS "agentId",status,progress FROM world_resident_homes WHERE world_id=$1`, [worldId]);
  return new Map(result.rows.map((row) => [row.agentId, row]));
}

// One building session at the resident's own home plot. Returns the new state.
export async function advanceHomeBuild(client, { worldId, agentId, agentName = null, worldMinutes = 0 }) {
  const style = Math.floor(stableUnit(`style:${agentId}`) * 64);
  await client.query(`INSERT INTO world_resident_homes(world_id,agent_id,style,started_world_minutes)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [worldId, agentId, style, worldMinutes]);
  const current = await client.query(`SELECT status,progress,sessions FROM world_resident_homes
    WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, agentId]);
  const row = current.rows[0];
  if (!row || row.status === 'built') return { status: 'built', progress: 100, justBuilt: false };
  const progress = Math.min(100, Number(row.progress) + homeBuildGain(agentId, Number(row.sessions)));
  const built = progress >= 100;
  await client.query(`UPDATE world_resident_homes SET progress=$3,sessions=sessions+1,status=$4,
      built_at=CASE WHEN $4='built' THEN now() ELSE built_at END,
      built_world_minutes=CASE WHEN $4='built' THEN $5::bigint ELSE built_world_minutes END
    WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId, progress, built ? 'built' : 'building', worldMinutes]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, agentId, built ? 'world.home_built' : 'world.home_progress',
    { place: `home:${agentId}`, progress, sessions: Number(row.sessions) + 1 },
    built ? `${agentId}:home:built` : `${agentId}:home:${Number(row.sessions) + 1}`]);
  if (built) {
    await writeWorldHistory(client, { worldId, eventKey: `home:${agentId}:built`, eventType: 'place_created',
      actorAgentId: agentId, entityType: 'place', entityId: null, worldTime: worldMinutes,
      title: `${agentName || 'A resident'} built a home`, detail: 'Finished building a house with their own hands and can now sleep at home.',
      metadata: { home: true, sessions: Number(row.sessions) + 1 } });
  }
  return { status: built ? 'built' : 'building', progress, justBuilt: built };
}
