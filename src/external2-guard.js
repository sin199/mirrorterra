export function modelSuccessMetric({ succeeded = 0, failed = 0, quotaExhausted = 0 } = {}) {
  const eligible = Number(succeeded) + Number(failed);
  return { eligible, succeeded: Number(succeeded), failed: Number(failed),
    quotaExhausted: Number(quotaExhausted), successRate: eligible ? Number(succeeded) / eligible : null };
}

async function inOrder(tasks) {
  const results = [];
  for (const task of tasks) results.push(await task());
  return results;
}

export async function readExternal2GuardSample(db, worldId) {
  const [clock, economy, oldJournal, newJournal, payoutSplit, infrastructure, acceptances, calls, policy] = await inOrder([
    () => db.query(`SELECT world_minutes::text AS minute,tick_count::text AS tick FROM world_runtime_state WHERE world_id=$1`, [worldId]),
    () => db.query(`SELECT
      (SELECT COALESCE(sum(spendable_raw),0) FROM arc_sync_internal_balances WHERE world_id=$1)::text AS residents,
      (SELECT COALESCE(balance_raw,0) FROM world_sync_treasury_balances WHERE world_id=$1)::text AS treasury,
      (SELECT COALESCE(sum(sync_amount_raw),0) FROM arc_sync_resident_reward_entitlements
        WHERE world_id=$1 AND status='pending')::text AS backed,
      (SELECT COALESCE(sum(sync_amount_raw),0) FROM world_sync_purchases WHERE world_id=$1)::text AS purchases,
      (SELECT COALESCE(sum(gross_raw),0) FROM world_external_withdrawals WHERE world_id=$1)::text AS converted,
      (SELECT count(*) FROM arc_sync_internal_balances WHERE world_id=$1 AND spendable_raw<0)::int AS negative`, [worldId]),
    () => db.query(`SELECT COALESCE(sum(amount_raw),0)::text AS total FROM arc_sync_ledger_postings WHERE world_id=$1`, [worldId]),
    () => db.query(`SELECT COALESCE(sum(amount_raw),0)::text AS total FROM world_external_ledger_postings WHERE world_id=$1`, [worldId]),
    () => db.query(`SELECT
      (SELECT count(*)::int FROM world_external_withdrawals WHERE world_id=$1) AS withdrawals,
      (SELECT count(*)::int FROM world_external_payout_outbox WHERE world_id=$1) AS payouts,
      count(*)::int AS bad FROM world_external_withdrawals w WHERE w.world_id=$1 AND
      (w.gross_raw<>w.net_raw+w.fee_raw OR w.fee_raw<>floor(w.gross_raw*3/100)
        OR (SELECT count(*) FROM world_external_payout_outbox p WHERE p.world_id=w.world_id AND p.withdrawal_id=w.id)<>2)`, [worldId]),
    () => db.query(`SELECT COALESCE((SELECT balance_raw FROM world_external_infrastructure_balances WHERE world_id=$1),0)::text AS balance,
      COALESCE((SELECT sum(fee_raw) FROM world_external_withdrawals WHERE world_id=$1),0)::text AS fees`, [worldId]),
    () => db.query(`SELECT count(*)::int AS bad FROM world_external_contribution_acceptances a
      JOIN world_external_contribution_receipts r ON r.world_id=a.world_id AND r.id=a.receipt_id
      WHERE a.world_id=$1 AND NOT mirrorterra_external_independent_pair(a.world_id,r.agent_id,a.acceptor_agent_id)`, [worldId]),
    () => db.query(`SELECT count(*) FILTER (WHERE status='succeeded' AND provider_error_code IS DISTINCT FROM 'insufficient_user_quota')::int AS succeeded,
      count(*) FILTER (WHERE status='failed' AND provider_error_code IS DISTINCT FROM 'insufficient_user_quota')::int AS failed,
      count(*) FILTER (WHERE provider_error_code='insufficient_user_quota')::int AS "quotaExhausted"
      FROM bai_model_budget_calls WHERE world_id=$1 AND provider_started_at>now()-interval '10 minutes'
        AND status IN ('succeeded','failed')`, [worldId]),
    () => db.query(`SELECT (public_work_rewards::int+research_rewards::int+verification_rewards::int) AS rewards,
      withdrawals::int AS withdrawals FROM world_external2_policy WHERE singleton`)
  ]);
  if (clock.rowCount !== 1) throw new Error('EXTERNAL2_GUARD_WORLD_MISSING');
  const sample = { worldMinute: BigInt(clock.rows[0].minute), tickCount: BigInt(clock.rows[0].tick),
    economyDelta: BigInt(economy.rows[0].residents)+BigInt(economy.rows[0].treasury)
      +BigInt(economy.rows[0].converted)-BigInt(economy.rows[0].backed)-BigInt(economy.rows[0].purchases),
    residentTotalRaw: BigInt(economy.rows[0].residents), treasuryTotalRaw: BigInt(economy.rows[0].treasury),
    pendingEntitlementTotalRaw: BigInt(economy.rows[0].backed), purchasedTotalRaw: BigInt(economy.rows[0].purchases),
    convertedGrossTotalRaw: BigInt(economy.rows[0].converted),
    withdrawalCount: Number(payoutSplit.rows[0].withdrawals), outboxPayoutCount: Number(payoutSplit.rows[0].payouts),
    infrastructureBalanceRaw: BigInt(infrastructure.rows[0].balance), infrastructureFeesRaw: BigInt(infrastructure.rows[0].fees),
    negativeResidentBalances: Number(economy.rows[0].negative),
    oldJournalDelta: BigInt(oldJournal.rows[0].total), newJournalDelta: BigInt(newJournal.rows[0].total),
    badPayoutSplits: Number(payoutSplit.rows[0].bad),
    infrastructureDelta: BigInt(infrastructure.rows[0].balance) - BigInt(infrastructure.rows[0].fees),
    invalidAcceptances: Number(acceptances.rows[0].bad),
    rewardFeaturesEnabled: Number(policy.rows[0].rewards), withdrawalsEnabled: Number(policy.rows[0].withdrawals), model: modelSuccessMetric(calls.rows[0]) };
  if (sample.economyDelta !== 0n || sample.negativeResidentBalances
      || sample.oldJournalDelta !== 0n || sample.newJournalDelta !== 0n || sample.badPayoutSplits
      || sample.infrastructureDelta !== 0n || sample.invalidAcceptances) {
    throw new Error('EXTERNAL2_GUARD_LEDGER_OR_EVIDENCE_INVALID');
  }
  return sample;
}
