import { randomUUID } from 'node:crypto';
import { baiAdmissionEstimate, baiPricedNanoUsd, MODEL_DAILY_BUDGET_NANO_USD }
  from './bai-pricing.js';

const SOURCES = new Set(['openCognition','memorySelection','modelAnalysis','currencyGenesisAuthoring']);

function budgetError(code) {
  return Object.assign(new Error(code), { code });
}

function nonnegativeToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function reportedNanoUsd(value) {
  if (value === null || value === undefined || value === '') return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? BigInt(Math.ceil(cost * 1_000_000_000)) : null;
}

async function transaction(pool, task) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await task(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function createBaiBudgetGateway(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('BAI_BUDGET_POOL_REQUIRED');
  let queue = Promise.resolve();
  let unsafe = false;

  async function admit({ callId, worldId, agentId, source, tier, model, body, maxTokens, timeoutMs }) {
    const estimate = baiAdmissionEstimate({ model, serializedBody: body, maxTokens });
    if (!SOURCES.has(source)) throw new TypeError('BAI_BUDGET_SOURCE_INVALID');
    return transaction(pool, async (client) => {
      const guard = await client.query(`SELECT active_call_id,active_until
        FROM bai_model_budget_guard WHERE id=1 FOR UPDATE`);
      if (!guard.rowCount) throw budgetError('BAI_BUDGET_GUARD_MISSING');
      if (guard.rows[0].active_call_id && new Date(guard.rows[0].active_until).getTime() > Date.now()) {
        throw budgetError('BAI_MODEL_CALL_BUSY');
      }
      const total = await client.query(`SELECT COALESCE(sum(effective_cost_nano_usd),0)::text AS amount
        FROM bai_model_budget_calls WHERE created_at > now()-interval '24 hours' AND status<>'blocked'`);
      const spent = BigInt(total.rows[0].amount);
      const blocked = spent + estimate.reservedNanoUsd > MODEL_DAILY_BUDGET_NANO_USD;
      await client.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
          request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
          effective_cost_nano_usd,cost_source,rolling24h_cost_nano_usd)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [callId, worldId || null, agentId || null, source, tier, model,
        blocked ? 'blocked' : 'reserved', estimate.requestBytes, estimate.estimatedInputTokens,
        maxTokens, String(blocked ? 0n : estimate.reservedNanoUsd),
        String(blocked ? 0n : estimate.reservedNanoUsd), blocked ? 'blocked' : 'reservation',
        String(spent + (blocked ? 0n : estimate.reservedNanoUsd))]);
      if (blocked) return { admitted: false, estimate };
      await client.query(`UPDATE bai_model_budget_guard
        SET active_call_id=$1,active_until=now()+($2::int * interval '1 millisecond'),updated_at=now()
        WHERE id=1`, [callId, Math.max(1_000, timeoutMs) + 30_000]);
      return { admitted: true, estimate };
    });
  }

  async function settle({ callId, model, usage, failed, failureCode }) {
    const inputTokens = nonnegativeToken(usage?.inputTokens ?? usage?.prompt_tokens);
    const outputTokens = nonnegativeToken(usage?.outputTokens ?? usage?.completion_tokens);
    const providerCost = reportedNanoUsd(usage?.providerReportedCostUsd ?? usage?.cost_usd);
    const usageCost = inputTokens !== null && outputTokens !== null
      ? baiPricedNanoUsd(model, inputTokens, outputTokens) : null;
    await transaction(pool, async (client) => {
      const guard = await client.query('SELECT active_call_id FROM bai_model_budget_guard WHERE id=1 FOR UPDATE');
      if (guard.rows[0]?.active_call_id !== callId) throw budgetError('BAI_BUDGET_LEASE_LOST');
      const current = await client.query(`SELECT reserved_cost_nano_usd FROM bai_model_budget_calls
        WHERE id=$1 FOR UPDATE`, [callId]);
      if (!current.rowCount) throw budgetError('BAI_BUDGET_CALL_MISSING');
      const reserved = BigInt(current.rows[0].reserved_cost_nano_usd);
      const effective = providerCost !== null && usageCost !== null ? (providerCost > usageCost ? providerCost : usageCost)
        : providerCost ?? usageCost ?? reserved;
      const source = providerCost !== null ? 'provider_reported'
        : usageCost !== null ? 'usage_priced' : 'reservation';
      await client.query(`UPDATE bai_model_budget_calls SET status=$2,input_tokens=$3,output_tokens=$4,
          provider_cost_nano_usd=$5,effective_cost_nano_usd=$6,cost_source=$7,
          failure_code=$8,completed_at=now()
        WHERE id=$1`, [callId, failed ? 'failed' : 'succeeded', inputTokens, outputTokens,
        providerCost === null ? null : String(providerCost), String(effective), source,
        failureCode ? String(failureCode).slice(0, 100) : null]);
      await client.query(`UPDATE bai_model_budget_guard
        SET active_call_id=NULL,active_until=NULL,updated_at=now() WHERE id=1`);
      const total = await client.query(`SELECT COALESCE(sum(effective_cost_nano_usd),0)::text AS amount
        FROM bai_model_budget_calls WHERE created_at > now()-interval '24 hours' AND status<>'blocked'`);
      await client.query(`UPDATE bai_model_budget_calls SET rolling24h_cost_nano_usd=$2 WHERE id=$1`,
        [callId, total.rows[0].amount]);
    });
  }

  async function runNow(input, send, extractUsage) {
    if (unsafe) throw budgetError('BAI_BUDGET_UNAVAILABLE');
    const callId = input.callId || randomUUID();
    let admission;
    try { admission = await admit({ ...input, callId }); }
    catch (error) {
      if (error.code !== 'BAI_MODEL_CALL_BUSY' && error.code !== 'BAI_PRICE_UNAVAILABLE') unsafe = true;
      throw error;
    }
    if (!admission.admitted) throw budgetError('MODEL_DAILY_BUDGET_EXCEEDED');
    let result;
    let failure;
    let usage = null;
    try {
      result = await send();
      usage = extractUsage ? await extractUsage(result) : result?.usage;
      return result;
    } catch (error) {
      failure = error;
      usage = error?.usage || null;
      throw error;
    } finally {
      try { await settle({ callId, model: input.model, usage,
        failed: Boolean(failure) || usage?.providerFailed === true,
        failureCode: failure?.code || failure?.message }); }
      catch (error) {
        unsafe = true;
        throw budgetError('BAI_BUDGET_SETTLEMENT_FAILED');
      }
    }
  }

  return {
    runRequest(input, send, extractUsage = null) {
      const result = queue.then(() => runNow(input, send, extractUsage));
      queue = result.catch(() => {});
      return result;
    },
    disable() { unsafe = true; },
    get unsafe() { return unsafe; }
  };
}

