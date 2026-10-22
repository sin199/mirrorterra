-- MirrorTerra internal SYNC economy (additive). SYNC is booked internally now and converted
-- on chain later. Nothing here writes to arc_sync_payout_outbox, debits the ledger pool, or
-- backfills history: policy v2 is non-retroactive and only new post-activation events qualify.
--  * policy v2 adds the skill_output source (producer of an output another resident used);
--  * the source CHECK is widened (drop + re-add with a superset) and the two validating functions
--    are re-created with every existing branch unchanged plus a skill_output branch;
--  * new append-only tables: capacity snapshots, internal transfers, internal orders;
--  * new read-only view: arc_sync_internal_balances.
-- Internal transfers only move SYNC between residents; total internal SYNC always equals the
-- pending entitlements, which are reserved against the operating pool and epoch quota.

INSERT INTO arc_sync_resident_reward_policies(version,policy_hash,policy)
VALUES (2,'0fd278f4a2baaded278063b1c9444ff3901f6a42ba5533af5f654d7e871397c2',
  '{"schema":"sync-resident-reward-policy-v2","version":2,"conversion":{"rewardWeightPerResearchProjectEffortPoint":"1","rewardWeightPerCompletedBusinessProductionUnit":"1","rewardWeightPerConsumedSkillOutputQuality":"1","syncRawPerRewardWeightUnit":"100000","syncDecimals":6},"commit":{"minimumPendingSyncRawPerAgent":"1000000","enabledByDefault":false,"enableEnv":"SYNC_RESIDENT_REWARD_COMMIT_ENABLED"},"epochCap":{"formula":"min(remaining_epoch_economy_allocation, available_operating_pool_balance)","includeStormCleanupEntitlements":true},"backing":{"internalSync":"pending_entitlements_reserved_against_operating_pool_and_epoch_quota","internalTransfersCreateSync":false,"laterConversion":"one_to_one"},"residentLimits":"none","eligibility":{"researchProjectEffort":true,"completedSharedProjectEffort":true,"completedBusinessProduction":true,"consumedSkillOutput":true,"skillOutputRequiresDistinctConsumer":true,"ordinaryDescriptiveCooperation":false,"unquantifiedOrdinaryWork":false,"tradeVolume":false,"paperTrade":false,"unsettledTrade":false,"stormCleanupFixedRewardPath":"preserved"},"retroactive":false}'::jsonb);

ALTER TABLE arc_sync_resident_reward_contributions
  DROP CONSTRAINT arc_sync_resident_reward_contributions_source_type_check;
ALTER TABLE arc_sync_resident_reward_contributions
  ADD CONSTRAINT arc_sync_resident_reward_contributions_source_type_check CHECK (source_type IN
    ('research_project','shared_project_cooperation','business_production','skill_output'));

