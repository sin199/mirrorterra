-- Formal World work orders are the only Operating Pool earning source after Genesis.
-- Existing simulated-USDC transactions remain historical and cannot authorize SYNC.
CREATE TABLE world_sync_cleanup_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  opportunity_id uuid NOT NULL,
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 1 AND 180),
  scene_id uuid NOT NULL,
  location text NOT NULL CHECK (char_length(location) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind='storm_debris'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cleared')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute>=0),
  created_at timestamptz NOT NULL DEFAULT now(),
  cleared_world_minute bigint,
  cleared_at timestamptz,
  cleared_by_agent_id uuid,
  UNIQUE(world_id,id), UNIQUE(world_id,opportunity_id), UNIQUE(world_id,source_key),
  FOREIGN KEY(world_id,opportunity_id) REFERENCES world_opportunities(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,scene_id) REFERENCES world_scenes(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,cleared_by_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  CHECK ((status='pending' AND cleared_world_minute IS NULL AND cleared_at IS NULL
      AND cleared_by_agent_id IS NULL)
    OR (status='cleared' AND cleared_world_minute IS NOT NULL AND cleared_at IS NOT NULL
      AND cleared_by_agent_id IS NOT NULL AND cleared_world_minute>=created_world_minute
      AND cleared_at>created_at))
);

CREATE FUNCTION validate_world_sync_cleanup_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  opportunity world_opportunities%ROWTYPE;
  scene_name text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO opportunity FROM world_opportunities WHERE world_id=NEW.world_id AND id=NEW.opportunity_id;
    SELECT name INTO scene_name FROM world_scenes WHERE world_id=NEW.world_id AND id=NEW.scene_id;
    IF NOT FOUND OR opportunity.creator_agent_id IS NOT NULL
        OR opportunity.source_type IS DISTINCT FROM 'event'
        OR opportunity.opportunity_type IS DISTINCT FROM 'WORK'
        OR opportunity.metadata->>'needReason' IS DISTINCT FROM 'storm_damage'
        OR opportunity.scene_id IS DISTINCT FROM NEW.scene_id
        OR scene_name IS DISTINCT FROM NEW.location
        OR opportunity.source_key IS DISTINCT FROM NEW.source_key
        OR opportunity.created_world_time IS DISTINCT FROM NEW.created_world_minute
        OR NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'cleanup target requires a new protocol storm debris source';
    END IF;
  ELSE
    IF (NEW.world_id,NEW.opportunity_id,NEW.source_key,NEW.scene_id,NEW.location,NEW.kind,
        NEW.created_world_minute,NEW.created_at)
      IS DISTINCT FROM
       (OLD.world_id,OLD.opportunity_id,OLD.source_key,OLD.scene_id,OLD.location,OLD.kind,
        OLD.created_world_minute,OLD.created_at)
        OR OLD.status<>'pending' OR NEW.status<>'cleared' THEN
      RAISE EXCEPTION 'cleanup target may only change from pending to cleared once';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM world_sync_work_orders work_order
      WHERE work_order.world_id=NEW.world_id AND work_order.target_id=NEW.id
        AND work_order.status='accepted' AND work_order.accepted_agent_id=NEW.cleared_by_agent_id
        AND NEW.cleared_world_minute BETWEEN work_order.accepted_world_minute
          AND work_order.deadline_world_minute) THEN
      RAISE EXCEPTION 'cleanup target requires an accepted work order and matching Agent';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_sync_cleanup_target_validity BEFORE INSERT OR UPDATE ON world_sync_cleanup_targets
  FOR EACH ROW EXECUTE FUNCTION validate_world_sync_cleanup_target();

