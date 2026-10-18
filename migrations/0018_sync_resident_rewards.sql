-- Additive SYNC resident reward accounting. This migration records only new source
-- events emitted after the immutable v1 policy activation timestamp.

CREATE TABLE arc_sync_resident_reward_policies (
  version integer PRIMARY KEY CHECK (version > 0),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
  activated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version,policy_hash)
);

INSERT INTO arc_sync_resident_reward_policies(version,policy_hash,policy)
VALUES (1,'5c3a9aac4183c9c52b2d8c56ad7d146b6af763d89c5e27c97bc8b3090311fea6',
  '{"schema":"sync-resident-reward-policy-v1","version":1,"conversion":{"rewardWeightPerResearchProjectEffortPoint":"1","rewardWeightPerCompletedBusinessProductionUnit":"1","syncRawPerRewardWeightUnit":"100000","syncDecimals":6},"commit":{"minimumPendingSyncRawPerAgent":"1000000"},"epochCap":{"formula":"min(remaining_epoch_economy_allocation, available_operating_pool_balance)","includeStormCleanupEntitlements":true},"eligibility":{"researchProjectEffort":true,"completedSharedProjectEffort":true,"completedBusinessProduction":true,"ordinaryDescriptiveCooperation":false,"unquantifiedOrdinaryWork":false,"tradeVolume":false,"paperTrade":false,"unsettledTrade":false,"stormCleanupFixedRewardPath":"preserved"},"retroactive":false}'::jsonb);

CREATE FUNCTION prevent_arc_sync_resident_reward_policy_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'SYNC resident reward policy versions are immutable';
END $$;
CREATE TRIGGER arc_sync_resident_reward_policy_immutable
  BEFORE UPDATE OR DELETE ON arc_sync_resident_reward_policies
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_resident_reward_policy_rewrite();

CREATE TABLE arc_sync_resident_reward_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN
    ('research_project','shared_project_cooperation','business_production')),
  source_event_id bigint NOT NULL REFERENCES world_events(id) ON DELETE RESTRICT,
  source_entity_id text NOT NULL CHECK (char_length(source_entity_id) BETWEEN 1 AND 180),
  reward_weight numeric(18,3) NOT NULL CHECK (reward_weight > 0),
  epoch_index bigint CHECK (epoch_index IS NULL OR epoch_index >= 0),
  policy_version integer NOT NULL,
  policy_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','accrued','not_eligible','cap_exceeded')),
  decision_reason text CHECK (decision_reason IS NULL OR decision_reason ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT arc_sync_resident_reward_contributions_world_event_key UNIQUE (world_id,source_event_id),
  CONSTRAINT arc_sync_resident_reward_contributions_world_id_id_key UNIQUE (world_id,id),
  CONSTRAINT arc_sync_resident_reward_contributions_world_agent_fkey FOREIGN KEY (world_id,agent_id)
    REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_resident_reward_contributions_policy_fkey FOREIGN KEY (policy_version,policy_hash)
    REFERENCES arc_sync_resident_reward_policies(version,policy_hash) ON DELETE RESTRICT,
  CONSTRAINT arc_sync_resident_reward_contributions_decision_check CHECK (
    (status IN ('queued','accrued') AND decision_reason IS NULL)
    OR (status IN ('not_eligible','cap_exceeded') AND decision_reason IS NOT NULL)),
  CONSTRAINT arc_sync_resident_reward_contributions_accrued_epoch_check CHECK (
    (status='queued' AND epoch_index IS NULL) OR (status<>'queued' AND epoch_index IS NOT NULL))
);
CREATE UNIQUE INDEX arc_sync_resident_reward_contributions_source_key
  ON arc_sync_resident_reward_contributions(world_id,source_type,source_entity_id);
CREATE INDEX arc_sync_resident_reward_contributions_queue_idx
  ON arc_sync_resident_reward_contributions(world_id,created_at,id) WHERE status='queued';