CREATE OR REPLACE FUNCTION validate_arc_sync_resident_reward_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_row arc_sync_resident_reward_policies%ROWTYPE;
  source_event world_events%ROWTYPE;
  project_contribution world_project_contributions%ROWTYPE;
  project world_projects%ROWTYPE;
  production world_business_production%ROWTYPE;
  skill_output world_skill_outputs%ROWTYPE;
  skill_output_factor numeric;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SYNC reward source records are append-only'; END IF;
  SELECT * INTO policy_row FROM arc_sync_resident_reward_policies
    WHERE version=NEW.policy_version AND policy_hash=NEW.policy_hash;
  SELECT * INTO source_event FROM world_events WHERE id=NEW.source_event_id;
  IF NOT FOUND OR policy_row.version IS NULL OR NEW.status IS DISTINCT FROM 'queued'
      OR NEW.epoch_index IS NOT NULL OR NEW.decision_reason IS NOT NULL
      OR source_event.world_id IS DISTINCT FROM NEW.world_id
      OR source_event.actor_id IS DISTINCT FROM NEW.agent_id
      OR source_event.created_at < policy_row.activated_at THEN
    RAISE EXCEPTION 'SYNC reward source must be a new post-policy authoritative event';
  END IF;
  IF NEW.source_type IN ('research_project','shared_project_cooperation') THEN
    SELECT * INTO project_contribution FROM world_project_contributions
      WHERE world_id=NEW.world_id AND id::text=NEW.source_entity_id;
    SELECT * INTO project FROM world_projects
      WHERE world_id=NEW.world_id AND id=project_contribution.project_id;
    IF project_contribution.id IS NULL OR project_contribution.agent_id IS DISTINCT FROM NEW.agent_id
        OR project_contribution.effort_points IS DISTINCT FROM NEW.reward_weight
        OR source_event.event_type IS DISTINCT FROM 'world.project_contribution'
        OR source_event.action_id IS DISTINCT FROM project_contribution.action_id
        OR source_event.data->>'projectId' IS DISTINCT FROM project.id::text
        OR (source_event.data->>'effortPoints')::numeric IS DISTINCT FROM project_contribution.effort_points
        OR project_contribution.created_at < policy_row.activated_at THEN
      RAISE EXCEPTION 'SYNC reward project effort does not match authoritative contribution evidence';
    END IF;
    IF NEW.source_type='research_project'
        AND project.project_type NOT IN ('RESEARCH','LEARNING')
        AND project_contribution.contribution_type NOT IN ('research','learning') THEN
      RAISE EXCEPTION 'SYNC research reward requires attributable research effort';
    END IF;
    IF NEW.source_type='shared_project_cooperation'
        AND (project.project_type IN ('RESEARCH','LEARNING')
          OR project_contribution.contribution_type IN ('research','learning')) THEN
      RAISE EXCEPTION 'SYNC shared project reward source classification mismatch';
    END IF;
  ELSIF NEW.source_type='business_production' THEN
    SELECT * INTO production FROM world_business_production
      WHERE world_id=NEW.world_id AND id::text=NEW.source_entity_id;
    IF production.id IS NULL OR production.agent_id IS DISTINCT FROM NEW.agent_id
        OR production.units::numeric IS DISTINCT FROM NEW.reward_weight
        OR production.created_at < policy_row.activated_at
        OR source_event.event_type IS DISTINCT FROM 'world.action_completed'
        OR source_event.data->>'action' IS DISTINCT FROM 'business_work'
        OR source_event.data->>'initiativeAction' IS DISTINCT FROM 'business_work'
        OR source_event.data->>'status' IS DISTINCT FROM 'completed'
        OR source_event.data->'initiative'->>'productionId' IS DISTINCT FROM production.id::text
        OR source_event.data->'initiative'->>'producerAgentId' IS DISTINCT FROM NEW.agent_id::text
        OR source_event.data->'initiative'->>'businessId' IS DISTINCT FROM production.business_id::text
        OR source_event.data->'initiative'->>'serviceId' IS DISTINCT FROM production.service_id::text THEN
      RAISE EXCEPTION 'SYNC business reward requires completed attributable production';
    END IF;
  ELSIF NEW.source_type='skill_output' THEN
    -- Producer reward for an output another resident used: 1 weight x quality (policy factor).
    skill_output_factor := (policy_row.policy->'conversion'->>'rewardWeightPerConsumedSkillOutputQuality')::numeric;
    SELECT * INTO skill_output FROM world_skill_outputs
      WHERE world_id=NEW.world_id AND output_id::text=NEW.source_entity_id;
    IF skill_output_factor IS NULL OR skill_output.output_id IS NULL
        OR skill_output.producer_id IS DISTINCT FROM NEW.agent_id
        OR skill_output.consumer_id IS NULL OR skill_output.consumer_id=skill_output.producer_id
        OR skill_output.consumed_at IS NULL OR skill_output.consumed_at < policy_row.activated_at
        OR NEW.reward_weight IS DISTINCT FROM (skill_output.quality::numeric * skill_output_factor)
        OR source_event.event_type IS DISTINCT FROM 'world.skill_output_delivered'
        OR source_event.data->>'outputId' IS DISTINCT FROM skill_output.output_id::text
        OR source_event.data->>'consumerId' IS DISTINCT FROM skill_output.consumer_id::text THEN
      RAISE EXCEPTION 'SYNC skill output reward requires a consumed output used by another resident';
    END IF;
  ELSE
    RAISE EXCEPTION 'SYNC reward source type is unsupported';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enforce_arc_sync_committed_double_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
  posting_sum numeric;
  payout arc_sync_payout_outbox%ROWTYPE;
  pool_debits integer;
  recipient_credits integer;
  current_balance numeric;
  batch world_sync_work_order_batches%ROWTYPE;
  reward_batch arc_sync_resident_reward_batches%ROWTYPE;
  item_count integer;
  total_items integer;
  item_sum numeric;
  valid_items integer;
  minimum_batch_raw numeric;