CREATE TABLE world_sync_work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  opportunity_id uuid NOT NULL,
  target_id uuid NOT NULL,
  source_key text NOT NULL CHECK (char_length(source_key) BETWEEN 8 AND 180),
  budget_source text NOT NULL CHECK (budget_source='world_operating_pool'),
  raw_sync_reward numeric(78,0) NOT NULL CHECK (raw_sync_reward>0),
  acceptance_criteria jsonb NOT NULL CHECK (jsonb_typeof(acceptance_criteria)='object'),
  evidence_requirements jsonb NOT NULL CHECK (jsonb_typeof(evidence_requirements)='object'),
  published_world_minute bigint NOT NULL CHECK (published_world_minute>=0),
  deadline_world_minute bigint NOT NULL CHECK (deadline_world_minute>published_world_minute),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','verified','batched','cancelled','expired','failed')),
  accepted_agent_id uuid,
  accepted_world_minute bigint,
  accepted_at timestamptz,
  evidence_event_id bigint REFERENCES world_events(id) ON DELETE RESTRICT,
  verified_world_minute bigint,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id), UNIQUE (world_id,opportunity_id), UNIQUE (world_id,target_id), UNIQUE (world_id,source_key),
  FOREIGN KEY (world_id,opportunity_id) REFERENCES world_opportunities(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,target_id) REFERENCES world_sync_cleanup_targets(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,accepted_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  CHECK ((status='open' AND accepted_agent_id IS NULL AND accepted_world_minute IS NULL AND accepted_at IS NULL)
    OR (status IN ('accepted','verified','batched','failed') AND accepted_agent_id IS NOT NULL
      AND accepted_world_minute IS NOT NULL AND accepted_at IS NOT NULL)
    OR status IN ('cancelled','expired')),
  CHECK (status NOT IN ('verified','batched') OR (evidence_event_id IS NOT NULL AND verified_world_minute IS NOT NULL))
);
CREATE INDEX world_sync_work_orders_active_idx ON world_sync_work_orders(world_id,status,deadline_world_minute);

