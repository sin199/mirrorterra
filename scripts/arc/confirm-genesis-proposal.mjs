import { readFile } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import pg from 'pg';
import { API_BASE, apiRequest, loadState } from '../../src/agent-runtime/client.js';
import { arcNetworkConfig } from '../../src/arc/config.js';
import { agentTokenSpecificationFromIntentRow } from '../../src/world-token-issuance.js';
import { inspectSyncTokenomicsSpecification, SYNC_GENESIS_ISSUER_AGENT_ID,
  TOKENOMICS_MANIFEST_HASH } from '../../src/arc/sync-tokenomics.js';

const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const INTENT = '56a7cfd7-5ec9-481a-bd6f-f0e4be7c0275';
const SPECIFICATION_HASH = '0x43b090dab99a6bc30c6d2f44aa99cbb4d4831e01077410fac7af125e85751368';
const ACTION_ID = 'sync-confirmation-cognition-729499-v1';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
let client;
try {
  const base = new URL(API_BASE);
  if (arcNetworkConfig().writesEnabled || process.env.MAINNET_WRITE_GATE !== 'false'
      || base.origin !== 'http://127.0.0.1:8788' || base.username || base.password) {
    throw Object.assign(new Error(), { code: 'CONFIRMATION_RUNTIME_GUARD_FAILED' });
  }
  const state = await loadState();
  const resident = state.agents?.find((agent) => agent.agentId === SYNC_GENESIS_ISSUER_AGENT_ID);
  if (state.worldId !== WORLD || !resident?.privateKeyFile) {
    throw Object.assign(new Error(), { code: 'ISSUER_AUTHENTICATION_UNAVAILABLE' });
  }
  const privateKey = createPrivateKey(await readFile(resident.privateKeyFile, 'utf8'));
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64url');
  client = await pool.connect();
  await client.query('BEGIN READ ONLY');
  const agent = await client.query('SELECT public_key FROM agents WHERE id=$1', [resident.agentId]);
  const proposal = await client.query('SELECT * FROM arc_token_issuance_intents WHERE world_id=$1 AND id=$2', [WORLD, INTENT]);
  const validation = proposal.rowCount ? inspectSyncTokenomicsSpecification(agentTokenSpecificationFromIntentRow(proposal.rows[0])) : null;
  if (agent.rows[0]?.public_key !== publicKey || proposal.rows[0]?.metadata?.tokenomicsManifestHash !== TOKENOMICS_MANIFEST_HASH
      || validation?.specificationHash !== SPECIFICATION_HASH
      || !['proposed','issuer_confirmed'].includes(proposal.rows[0]?.status)) {
    throw Object.assign(new Error(), { code: 'CONFIRMATION_BINDING_FAILED' });
  }
  await client.query('ROLLBACK');
  client.release(); client = null;
  const result = await apiRequest({ agentId: resident.agentId, privateKey }, 'POST',
    `/v1/worlds/${WORLD}/token-issuance/intents/${INTENT}/issuer-decision`, {
      mode: 'confirmation_cognition', actionId: ACTION_ID,
      expectedSpecificationHash: SPECIFICATION_HASH, expectedManifestHash: TOKENOMICS_MANIFEST_HASH
    });
  console.log(JSON.stringify({ stage: 'agent_signed_confirmation_cognition', worldId: WORLD,
    authenticatedAgentId: resident.agentId, ...result }));
} catch (error) {
  // Never log a DSN, key, request signature, or an arbitrary provider/server error body.
  const apiFailure = String(error?.message || '').match(/failed \((\d{3})\): ([A-Z][A-Z0-9_]{1,99})(?:$|\s)/);
  console.log(JSON.stringify({ stage: 'confirmation_failed', code:
    /^[A-Z0-9_]{1,100}$/.test(String(error?.code || '')) ? error.code : apiFailure?.[2] || 'CONFIRMATION_REQUEST_FAILED',
    httpStatus: apiFailure ? Number(apiFailure[1]) : null,
    retryAttempted: false }));
  process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
}