BEGIN
  IF NEW.status<>'committed' THEN RETURN NEW; END IF;
  SELECT * INTO payout FROM arc_sync_payout_outbox
    WHERE world_id=NEW.world_id AND transaction_id=NEW.id AND action_id=NEW.action_id;
  IF NOT FOUND OR payout.status<>'committed' THEN
    RAISE EXCEPTION 'committed SYNC payout requires its matching committed outbox';
  END IF;
  SELECT count(*)::integer,COALESCE(sum(posting.amount_raw),0),
      count(*) FILTER (WHERE account.account_type='operating_pool' AND posting.amount_raw=-payout.amount_raw)::integer,
      count(*) FILTER (WHERE account.account_type='agent' AND account.agent_id=payout.agent_id
        AND posting.amount_raw=payout.amount_raw)::integer
    INTO entry_count,posting_sum,pool_debits,recipient_credits
    FROM arc_sync_ledger_postings posting JOIN arc_sync_ledger_accounts account
      ON account.world_id=posting.world_id AND account.id=posting.account_id
    WHERE posting.world_id=NEW.world_id AND posting.transaction_id=NEW.id;
  IF entry_count<>2 OR posting_sum<>0 OR pool_debits<>1 OR recipient_credits<>1 THEN
    RAISE EXCEPTION 'SYNC payout requires exact Operating Pool debit and Agent credit';
  END IF;

  SELECT * INTO batch FROM world_sync_work_order_batches
    WHERE world_id=NEW.world_id AND action_id=NEW.source_economic_action_id;
  IF FOUND THEN
    IF batch.agent_id<>payout.agent_id OR batch.amount_raw<>payout.amount_raw
        OR lower(batch.recipient_address)<>lower(payout.recipient_address) THEN
      RAISE EXCEPTION 'SYNC storm cleanup batch does not match payout';
    END IF;
    SELECT count(*)::integer,COALESCE(sum(work_order.raw_sync_reward),0)
      INTO item_count,item_sum
      FROM world_sync_work_order_batch_items item JOIN world_sync_work_orders work_order
        ON work_order.world_id=item.world_id AND work_order.id=item.work_order_id
      JOIN world_sync_cleanup_targets target ON target.world_id=work_order.world_id AND target.id=work_order.target_id
      JOIN world_events evidence ON evidence.id=work_order.evidence_event_id
      WHERE item.world_id=NEW.world_id AND item.batch_id=batch.id
        AND work_order.status='batched' AND work_order.accepted_agent_id=batch.agent_id
        AND work_order.verified_world_minute IS NOT NULL AND target.status='cleared'
        AND target.cleared_by_agent_id=batch.agent_id
        AND target.cleared_world_minute=work_order.verified_world_minute
        AND target.cleared_at>work_order.accepted_at
        AND evidence.world_id=work_order.world_id AND evidence.actor_id=batch.agent_id
        AND evidence.event_type='world.action_completed' AND evidence.data->>'action'='work'
        AND evidence.data->'work'->>'output'='storm_debris_cleared'
        AND evidence.data->'work'->>'targetId'=target.id::text
        AND evidence.data->'work'->>'workOrderId'=work_order.id::text
        AND evidence.created_at>work_order.accepted_at
        AND (evidence.data->>'worldMinutes')::bigint>=work_order.accepted_world_minute;
    SELECT count(*)::integer INTO total_items FROM world_sync_work_order_batch_items
      WHERE world_id=NEW.world_id AND batch_id=batch.id;
    IF item_count=0 OR item_count<>total_items OR item_sum<>batch.amount_raw THEN
      RAISE EXCEPTION 'SYNC storm batch lacks verified completed work order evidence';
    END IF;
  ELSE
    SELECT * INTO reward_batch FROM arc_sync_resident_reward_batches
      WHERE world_id=NEW.world_id AND action_id=NEW.source_economic_action_id AND status='committed';
    IF NOT FOUND OR reward_batch.agent_id<>payout.agent_id OR reward_batch.amount_raw<>payout.amount_raw
        OR lower(reward_batch.recipient_address)<>lower(payout.recipient_address) THEN
      RAISE EXCEPTION 'SYNC payout requires a matching resident reward entitlement batch';
    END IF;
    SELECT count(*)::integer,
        count(*) FILTER (WHERE entitlement.status='committed'
          AND entitlement.batch_id=reward_batch.id AND entitlement.agent_id=reward_batch.agent_id
          AND contribution.status='accrued' AND contribution.agent_id=reward_batch.agent_id
          AND contribution.epoch_index=entitlement.epoch_index
          AND contribution.policy_version=entitlement.policy_version
          AND contribution.policy_hash=entitlement.policy_hash
          AND entitlement.sync_amount_raw=floor(contribution.reward_weight
            * (policy.policy->'conversion'->>'syncRawPerRewardWeightUnit')::numeric)
          AND evidence.actor_id=contribution.agent_id
          AND evidence.created_at>=policy.activated_at
          AND (
            (contribution.source_type='research_project'
              AND project_contribution.id IS NOT NULL
              AND project_contribution.agent_id=contribution.agent_id
              AND project_contribution.effort_points=contribution.reward_weight
              AND (project.project_type IN ('RESEARCH','LEARNING')
                OR project_contribution.contribution_type IN ('research','learning'))
              AND evidence.event_type='world.project_contribution'
              AND evidence.action_id=project_contribution.action_id
              AND evidence.data->>'projectId'=project.id::text
              AND (evidence.data->>'effortPoints')::numeric=project_contribution.effort_points)
            OR (contribution.source_type='shared_project_cooperation'
              AND project_contribution.id IS NOT NULL
              AND project_contribution.agent_id=contribution.agent_id
              AND project_contribution.effort_points=contribution.reward_weight
              AND project.status='completed'
              AND (SELECT count(DISTINCT actual_contribution.agent_id)
                FROM world_project_contributions actual_contribution
                WHERE actual_contribution.world_id=contribution.world_id
                  AND actual_contribution.project_id=project.id)>=2
              AND project.project_type NOT IN ('RESEARCH','LEARNING')
              AND project_contribution.contribution_type NOT IN ('research','learning')
              AND evidence.event_type='world.project_contribution'
              AND evidence.action_id=project_contribution.action_id
              AND evidence.data->>'projectId'=project.id::text
              AND (evidence.data->>'effortPoints')::numeric=project_contribution.effort_points)
            OR (contribution.source_type='business_production'
              AND production.id IS NOT NULL AND production.agent_id=contribution.agent_id
              AND production.units::numeric=contribution.reward_weight
              AND evidence.event_type='world.action_completed'
              AND evidence.data->>'action'='business_work'
              AND evidence.data->>'initiativeAction'='business_work'
              AND evidence.data->>'status'='completed'
              AND evidence.data->'initiative'->>'productionId'=production.id::text
              AND evidence.data->'initiative'->>'producerAgentId'=contribution.agent_id::text
              AND evidence.data->'initiative'->>'businessId'=production.business_id::text
              AND evidence.data->'initiative'->>'serviceId'=production.service_id::text)
            OR (contribution.source_type='skill_output'
              AND skill_output.output_id IS NOT NULL AND skill_output.producer_id=contribution.agent_id
              AND skill_output.consumer_id IS NOT NULL AND skill_output.consumer_id<>skill_output.producer_id
              AND skill_output.consumed_at>=policy.activated_at
              AND (policy.policy->'conversion'->>'rewardWeightPerConsumedSkillOutputQuality') IS NOT NULL
              AND contribution.reward_weight=skill_output.quality::numeric
                * (policy.policy->'conversion'->>'rewardWeightPerConsumedSkillOutputQuality')::numeric
              AND evidence.event_type='world.skill_output_delivered'
              AND evidence.data->>'outputId'=skill_output.output_id::text
              AND evidence.data->>'consumerId'=skill_output.consumer_id::text)))::integer AS valid_items,
        COALESCE(sum(entitlement.sync_amount_raw),0)::numeric AS total_amount
      INTO total_items,valid_items,item_sum
      FROM arc_sync_resident_reward_batch_items item
      JOIN arc_sync_resident_reward_entitlements entitlement
        ON entitlement.world_id=item.world_id AND entitlement.id=item.entitlement_id
      JOIN arc_sync_resident_reward_contributions contribution
        ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
      JOIN arc_sync_resident_reward_policies policy
        ON policy.version=contribution.policy_version AND policy.policy_hash=contribution.policy_hash
      JOIN world_events evidence ON evidence.id=contribution.source_event_id
      LEFT JOIN world_project_contributions project_contribution
        ON contribution.source_type IN ('research_project','shared_project_cooperation')
        AND project_contribution.world_id=contribution.world_id
        AND project_contribution.id::text=contribution.source_entity_id
      LEFT JOIN world_projects project ON project.world_id=project_contribution.world_id
        AND project.id=project_contribution.project_id
      LEFT JOIN world_business_production production
        ON contribution.source_type='business_production' AND production.world_id=contribution.world_id
        AND production.id::text=contribution.source_entity_id
      LEFT JOIN world_skill_outputs skill_output
        ON contribution.source_type='skill_output' AND skill_output.world_id=contribution.world_id
        AND skill_output.output_id::text=contribution.source_entity_id
      WHERE item.world_id=NEW.world_id AND item.batch_id=reward_batch.id;
    SELECT min((policy.policy->'commit'->>'minimumPendingSyncRawPerAgent')::numeric)
      INTO minimum_batch_raw
      FROM arc_sync_resident_reward_batch_items item
      JOIN arc_sync_resident_reward_entitlements entitlement
        ON entitlement.world_id=item.world_id AND entitlement.id=item.entitlement_id
      JOIN arc_sync_resident_reward_policies policy
        ON policy.version=entitlement.policy_version AND policy.policy_hash=entitlement.policy_hash
      WHERE item.world_id=NEW.world_id AND item.batch_id=reward_batch.id;
    IF minimum_batch_raw IS NULL OR reward_batch.amount_raw<minimum_batch_raw THEN
      RAISE EXCEPTION 'SYNC reward batch is below its immutable policy commitment threshold';
    END IF;
    IF total_items=0 OR valid_items<>total_items OR item_sum<>reward_batch.amount_raw THEN
      RAISE EXCEPTION 'SYNC reward batch lacks exact source entitlement, Agent, policy, or amount authorization';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM arc_agent_wallets wallet WHERE wallet.world_id=NEW.world_id
      AND wallet.agent_id=payout.agent_id AND wallet.chain_id=5042 AND wallet.status='active'
      AND lower(wallet.address)=lower(payout.recipient_address)) THEN
    RAISE EXCEPTION 'SYNC payout recipient must be an active Agent wallet';
  END IF;
  SELECT account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0) INTO current_balance
    FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
      ON posting.world_id=account.world_id AND posting.account_id=account.id
    WHERE account.world_id=NEW.world_id AND account.account_type='operating_pool'
    GROUP BY account.id,account.opening_balance_raw;
  IF current_balance IS NULL OR current_balance<0 THEN
    RAISE EXCEPTION 'SYNC Operating Pool ledger balance cannot be negative';
  END IF;
  RETURN NEW;