CREATE FUNCTION validate_world_sync_work_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  opportunity world_opportunities%ROWTYPE;
  target world_sync_cleanup_targets%ROWTYPE;
  evidence_row world_events%ROWTYPE;
  scene_name text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT * INTO opportunity FROM world_opportunities WHERE world_id=NEW.world_id AND id=NEW.opportunity_id;
    SELECT * INTO target FROM world_sync_cleanup_targets WHERE world_id=NEW.world_id AND id=NEW.target_id;
    IF NOT FOUND OR opportunity.creator_agent_id IS NOT NULL
        OR opportunity.source_type IS DISTINCT FROM 'event'
        OR opportunity.opportunity_type IS DISTINCT FROM 'WORK'
        OR opportunity.metadata->>'needReason' IS DISTINCT FROM 'storm_damage'
        OR opportunity.scene_id IS NULL
        OR opportunity.created_world_time IS DISTINCT FROM NEW.published_world_minute
        OR NEW.raw_sync_reward IS DISTINCT FROM 1000000
        OR NEW.budget_source IS DISTINCT FROM 'world_operating_pool'
        OR NEW.acceptance_criteria->>'type' IS DISTINCT FROM 'storm_cleanup'
        OR NEW.acceptance_criteria->>'sceneId' IS DISTINCT FROM opportunity.scene_id::text
        OR NEW.acceptance_criteria->>'location' IS DISTINCT FROM target.location
        OR target.id IS NULL OR target.opportunity_id IS DISTINCT FROM NEW.opportunity_id
        OR target.status IS DISTINCT FROM 'pending'
        OR NEW.acceptance_criteria->>'targetId' IS DISTINCT FROM NEW.target_id::text
        OR NEW.evidence_requirements->>'eventType' IS DISTINCT FROM 'world.action_completed'
        OR NEW.evidence_requirements->>'action' IS DISTINCT FROM 'work'
        OR NEW.evidence_requirements->>'targetId' IS DISTINCT FROM NEW.target_id::text
        OR NEW.status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'World work order requires a new protocol storm cleanup need and fixed prior terms';
    END IF;
  ELSE
    IF (NEW.world_id,NEW.opportunity_id,NEW.target_id,NEW.source_key,NEW.budget_source,NEW.raw_sync_reward,
        NEW.acceptance_criteria,NEW.evidence_requirements,NEW.published_world_minute,
        NEW.deadline_world_minute,NEW.created_at)
       IS DISTINCT FROM
       (OLD.world_id,OLD.opportunity_id,OLD.target_id,OLD.source_key,OLD.budget_source,OLD.raw_sync_reward,
        OLD.acceptance_criteria,OLD.evidence_requirements,OLD.published_world_minute,
        OLD.deadline_world_minute,OLD.created_at) THEN
      RAISE EXCEPTION 'World work order terms are immutable';
    END IF;
    IF NOT ((OLD.status='open' AND NEW.status IN ('accepted','cancelled','expired'))
        OR (OLD.status='accepted' AND NEW.status IN ('verified','failed','expired'))
        OR (OLD.status='verified' AND NEW.status='batched')) THEN
      RAISE EXCEPTION 'invalid World work order transition';
    END IF;
    IF OLD.accepted_agent_id IS NOT NULL AND (NEW.accepted_agent_id,NEW.accepted_world_minute,NEW.accepted_at)
        IS DISTINCT FROM (OLD.accepted_agent_id,OLD.accepted_world_minute,OLD.accepted_at) THEN
      RAISE EXCEPTION 'World work order acceptance is immutable';
    END IF;
    IF OLD.status='verified' AND (NEW.evidence_event_id,NEW.verified_world_minute,NEW.evidence)
        IS DISTINCT FROM (OLD.evidence_event_id,OLD.verified_world_minute,OLD.evidence) THEN
      RAISE EXCEPTION 'verified World work order evidence is immutable';
    END IF;
    IF NEW.status='accepted' THEN
      SELECT * INTO target FROM world_sync_cleanup_targets WHERE world_id=NEW.world_id AND id=NEW.target_id;
      IF target.status IS DISTINCT FROM 'pending'
          OR NEW.accepted_world_minute<NEW.published_world_minute
          OR NEW.accepted_world_minute>NEW.deadline_world_minute
          OR NOT EXISTS (SELECT 1 FROM world_opportunity_participants participant
            WHERE participant.world_id=NEW.world_id AND participant.opportunity_id=NEW.opportunity_id
              AND participant.agent_id=NEW.accepted_agent_id AND participant.status='accepted') THEN
        RAISE EXCEPTION 'World work order requires independent Agent acceptance before deadline';
      END IF;
    END IF;
    IF NEW.status='verified' THEN
      SELECT * INTO evidence_row FROM world_events WHERE id=NEW.evidence_event_id;
      SELECT * INTO target FROM world_sync_cleanup_targets WHERE world_id=NEW.world_id AND id=NEW.target_id;
      SELECT scene.name INTO scene_name FROM world_opportunities opportunity
        JOIN world_scenes scene ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
        WHERE opportunity.world_id=NEW.world_id AND opportunity.id=NEW.opportunity_id;
      IF NOT FOUND OR scene_name IS NULL OR target.status IS DISTINCT FROM 'cleared'
          OR target.cleared_by_agent_id IS DISTINCT FROM NEW.accepted_agent_id
          OR target.cleared_world_minute IS DISTINCT FROM NEW.verified_world_minute
          OR target.cleared_at IS NULL OR target.cleared_at<=NEW.accepted_at
          OR evidence_row.id IS NULL OR evidence_row.created_at<=NEW.accepted_at
          OR evidence_row.world_id IS DISTINCT FROM NEW.world_id
          OR evidence_row.actor_id IS DISTINCT FROM NEW.accepted_agent_id
          OR evidence_row.event_type IS DISTINCT FROM 'world.action_completed'
          OR evidence_row.data->>'action' IS DISTINCT FROM 'work'
          OR evidence_row.data->>'place' IS DISTINCT FROM scene_name
          OR evidence_row.data->'work'->>'output' IS DISTINCT FROM 'storm_debris_cleared'
          OR evidence_row.data->'work'->>'targetId' IS DISTINCT FROM NEW.target_id::text
          OR evidence_row.data->'work'->>'workOrderId' IS DISTINCT FROM NEW.id::text
          OR (evidence_row.data->>'worldMinutes')::bigint IS NULL
          OR (evidence_row.data->>'worldMinutes')::bigint<NEW.accepted_world_minute
          OR (evidence_row.data->>'worldMinutes')::bigint>NEW.deadline_world_minute
          OR NEW.verified_world_minute IS DISTINCT FROM (evidence_row.data->>'worldMinutes')::bigint THEN
        RAISE EXCEPTION 'World work order completion evidence is invalid';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_sync_work_order_validity BEFORE INSERT OR UPDATE ON world_sync_work_orders
  FOR EACH ROW EXECUTE FUNCTION validate_world_sync_work_order();

