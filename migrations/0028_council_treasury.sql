-- MirrorTerra resident economic council, taxes and the Central Bank treasury (additive).
-- Internal ledger only: nothing here touches the chain, the Genesis reserve, the operating pool,
-- arc_sync_payout_outbox, ledger postings, or any payout/commit gate.
--  * world_sync_treasury_entries: append-only, balanced double entry between ONE resident and the
--    Central Bank treasury (resident -> treasury for taxes and sinks; treasury -> resident for
--    treasury-funded rewards and governor spending). A trigger keeps every payer >= 0 and caps the
--    governor's discretionary spending per world day.
--  * arc_sync_internal_balances is re-created with the same columns plus two appended columns, so a
--    resident's spendable balance includes treasury flows. Total internal SYNC (residents + treasury)
--    still equals the pending entitlements, which stay reserved against the pool and epoch quota.
--  * council tables: proposals, votes, active policies and policy history, with bounded levers
--    enforced by mirrorterra_council_value_valid() in CHECK constraints.
--  * ops-only veto/revert functions (EXECUTE revoked from PUBLIC; not granted to synterra_app).
--  * the 0027 commit gate is re-created to ALSO refuse agents with treasury entries (stricter only).

CREATE FUNCTION mirrorterra_council_value_valid(lever text, value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  n numeric;
BEGIN
  IF lever IS NULL OR value IS NULL OR jsonb_typeof(value) <> 'object' THEN RETURN false; END IF;
  IF lever IN ('tax.sales','tax.income','tax.wealth') THEN
    IF jsonb_typeof(value->'bps') <> 'number' THEN RETURN false; END IF;
    n := (value->>'bps')::numeric;
    RETURN n = trunc(n) AND n BETWEEN 0 AND 3000;
  ELSIF lever IN ('multiplier.research_project','multiplier.shared_project_cooperation',
      'multiplier.business_production','multiplier.skill_output') THEN
    IF jsonb_typeof(value->'milli') <> 'number' THEN RETURN false; END IF;
    n := (value->>'milli')::numeric;
    RETURN n = trunc(n) AND n BETWEEN 250 AND 3000;
  ELSIF lever IN ('price.food_service','price.social_service','price.trading_service',
      'price.research_service','price.engineering_service') THEN
    IF jsonb_typeof(value->'milli') <> 'number' THEN RETURN false; END IF;
    n := (value->>'milli')::numeric;
    RETURN n = trunc(n) AND n BETWEEN 500 AND 2000;
  ELSIF lever IN ('good.house_upgrade','good.tools','good.tuition','good.land_rent') THEN
    IF value ? 'offered' AND value->'offered' = 'false'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(value->'priceRaw') <> 'string' OR (value->>'priceRaw') !~ '^[1-9][0-9]{0,12}$' THEN RETURN false; END IF;
    n := (value->>'priceRaw')::numeric;
    RETURN n BETWEEN 100000 AND 20000000;
  ELSIF lever = 'treasury.guidance' THEN
    RETURN value->>'mode' IN ('balanced','bounties_first','subsidies_first','public_works','save');
  END IF;
  RETURN false;
END $$;

-- Balanced double entry between one resident and the treasury. NULL side = the treasury.
CREATE TABLE world_sync_treasury_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  entry_key text NOT NULL CHECK (char_length(entry_key) BETWEEN 8 AND 200),
  kind text NOT NULL CHECK (kind IN ('sales_tax','income_tax','wealth_tax','reward_adjustment','goods_purchase',
    'land_rent','reward','reward_bonus','bounty','subsidy','grant','public_works','service_purchase')),
  from_agent_id uuid,
  to_agent_id uuid,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  actor text NOT NULL CHECK (actor IN ('tax_collector','reward_issuance','governor_cognition','governor_fallback',
    'market','council')),
  source_ref text CHECK (source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 200),
  world_day bigint NOT NULL CHECK (world_day >= 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((from_agent_id IS NULL) <> (to_agent_id IS NULL)),
  CHECK ((kind IN ('sales_tax','income_tax','wealth_tax','reward_adjustment','goods_purchase','land_rent'))
    = (from_agent_id IS NOT NULL)),
  UNIQUE (world_id,entry_key),
  FOREIGN KEY (world_id,from_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,to_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_sync_treasury_entries_from_idx ON world_sync_treasury_entries(world_id,from_agent_id)
  WHERE from_agent_id IS NOT NULL;
CREATE INDEX world_sync_treasury_entries_to_idx ON world_sync_treasury_entries(world_id,to_agent_id)
  WHERE to_agent_id IS NOT NULL;
CREATE INDEX world_sync_treasury_entries_day_idx ON world_sync_treasury_entries(world_id,world_day,kind);
CREATE INDEX world_sync_treasury_entries_recent_idx ON world_sync_treasury_entries(world_id,created_at DESC);

CREATE VIEW world_sync_treasury_balances AS
SELECT entry.world_id,
  COALESCE(sum(entry.amount_raw) FILTER (WHERE entry.from_agent_id IS NOT NULL),0)::numeric(78,0) AS in_raw,
  COALESCE(sum(entry.amount_raw) FILTER (WHERE entry.to_agent_id IS NOT NULL),0)::numeric(78,0) AS out_raw,
  (COALESCE(sum(entry.amount_raw) FILTER (WHERE entry.from_agent_id IS NOT NULL),0)
    - COALESCE(sum(entry.amount_raw) FILTER (WHERE entry.to_agent_id IS NOT NULL),0))::numeric(78,0) AS balance_raw
FROM world_sync_treasury_entries entry GROUP BY entry.world_id;

-- Same columns in the same order as 0027 (old code keeps working); two columns appended.
CREATE OR REPLACE VIEW arc_sync_internal_balances AS
SELECT member.world_id,member.agent_id,
  COALESCE(earned.amount_raw,0)::numeric(78,0) AS earned_raw,
  COALESCE(received.amount_raw,0)::numeric(78,0) AS received_raw,
  COALESCE(sent.amount_raw,0)::numeric(78,0) AS sent_raw,
  (COALESCE(earned.amount_raw,0)+COALESCE(received.amount_raw,0)-COALESCE(sent.amount_raw,0)
    +COALESCE(treasury_in.amount_raw,0)-COALESCE(treasury_out.amount_raw,0))::numeric(78,0) AS spendable_raw,
  COALESCE(treasury_in.amount_raw,0)::numeric(78,0) AS treasury_received_raw,
  COALESCE(treasury_out.amount_raw,0)::numeric(78,0) AS treasury_paid_raw
FROM world_members member
LEFT JOIN LATERAL (SELECT sum(entitlement.sync_amount_raw) AS amount_raw
  FROM arc_sync_resident_reward_entitlements entitlement
  WHERE entitlement.world_id=member.world_id AND entitlement.agent_id=member.agent_id
    AND entitlement.status='pending') earned ON true
LEFT JOIN LATERAL (SELECT sum(transfer.amount_raw) AS amount_raw FROM arc_sync_internal_transfers transfer
  WHERE transfer.world_id=member.world_id AND transfer.to_agent_id=member.agent_id) received ON true
LEFT JOIN LATERAL (SELECT sum(transfer.amount_raw) AS amount_raw FROM arc_sync_internal_transfers transfer
  WHERE transfer.world_id=member.world_id AND transfer.from_agent_id=member.agent_id) sent ON true
LEFT JOIN LATERAL (SELECT sum(entry.amount_raw) AS amount_raw FROM world_sync_treasury_entries entry
  WHERE entry.world_id=member.world_id AND entry.to_agent_id=member.agent_id) treasury_in ON true
LEFT JOIN LATERAL (SELECT sum(entry.amount_raw) AS amount_raw FROM world_sync_treasury_entries entry
  WHERE entry.world_id=member.world_id AND entry.from_agent_id=member.agent_id) treasury_out ON true;

CREATE FUNCTION validate_world_sync_treasury_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  available numeric;
  spent_today numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYNC treasury entries are append-only'; END IF;
  IF NEW.from_agent_id IS NOT NULL THEN
    -- Same lock key as resident-to-resident transfers, so a tax can never race a purchase below zero.
    PERFORM pg_advisory_xact_lock(hashtextextended('sync-internal:' || NEW.world_id::text || ':' || NEW.from_agent_id::text,0));
    SELECT balance.spendable_raw INTO available FROM arc_sync_internal_balances balance
      WHERE balance.world_id=NEW.world_id AND balance.agent_id=NEW.from_agent_id;
    IF available IS NULL OR available < NEW.amount_raw THEN
      RAISE EXCEPTION 'SYNC treasury entry exceeds the resident balance';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('sync-treasury:' || NEW.world_id::text,0));
    SELECT COALESCE(sum(CASE WHEN entry.from_agent_id IS NOT NULL THEN entry.amount_raw ELSE -entry.amount_raw END),0)
      INTO available FROM world_sync_treasury_entries entry WHERE entry.world_id=NEW.world_id;
    IF available < NEW.amount_raw THEN
      RAISE EXCEPTION 'SYNC treasury entry exceeds the treasury balance';
    END IF;
    IF NEW.kind IN ('bounty','subsidy','grant','public_works','service_purchase') THEN
      SELECT COALESCE(sum(entry.amount_raw),0) INTO spent_today FROM world_sync_treasury_entries entry
        WHERE entry.world_id=NEW.world_id AND entry.world_day=NEW.world_day
          AND entry.kind IN ('bounty','subsidy','grant','public_works','service_purchase');
      -- Hard ceiling (50 SYNC per world day); the application enforces a lower one.
      IF spent_today + NEW.amount_raw > 50000000 THEN
        RAISE EXCEPTION 'SYNC treasury discretionary spending exceeds the daily ceiling';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_sync_treasury_entry_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_sync_treasury_entries
  FOR EACH ROW EXECUTE FUNCTION validate_world_sync_treasury_entry();

-- Bounties posted by the governor; paid (as a 'bounty' treasury entry) only when claimed.
CREATE TABLE world_treasury_bounties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  drive text NOT NULL CHECK (drive IN ('survival','security','belonging','esteem','curiosity','creation','mastery','contribution')),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0 AND amount_raw <= 5000000),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  posted_by text NOT NULL CHECK (posted_by IN ('governor_cognition','governor_fallback')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','expired')),
  posted_world_day bigint NOT NULL CHECK (posted_world_day >= 0),
  posted_world_minute bigint NOT NULL CHECK (posted_world_minute >= 0),
  expires_world_minute bigint NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  claimed_by_agent_id uuid,
  claimed_world_minute bigint,
  claim_output_id bigint,
  UNIQUE (world_id,drive,posted_world_day),
  CHECK (expires_world_minute > posted_world_minute),
  CHECK ((status='claimed') = (claimed_by_agent_id IS NOT NULL)),
  FOREIGN KEY (world_id,claimed_by_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_treasury_bounties_open_idx ON world_treasury_bounties(world_id,status,drive);

CREATE TABLE world_council_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  proposer_agent_id uuid NOT NULL,
  lever_key text NOT NULL,
  proposed_value jsonb NOT NULL,
  previous_value jsonb NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 160),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  source text NOT NULL CHECK (source IN ('cognition','session_fallback')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','passed','rejected','vetoed')),
  opened_world_day bigint NOT NULL CHECK (opened_world_day >= 0),
  opened_world_minute bigint NOT NULL CHECK (opened_world_minute >= 0),
  closes_world_minute bigint NOT NULL,
  yes_count integer NOT NULL DEFAULT 0 CHECK (yes_count >= 0),
  no_count integer NOT NULL DEFAULT 0 CHECK (no_count >= 0),
  decided_world_minute bigint,
  effective_world_day bigint,
  decision_reason text CHECK (decision_reason IS NULL OR char_length(decision_reason) BETWEEN 3 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mirrorterra_council_value_valid(lever_key,proposed_value)),
  CHECK (mirrorterra_council_value_valid(lever_key,previous_value)),
  CHECK (closes_world_minute > opened_world_minute),
  CHECK ((status='open') = (decided_world_minute IS NULL)),
  UNIQUE (world_id,id),
  FOREIGN KEY (world_id,proposer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
-- At most one open proposal per lever.
CREATE UNIQUE INDEX world_council_proposals_open_lever_key ON world_council_proposals(world_id,lever_key)
  WHERE status='open';
CREATE INDEX world_council_proposals_recent_idx ON world_council_proposals(world_id,opened_world_minute DESC);

CREATE FUNCTION validate_world_council_proposal_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Council proposals are never deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.proposer_agent_id<>OLD.proposer_agent_id
      OR NEW.lever_key<>OLD.lever_key OR NEW.proposed_value<>OLD.proposed_value
      OR NEW.previous_value<>OLD.previous_value OR NEW.title<>OLD.title OR NEW.reason<>OLD.reason
      OR NEW.source<>OLD.source OR NEW.opened_world_day<>OLD.opened_world_day
      OR NEW.opened_world_minute<>OLD.opened_world_minute OR NEW.closes_world_minute<>OLD.closes_world_minute
      OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Council proposal terms are immutable';
  END IF;
  IF NOT ((OLD.status='open' AND NEW.status IN ('open','passed','rejected','vetoed'))
      OR (OLD.status='passed' AND NEW.status IN ('passed','vetoed'))
      OR (OLD.status=NEW.status)) THEN
    RAISE EXCEPTION 'Council proposal status transition % -> % is not allowed', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_council_proposal_update_check
  BEFORE UPDATE OR DELETE ON world_council_proposals
  FOR EACH ROW EXECUTE FUNCTION validate_world_council_proposal_update();

CREATE TABLE world_council_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  stance text NOT NULL CHECK (stance IN ('yes','no')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  source text NOT NULL CHECK (source IN ('cognition','session_fallback')),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,proposal_id,agent_id),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_council_proposals(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE FUNCTION validate_world_council_vote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal world_council_proposals%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Council votes are append-only'; END IF;
  SELECT * INTO proposal FROM world_council_proposals WHERE world_id=NEW.world_id AND id=NEW.proposal_id FOR UPDATE;
  IF proposal.id IS NULL OR proposal.status<>'open' THEN
    RAISE EXCEPTION 'Council votes require an open proposal';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_council_vote_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_council_votes
  FOR EACH ROW EXECUTE FUNCTION validate_world_council_vote();

-- Current value per lever. value applies from effective_world_day; before that previous_value applies.
CREATE TABLE world_council_policies (
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  lever_key text NOT NULL,
  value jsonb NOT NULL,
  previous_value jsonb NOT NULL,
  effective_world_day bigint NOT NULL CHECK (effective_world_day >= 0),
  proposal_id uuid,
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,lever_key),
  CHECK (mirrorterra_council_value_valid(lever_key,value)),
  CHECK (mirrorterra_council_value_valid(lever_key,previous_value)),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_council_proposals(world_id,id) ON DELETE RESTRICT
);

CREATE TABLE world_council_policy_history (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  lever_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('enacted','vetoed','reverted')),
  old_value jsonb NOT NULL,
  new_value jsonb NOT NULL,
  proposal_id uuid,
  effective_world_day bigint NOT NULL CHECK (effective_world_day >= 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  actor text NOT NULL CHECK (actor IN ('council','ops')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mirrorterra_council_value_valid(lever_key,old_value)),
  CHECK (mirrorterra_council_value_valid(lever_key,new_value)),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_council_proposals(world_id,id) ON DELETE RESTRICT
);
-- At most one council change per lever per world day.
CREATE UNIQUE INDEX world_council_policy_history_one_change_key
  ON world_council_policy_history(world_id,lever_key,effective_world_day) WHERE action='enacted';
CREATE TRIGGER world_council_policy_history_immutable
  BEFORE UPDATE OR DELETE ON world_council_policy_history
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

-- Tax collection cursors (one row per world). Income tax covers entitlements accrued after
-- income_cursor; sales tax covers internal orders after sales_cursor. Both advance monotonically.
CREATE TABLE world_council_runtime (
  world_id uuid PRIMARY KEY REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  income_cursor timestamptz NOT NULL,
  sales_cursor timestamptz NOT NULL,
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Default (pre-council) value of a lever; used by the ops revert.
CREATE FUNCTION mirrorterra_council_default_value(lever text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lever LIKE 'tax.%' THEN '{"bps":0}'::jsonb
    WHEN lever LIKE 'multiplier.%' OR lever LIKE 'price.%' THEN '{"milli":1000}'::jsonb
    WHEN lever LIKE 'good.%' THEN '{"offered":false}'::jsonb
    WHEN lever = 'treasury.guidance' THEN '{"mode":"balanced"}'::jsonb
  END
$$;

-- Ops-only user veto. Rejects an open proposal, or vetoes a passed one and restores the value it replaced.
CREATE FUNCTION mirrorterra_council_ops_veto(p_proposal_id uuid, p_reason text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  proposal world_council_proposals%ROWTYPE;
  policy world_council_policies%ROWTYPE;
  clock bigint;
BEGIN
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 3 AND 240 THEN RAISE EXCEPTION 'reason (3-240 chars) required'; END IF;
  SELECT * INTO proposal FROM world_council_proposals WHERE id=p_proposal_id FOR UPDATE;
  IF proposal.id IS NULL THEN RAISE EXCEPTION 'proposal not found'; END IF;
  SELECT world_minutes INTO clock FROM world_runtime_state WHERE world_id=proposal.world_id;
  clock := COALESCE(clock,proposal.opened_world_minute);
  IF proposal.status='open' THEN
    UPDATE world_council_proposals SET status='vetoed',decided_world_minute=clock,
      decision_reason=left('Vetoed by the operator: ' || p_reason,240),updated_at=now() WHERE id=proposal.id;
    RETURN 'vetoed_open';
  ELSIF proposal.status='passed' THEN
    UPDATE world_council_proposals SET status='vetoed',
      decision_reason=left('Vetoed by the operator: ' || p_reason,240),updated_at=now() WHERE id=proposal.id;
    SELECT * INTO policy FROM world_council_policies
      WHERE world_id=proposal.world_id AND lever_key=proposal.lever_key FOR UPDATE;
    IF policy.proposal_id=proposal.id THEN
      UPDATE world_council_policies SET value=proposal.previous_value,previous_value=proposal.previous_value,
        effective_world_day=0,proposal_id=NULL,updated_world_minute=clock,updated_at=now()
      WHERE world_id=proposal.world_id AND lever_key=proposal.lever_key;
    END IF;
    INSERT INTO world_council_policy_history(world_id,lever_key,action,old_value,new_value,proposal_id,
        effective_world_day,world_minute,actor,reason)
      VALUES(proposal.world_id,proposal.lever_key,'vetoed',proposal.proposed_value,proposal.previous_value,proposal.id,
        GREATEST(0,floor(clock/1440.0)::bigint),clock,'ops',left(p_reason,240));
    RETURN 'vetoed_passed';
  END IF;
  RETURN 'unchanged_' || proposal.status;
END $$;

-- Ops-only revert of one lever to its pre-council default, effective immediately.
CREATE FUNCTION mirrorterra_council_ops_revert(p_world_id uuid, p_lever text, p_reason text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  policy world_council_policies%ROWTYPE;
  default_value jsonb := mirrorterra_council_default_value(p_lever);
  clock bigint;
BEGIN
  IF default_value IS NULL THEN RAISE EXCEPTION 'unknown lever %', p_lever; END IF;
  IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 3 AND 240 THEN RAISE EXCEPTION 'reason (3-240 chars) required'; END IF;
  SELECT world_minutes INTO clock FROM world_runtime_state WHERE world_id=p_world_id;
  clock := COALESCE(clock,0);
  SELECT * INTO policy FROM world_council_policies WHERE world_id=p_world_id AND lever_key=p_lever FOR UPDATE;
  IF policy.world_id IS NULL THEN RETURN 'already_default'; END IF;
  UPDATE world_council_policies SET value=default_value,previous_value=default_value,effective_world_day=0,
    proposal_id=NULL,updated_world_minute=clock,updated_at=now()
  WHERE world_id=p_world_id AND lever_key=p_lever;
  INSERT INTO world_council_policy_history(world_id,lever_key,action,old_value,new_value,proposal_id,
      effective_world_day,world_minute,actor,reason)
    VALUES(p_world_id,p_lever,'reverted',policy.value,default_value,policy.proposal_id,
      GREATEST(0,floor(clock/1440.0)::bigint),clock,'ops',left(p_reason,240));
  RETURN 'reverted';
END $$;
REVOKE ALL ON FUNCTION mirrorterra_council_ops_veto(uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION mirrorterra_council_ops_revert(uuid,text,text) FROM PUBLIC;

-- Stricter commit gate: also refuse a gross-entitlement batch for an agent with treasury entries.
CREATE OR REPLACE FUNCTION enforce_arc_sync_resident_reward_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('mirrorterra.sync_resident_reward_commit', true), '') <> 'enabled' THEN
    RAISE EXCEPTION 'SYNC resident reward commit is disabled; internal SYNC stays pending until conversion';
  END IF;
  IF EXISTS (SELECT 1 FROM arc_sync_internal_transfers transfer WHERE transfer.world_id=NEW.world_id
      AND (transfer.from_agent_id=NEW.agent_id OR transfer.to_agent_id=NEW.agent_id)) THEN
    RAISE EXCEPTION 'SYNC resident reward batch cannot pay gross entitlements for an agent with internal transfers';
  END IF;
  IF EXISTS (SELECT 1 FROM world_sync_treasury_entries entry WHERE entry.world_id=NEW.world_id
      AND (entry.from_agent_id=NEW.agent_id OR entry.to_agent_id=NEW.agent_id)) THEN
    RAISE EXCEPTION 'SYNC resident reward batch cannot pay gross entitlements for an agent with treasury entries';
  END IF;
  RETURN NEW;
END $$;

GRANT SELECT,INSERT ON world_sync_treasury_entries TO synterra_app;
GRANT SELECT ON world_sync_treasury_balances TO synterra_app;
GRANT SELECT,INSERT ON world_treasury_bounties TO synterra_app;
GRANT UPDATE (status,claimed_by_agent_id,claimed_world_minute,claim_output_id) ON world_treasury_bounties TO synterra_app;
GRANT SELECT,INSERT ON world_council_proposals TO synterra_app;
GRANT UPDATE (status,yes_count,no_count,decided_world_minute,effective_world_day,decision_reason,updated_at)
  ON world_council_proposals TO synterra_app;
GRANT SELECT,INSERT ON world_council_votes TO synterra_app;
GRANT SELECT,INSERT ON world_council_policies TO synterra_app;
GRANT UPDATE (value,previous_value,effective_world_day,proposal_id,updated_world_minute,updated_at)
  ON world_council_policies TO synterra_app;
GRANT SELECT,INSERT ON world_council_policy_history TO synterra_app;
GRANT USAGE ON SEQUENCE world_council_policy_history_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_council_runtime TO synterra_app;
GRANT UPDATE (income_cursor,sales_cursor,updated_world_minute,updated_at) ON world_council_runtime TO synterra_app;