END $$;

-- Last chain-observed reward capacity; lets accrual continue from saved values when RPC fails.
CREATE TABLE arc_sync_reward_capacity_snapshots (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  epoch_index bigint NOT NULL CHECK (epoch_index >= 0),
  epoch_start bigint NOT NULL CHECK (epoch_start >= 0),
  economy_quota_raw numeric(78,0) NOT NULL CHECK (economy_quota_raw >= 0),
  onchain_pool_balance_raw numeric(78,0) NOT NULL CHECK (onchain_pool_balance_raw >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,block_number)
);

CREATE FUNCTION prevent_arc_sync_append_only_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SYNC internal economy records are append-only';
END $$;
CREATE TRIGGER arc_sync_reward_capacity_snapshot_immutable
  BEFORE UPDATE OR DELETE ON arc_sync_reward_capacity_snapshots
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

-- Internal SYNC transfers between residents. They never create SYNC.
CREATE TABLE arc_sync_internal_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  from_agent_id uuid NOT NULL,
  to_agent_id uuid NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  kind text NOT NULL CHECK (kind IN ('business_service_payment','business_wage')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 180),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_agent_id <> to_agent_id),
  UNIQUE (world_id,action_id),
  UNIQUE (world_id,id),
  FOREIGN KEY (world_id,from_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,to_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX arc_sync_internal_transfers_from_idx ON arc_sync_internal_transfers(world_id,from_agent_id,created_at);
CREATE INDEX arc_sync_internal_transfers_to_idx ON arc_sync_internal_transfers(world_id,to_agent_id,created_at);

-- Internal balance = pending (unconverted) entitlements + received - sent.
CREATE VIEW arc_sync_internal_balances AS
SELECT member.world_id,member.agent_id,
  COALESCE(earned.amount_raw,0)::numeric(78,0) AS earned_raw,
  COALESCE(received.amount_raw,0)::numeric(78,0) AS received_raw,
  COALESCE(sent.amount_raw,0)::numeric(78,0) AS sent_raw,
  (COALESCE(earned.amount_raw,0)+COALESCE(received.amount_raw,0)-COALESCE(sent.amount_raw,0))::numeric(78,0) AS spendable_raw
FROM world_members member
LEFT JOIN LATERAL (SELECT sum(entitlement.sync_amount_raw) AS amount_raw
  FROM arc_sync_resident_reward_entitlements entitlement
  WHERE entitlement.world_id=member.world_id AND entitlement.agent_id=member.agent_id
    AND entitlement.status='pending') earned ON true
LEFT JOIN LATERAL (SELECT sum(transfer.amount_raw) AS amount_raw FROM arc_sync_internal_transfers transfer
  WHERE transfer.world_id=member.world_id AND transfer.to_agent_id=member.agent_id) received ON true
LEFT JOIN LATERAL (SELECT sum(transfer.amount_raw) AS amount_raw FROM arc_sync_internal_transfers transfer
  WHERE transfer.world_id=member.world_id AND transfer.from_agent_id=member.agent_id) sent ON true;

CREATE FUNCTION validate_arc_sync_internal_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  spendable numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYNC internal transfers are append-only'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sync-internal:' || NEW.world_id::text || ':' || NEW.from_agent_id::text,0));
  SELECT balance.spendable_raw INTO spendable FROM arc_sync_internal_balances balance
    WHERE balance.world_id=NEW.world_id AND balance.agent_id=NEW.from_agent_id;
  IF spendable IS NULL OR spendable < NEW.amount_raw THEN
    RAISE EXCEPTION 'SYNC internal transfer exceeds the sender backed internal balance';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_internal_transfer_check
  BEFORE INSERT OR UPDATE OR DELETE ON arc_sync_internal_transfers
  FOR EACH ROW EXECUTE FUNCTION validate_arc_sync_internal_transfer();