CREATE TABLE world_sync_work_order_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  action_id text NOT NULL CHECK (action_id ~ '^sync-work-order-batch:[0-9a-f-]{36}$'),
  agent_id uuid NOT NULL,
  recipient_address text NOT NULL CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw>0),
  world_minute bigint NOT NULL CHECK (world_minute>=0),
  status text NOT NULL CHECK (status='committed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(world_id,id), UNIQUE(world_id,action_id),
  FOREIGN KEY(world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE TABLE world_sync_work_order_batch_items (
  world_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  work_order_id uuid NOT NULL,
  PRIMARY KEY(world_id,work_order_id),
  FOREIGN KEY(world_id,batch_id) REFERENCES world_sync_work_order_batches(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(world_id,work_order_id) REFERENCES world_sync_work_orders(world_id,id) ON DELETE RESTRICT
);

ALTER TABLE arc_sync_ledger_transactions DROP CONSTRAINT arc_sync_ledger_transactions_source_action_fkey;

CREATE OR REPLACE FUNCTION enforce_arc_sync_committed_double_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_count integer;
  posting_sum numeric;
  payout arc_sync_payout_outbox%ROWTYPE;
  pool_debits integer;
  recipient_credits integer;
  current_balance numeric;
  batch world_sync_work_order_batches%ROWTYPE;
  item_count integer;
  total_items integer;
  item_sum numeric;
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
  IF NOT FOUND OR batch.agent_id<>payout.agent_id OR batch.amount_raw<>payout.amount_raw
      OR lower(batch.recipient_address)<>lower(payout.recipient_address) THEN
    RAISE EXCEPTION 'SYNC payout requires a committed World work order batch';
  END IF;
  SELECT count(*)::integer,COALESCE(sum(work_order.raw_sync_reward),0)
    INTO item_count,item_sum
    FROM world_sync_work_order_batch_items item JOIN world_sync_work_orders work_order
      ON work_order.world_id=item.world_id AND work_order.id=item.work_order_id
    JOIN world_sync_cleanup_targets target ON target.world_id=work_order.world_id
      AND target.id=work_order.target_id
    JOIN world_events evidence ON evidence.id=work_order.evidence_event_id
    WHERE item.world_id=NEW.world_id AND item.batch_id=batch.id
      AND work_order.status='batched' AND work_order.accepted_agent_id=batch.agent_id
      AND work_order.verified_world_minute IS NOT NULL
      AND target.status='cleared' AND target.cleared_by_agent_id=batch.agent_id
      AND target.cleared_world_minute=work_order.verified_world_minute
      AND target.cleared_at>work_order.accepted_at
      AND evidence.world_id=work_order.world_id AND evidence.actor_id=batch.agent_id
      AND evidence.event_type='world.action_completed' AND evidence.data->>'action'='work'
      AND evidence.data->'work'->>'targetId'=target.id::text
      AND evidence.data->'work'->>'workOrderId'=work_order.id::text
      AND evidence.created_at>work_order.accepted_at
      AND (evidence.data->>'worldMinutes')::bigint>=work_order.accepted_world_minute;
  SELECT count(*)::integer INTO total_items FROM world_sync_work_order_batch_items
    WHERE world_id=NEW.world_id AND batch_id=batch.id;
  IF item_count=0 OR item_count<>total_items OR item_sum<>batch.amount_raw THEN
    RAISE EXCEPTION 'SYNC batch lacks verified completed work order evidence';
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

GRANT SELECT,INSERT ON world_sync_cleanup_targets,world_sync_work_orders,
  world_sync_work_order_batches,world_sync_work_order_batch_items TO synterra_app;
GRANT UPDATE(status,cleared_world_minute,cleared_at,cleared_by_agent_id)
  ON world_sync_cleanup_targets TO synterra_app;
GRANT UPDATE(status,accepted_agent_id,accepted_world_minute,accepted_at,evidence_event_id,verified_world_minute,evidence,updated_at)
  ON world_sync_work_orders TO synterra_app;