CREATE INDEX arc_sync_resident_reward_contributions_agent_epoch_idx
  ON arc_sync_resident_reward_contributions(world_id,agent_id,epoch_index,status);

CREATE TABLE arc_sync_resident_reward_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (action_id ~ '^sync-resident-reward-batch:[0-9a-f-]{36}$'),
  agent_id uuid NOT NULL,
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  status text NOT NULL DEFAULT 'committed' CHECK (status='committed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,id),
  UNIQUE(world_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);

CREATE TABLE arc_sync_resident_reward_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL,
  contribution_id uuid NOT NULL UNIQUE,
  epoch_index bigint NOT NULL CHECK (epoch_index >= 0),
  policy_version integer NOT NULL,
  policy_hash text NOT NULL,
  sync_amount_raw numeric(78,0) NOT NULL CHECK (sync_amount_raw > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed','paid')),
  batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  paid_at timestamptz,
  onchain_transaction_hash text CHECK (onchain_transaction_hash IS NULL OR
    onchain_transaction_hash ~ '^0x[0-9a-fA-F]{64}$'),
  UNIQUE(world_id,id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,contribution_id) REFERENCES arc_sync_resident_reward_contributions(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(policy_version,policy_hash) REFERENCES arc_sync_resident_reward_policies(version,policy_hash) ON DELETE RESTRICT,
  CHECK ((status='pending' AND batch_id IS NULL AND committed_at IS NULL AND paid_at IS NULL
      AND onchain_transaction_hash IS NULL)
    OR (status='committed' AND batch_id IS NOT NULL AND committed_at IS NOT NULL AND paid_at IS NULL
      AND onchain_transaction_hash IS NULL)
    OR (status='paid' AND batch_id IS NOT NULL AND committed_at IS NOT NULL AND paid_at IS NOT NULL
      AND onchain_transaction_hash IS NOT NULL))
);
CREATE INDEX arc_sync_resident_reward_entitlements_pending_idx
  ON arc_sync_resident_reward_entitlements(world_id,agent_id,created_at,id) WHERE status='pending';
CREATE INDEX arc_sync_resident_reward_entitlements_epoch_idx
  ON arc_sync_resident_reward_entitlements(world_id,epoch_index,status);

CREATE TABLE arc_sync_resident_reward_batch_items (
  world_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  entitlement_id uuid NOT NULL,
  PRIMARY KEY(world_id,entitlement_id),
  FOREIGN KEY(world_id,batch_id) REFERENCES arc_sync_resident_reward_batches(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,entitlement_id) REFERENCES arc_sync_resident_reward_entitlements(world_id,id) ON DELETE RESTRICT
);
ALTER TABLE arc_sync_resident_reward_entitlements
  ADD CONSTRAINT arc_sync_resident_reward_entitlements_batch_fkey
  FOREIGN KEY(world_id,batch_id) REFERENCES arc_sync_resident_reward_batches(world_id,id) ON DELETE RESTRICT;

CREATE FUNCTION validate_arc_sync_resident_reward_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_row arc_sync_resident_reward_policies%ROWTYPE;
  source_event world_events%ROWTYPE;
  project_contribution world_project_contributions%ROWTYPE;
  project world_projects%ROWTYPE;
  production world_business_production%ROWTYPE;
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
  ELSE
    RAISE EXCEPTION 'SYNC reward source type is unsupported';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_contribution_source_check
  BEFORE INSERT ON arc_sync_resident_reward_contributions
  FOR EACH ROW EXECUTE FUNCTION validate_arc_sync_resident_reward_contribution();

CREATE FUNCTION enforce_arc_sync_resident_reward_contribution_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entitlement arc_sync_resident_reward_entitlements%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SYNC reward contributions are append-only'; END IF;
  IF (NEW.id,NEW.world_id,NEW.agent_id,NEW.source_type,NEW.source_event_id,NEW.source_entity_id,
      NEW.reward_weight,NEW.policy_version,NEW.policy_hash,NEW.created_at)
      IS DISTINCT FROM
     (OLD.id,OLD.world_id,OLD.agent_id,OLD.source_type,OLD.source_event_id,OLD.source_entity_id,
      OLD.reward_weight,OLD.policy_version,OLD.policy_hash,OLD.created_at)
      OR OLD.status<>'queued'
      OR NEW.status NOT IN ('accrued','not_eligible','cap_exceeded') THEN
    RAISE EXCEPTION 'SYNC reward contribution allows one immutable adjudication';
  END IF;
  IF NEW.status='accrued' THEN
    SELECT * INTO entitlement FROM arc_sync_resident_reward_entitlements
      WHERE world_id=NEW.world_id AND contribution_id=NEW.id AND agent_id=NEW.agent_id
        AND epoch_index=NEW.epoch_index AND policy_version=NEW.policy_version
        AND policy_hash=NEW.policy_hash AND status='pending';
    IF entitlement.id IS NULL OR NEW.decision_reason IS NOT NULL THEN
      RAISE EXCEPTION 'accrued SYNC contribution requires its exact pending entitlement';
    END IF;
  ELSIF NEW.decision_reason IS NULL THEN
    RAISE EXCEPTION 'rejected SYNC contribution requires an explicit decision reason';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_contribution_transition
  BEFORE UPDATE OR DELETE ON arc_sync_resident_reward_contributions
  FOR EACH ROW EXECUTE FUNCTION enforce_arc_sync_resident_reward_contribution_transition();

CREATE FUNCTION validate_arc_sync_resident_reward_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  contribution arc_sync_resident_reward_contributions%ROWTYPE;
  policy_row arc_sync_resident_reward_policies%ROWTYPE;
  batch arc_sync_resident_reward_batches%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'SYNC reward entitlements are append-only'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT * INTO contribution FROM arc_sync_resident_reward_contributions
      WHERE world_id=NEW.world_id AND id=NEW.contribution_id;
    SELECT * INTO policy_row FROM arc_sync_resident_reward_policies
      WHERE version=NEW.policy_version AND policy_hash=NEW.policy_hash;
    IF NEW.status IS DISTINCT FROM 'pending' OR NEW.batch_id IS NOT NULL
        OR NEW.committed_at IS NOT NULL OR NEW.paid_at IS NOT NULL OR NEW.onchain_transaction_hash IS NOT NULL
        OR contribution.status IS DISTINCT FROM 'queued' OR contribution.agent_id IS DISTINCT FROM NEW.agent_id
        OR contribution.policy_version IS DISTINCT FROM NEW.policy_version
        OR contribution.policy_hash IS DISTINCT FROM NEW.policy_hash
        OR NEW.sync_amount_raw IS DISTINCT FROM floor(contribution.reward_weight
          * (policy_row.policy->'conversion'->>'syncRawPerRewardWeightUnit')::numeric) THEN
      RAISE EXCEPTION 'SYNC entitlement must exactly match a new source contribution and immutable policy';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.world_id,NEW.agent_id,NEW.contribution_id,NEW.epoch_index,NEW.policy_version,NEW.policy_hash,
      NEW.sync_amount_raw,NEW.created_at)
      IS DISTINCT FROM
     (OLD.id,OLD.world_id,OLD.agent_id,OLD.contribution_id,OLD.epoch_index,OLD.policy_version,OLD.policy_hash,
      OLD.sync_amount_raw,OLD.created_at) THEN
    RAISE EXCEPTION 'SYNC entitlement identity and amount are immutable';
  END IF;
  IF OLD.status='pending' AND NEW.status='committed' THEN
    SELECT * INTO batch FROM arc_sync_resident_reward_batches
      WHERE world_id=NEW.world_id AND id=NEW.batch_id AND agent_id=NEW.agent_id AND status='committed';
    IF batch.id IS NULL OR NEW.committed_at IS NULL OR NEW.paid_at IS NOT NULL
        OR NEW.onchain_transaction_hash IS NOT NULL OR NOT EXISTS (
          SELECT 1 FROM arc_sync_resident_reward_batch_items item
          WHERE item.world_id=NEW.world_id AND item.batch_id=batch.id AND item.entitlement_id=NEW.id) THEN
      RAISE EXCEPTION 'committed SYNC entitlement must belong to its conservation-authorized batch';
    END IF;
  ELSIF OLD.status='committed' AND NEW.status='paid' THEN
    IF NEW.batch_id IS DISTINCT FROM OLD.batch_id OR NEW.committed_at IS DISTINCT FROM OLD.committed_at
        OR NEW.paid_at IS NULL OR NEW.onchain_transaction_hash IS NULL OR NOT EXISTS (
          SELECT 1 FROM arc_sync_payout_outbox outbox JOIN arc_sync_ledger_transactions ledger
            ON ledger.world_id=outbox.world_id AND ledger.id=outbox.transaction_id
          JOIN arc_sync_resident_reward_batches reward_batch
            ON reward_batch.world_id=ledger.world_id AND reward_batch.action_id=ledger.source_economic_action_id
          WHERE outbox.world_id=NEW.world_id AND reward_batch.id=NEW.batch_id
            AND outbox.status='reconciled' AND outbox.transaction_hash=NEW.onchain_transaction_hash) THEN
      RAISE EXCEPTION 'paid SYNC entitlement requires a reconciled on-chain payout receipt';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid SYNC reward entitlement state transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_entitlement_transition
  BEFORE INSERT OR UPDATE OR DELETE ON arc_sync_resident_reward_entitlements
  FOR EACH ROW EXECUTE FUNCTION validate_arc_sync_resident_reward_entitlement();

CREATE FUNCTION prevent_arc_sync_resident_reward_batch_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'committed SYNC resident reward batches are immutable';
END $$;
CREATE TRIGGER arc_sync_resident_reward_batch_immutable
  BEFORE UPDATE OR DELETE ON arc_sync_resident_reward_batches
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_resident_reward_batch_rewrite();

CREATE FUNCTION validate_arc_sync_resident_reward_batch_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch arc_sync_resident_reward_batches%ROWTYPE;
  entitlement arc_sync_resident_reward_entitlements%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYNC resident reward batch items are immutable'; END IF;
  SELECT * INTO batch FROM arc_sync_resident_reward_batches
    WHERE world_id=NEW.world_id AND id=NEW.batch_id AND status='committed';
  SELECT * INTO entitlement FROM arc_sync_resident_reward_entitlements
    WHERE world_id=NEW.world_id AND id=NEW.entitlement_id AND status='pending';
  IF batch.id IS NULL OR entitlement.id IS NULL OR batch.agent_id IS DISTINCT FROM entitlement.agent_id THEN
    RAISE EXCEPTION 'SYNC reward batch item must join a pending entitlement for the same Agent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_batch_item_check
  BEFORE INSERT OR UPDATE OR DELETE ON arc_sync_resident_reward_batch_items
  FOR EACH ROW EXECUTE FUNCTION validate_arc_sync_resident_reward_batch_item();

-- Permit only two independently verifiable source classes to authorize this payout:
-- the existing fixed storm-cleanup path or a committed source-backed resident reward batch.
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
              AND evidence.data->'initiative'->>'serviceId'=production.service_id::text)))::integer AS valid_items,
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

GRANT SELECT ON arc_sync_resident_reward_policies TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_resident_reward_contributions TO synterra_app;
GRANT UPDATE(status,epoch_index,decision_reason,updated_at)
  ON arc_sync_resident_reward_contributions TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_resident_reward_entitlements TO synterra_app;
GRANT UPDATE(status,batch_id,committed_at,paid_at,onchain_transaction_hash)
  ON arc_sync_resident_reward_entitlements TO synterra_app;
GRANT SELECT,INSERT ON arc_sync_resident_reward_batches,arc_sync_resident_reward_batch_items TO synterra_app;