-- Business sales settled in internal SYNC; each order is backed by exactly one transfer.
CREATE TABLE world_sync_internal_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES world_businesses(id) ON DELETE RESTRICT,
  service_id uuid NOT NULL REFERENCES world_business_services(id) ON DELETE RESTRICT,
  customer_agent_id uuid NOT NULL,
  provider_agent_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  pricing jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pricing)='object'),
  status text NOT NULL DEFAULT 'fulfilled' CHECK (status='fulfilled'),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  benefit jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(benefit)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (customer_agent_id <> provider_agent_id),
  UNIQUE (world_id,customer_agent_id,action_id),
  UNIQUE (world_id,transfer_id),
  FOREIGN KEY (world_id,customer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,provider_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,transfer_id) REFERENCES arc_sync_internal_transfers(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX world_sync_internal_orders_business_idx ON world_sync_internal_orders(world_id,business_id,created_at);

CREATE FUNCTION validate_world_sync_internal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transfer arc_sync_internal_transfers%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYNC internal orders are append-only'; END IF;
  SELECT * INTO transfer FROM arc_sync_internal_transfers WHERE world_id=NEW.world_id AND id=NEW.transfer_id;
  IF transfer.id IS NULL OR transfer.kind<>'business_service_payment'
      OR transfer.from_agent_id<>NEW.customer_agent_id OR transfer.to_agent_id<>NEW.provider_agent_id
      OR transfer.amount_raw<>NEW.amount_raw THEN
    RAISE EXCEPTION 'SYNC internal order must match its internal transfer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_sync_internal_order_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_sync_internal_orders
  FOR EACH ROW EXECUTE FUNCTION validate_world_sync_internal_order();

-- Commit gate enforced in the database: a resident reward batch (and therefore an
-- arc_sync_payout_outbox row and a ledger pool debit) can only be written by a transaction that
-- explicitly opted in (SYNC_RESIDENT_REWARD_COMMIT_ENABLED=true in the application), and never for
-- an agent whose internal SYNC moved, because its net balance no longer equals its gross entitlements.
CREATE FUNCTION enforce_arc_sync_resident_reward_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('mirrorterra.sync_resident_reward_commit', true), '') <> 'enabled' THEN
    RAISE EXCEPTION 'SYNC resident reward commit is disabled; internal SYNC stays pending until conversion';
  END IF;
  IF EXISTS (SELECT 1 FROM arc_sync_internal_transfers transfer WHERE transfer.world_id=NEW.world_id
      AND (transfer.from_agent_id=NEW.agent_id OR transfer.to_agent_id=NEW.agent_id)) THEN
    RAISE EXCEPTION 'SYNC resident reward batch cannot pay gross entitlements for an agent with internal transfers';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_batch_commit_gate
  BEFORE INSERT ON arc_sync_resident_reward_batches
  FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_resident_reward_commit_gate();

GRANT SELECT,INSERT ON arc_sync_reward_capacity_snapshots TO synterra_app;
GRANT USAGE ON SEQUENCE arc_sync_reward_capacity_snapshots_id_seq TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_internal_transfers,world_sync_internal_orders TO synterra_app;
GRANT SELECT ON arc_sync_internal_balances TO synterra_app;