// Bring the prior rolling window into the new ledger before any new admission.
// Missing usage is deliberately charged as the whole cap until its 24h expiry.
export async function backfillBaiBudgetHistory(pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT id FROM bai_model_budget_guard WHERE id=1 FOR UPDATE');
    const cognition = await client.query(`SELECT id,world_id,agent_id,tier,model,trigger,status,
        input_tokens,output_tokens,created_at,completed_at
      FROM world_agent_cognition_model_calls
      WHERE created_at > now()-interval '24 hours' AND status<>'cached' ORDER BY created_at,id`);
    for (const row of cognition.rows) {
      let cost = MODEL_DAILY_BUDGET_NANO_USD;
      const input = nonnegativeToken(row.input_tokens);
      const output = nonnegativeToken(row.output_tokens);
      if (input !== null && output !== null && input + output > 0) {
        try { cost = baiPricedNanoUsd(row.model, input, output); }
        catch { /* Unknown historical rates occupy the full cap. */ }
      }
      const source = row.trigger === 'memory_selection' ? 'memorySelection'
        : row.trigger === 'model_analysis' ? 'modelAnalysis' : 'openCognition';
      await client.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
          request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
          effective_cost_nano_usd,input_tokens,output_tokens,cost_source,created_at,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,0,0,0,$8,$8,$9,$10,$11,$12,$13)
        ON CONFLICT(id) DO NOTHING`, [row.id, row.world_id, row.agent_id, source, row.tier,
        row.model, row.status === 'succeeded' ? 'succeeded' : 'failed', String(cost), input, output,
        input !== null && output !== null && input + output > 0 && cost !== MODEL_DAILY_BUDGET_NANO_USD
          ? 'usage_priced' : 'reservation', row.created_at, row.completed_at]);
    }
    const authoring = await client.query(`SELECT world_id,agent_id,model,cost_microunits,
        metadata,created_at FROM world_infrastructure_usage_events
      WHERE provider='bai' AND resource_category='ai_inference'
        AND created_at > now()-interval '24 hours' ORDER BY created_at,id`);
    for (const row of authoring.rows) {
      const id = row.metadata?.callId;
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id)) {
        throw budgetError('BAI_HISTORICAL_CALL_ID_MISSING');
      }
      const input = nonnegativeToken(row.metadata?.inputTokens);
      const output = nonnegativeToken(row.metadata?.outputTokens);
      let cost = row.cost_microunits !== null ? BigInt(row.cost_microunits) * 1_000n
        : MODEL_DAILY_BUDGET_NANO_USD;
      if (row.cost_microunits === null && input !== null && output !== null && input + output > 0) {
        try { cost = baiPricedNanoUsd(row.model, input, output); }
        catch { /* Unknown historical rates occupy the full cap. */ }
      }
      await client.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
          request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
          effective_cost_nano_usd,input_tokens,output_tokens,cost_source,created_at,completed_at)
        VALUES($1,$2,$3,'currencyGenesisAuthoring','other',$4,'succeeded',0,0,0,$5,$5,$6,$7,$8,$9,$9)
        ON CONFLICT(id) DO NOTHING`, [id, row.world_id, row.agent_id, row.model || 'unknown',
        String(cost), input, output, row.cost_microunits !== null ? 'provider_reported'
          : input !== null && output !== null && input + output > 0 && cost !== MODEL_DAILY_BUDGET_NANO_USD
            ? 'usage_priced' : 'reservation', row.created_at]);
    }
  });
}
