-- external2 is an overlay on island1 + research1. Historical migrations are untouched.
-- Owner-only policy/operator registration; application role can only read them.
CREATE TABLE world_external2_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  byom boolean NOT NULL DEFAULT false,
  operator_binding boolean NOT NULL DEFAULT false,
  public_work_rewards boolean NOT NULL DEFAULT false,
  research_rewards boolean NOT NULL DEFAULT false,
  verification_rewards boolean NOT NULL DEFAULT false,
  probation boolean NOT NULL DEFAULT false,
  withdrawals boolean NOT NULL DEFAULT false,
  probation_real_days integer NOT NULL DEFAULT 3 CHECK (probation_real_days BETWEEN 1 AND 3650),
  probation_acceptances integer NOT NULL DEFAULT 3 CHECK (probation_acceptances BETWEEN 1 AND 100000),
  CHECK (NOT (public_work_rewards OR research_rewards OR verification_rewards OR withdrawals)
    OR (operator_binding AND probation))
);
INSERT INTO world_external2_policy(singleton) VALUES(true);

CREATE TABLE world_external_operators (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 2 AND 120),
  public_key text UNIQUE,
  independent boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  registered_at timestamptz NOT NULL DEFAULT now(),
  CHECK (public_key IS NOT NULL OR id='00000000-0000-4000-8000-000000000001')
);
INSERT INTO world_external_operators(id,name,independent) VALUES
  ('00000000-0000-4000-8000-000000000001','MirrorTerra platform',true);

CREATE TABLE world_external_operator_bindings (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  operator_id uuid NOT NULL REFERENCES world_external_operators(id) ON DELETE RESTRICT,
  claim_digest text NOT NULL CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
  operator_signature text,
  non_independent boolean NOT NULL DEFAULT false,
  bound_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,agent_id),
  UNIQUE (claim_digest),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_residents(world_id,agent_id) ON DELETE RESTRICT,
  CHECK (((operator_id='00000000-0000-4000-8000-000000000001' AND non_independent)
    OR (operator_id<>'00000000-0000-4000-8000-000000000001' AND operator_signature ~ '^[A-Za-z0-9_-]{86}$')) IS TRUE),
  CHECK (agent_id<>'c0c95ab1-e08c-4e06-bc99-f188730089e5'
    OR (operator_id='00000000-0000-4000-8000-000000000001' AND non_independent))
);
CREATE TRIGGER world_external_operator_binding_immutable BEFORE UPDATE OR DELETE ON world_external_operator_bindings
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();
INSERT INTO world_external_operator_bindings(world_id,agent_id,operator_id,claim_digest,non_independent)
SELECT world_id,agent_id,'00000000-0000-4000-8000-000000000001',
  encode(sha256(('external2-platform-visitor:'||world_id::text||':'||agent_id::text)::bytea),'hex'),true
FROM world_external_residents WHERE agent_id='c0c95ab1-e08c-4e06-bc99-f188730089e5';

CREATE FUNCTION mirrorterra_external_operator(p_world uuid,p_agent uuid)
RETURNS TABLE(operator_id uuid,independent boolean) LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN e.agent_id IS NULL THEN '00000000-0000-4000-8000-000000000001'::uuid ELSE b.operator_id END,
    CASE WHEN e.agent_id IS NULL THEN true ELSE COALESCE(o.active AND o.independent AND NOT b.non_independent,false) END
  FROM world_members m LEFT JOIN world_external_residents e ON e.world_id=m.world_id AND e.agent_id=m.agent_id
  LEFT JOIN world_external_operator_bindings b ON b.world_id=m.world_id AND b.agent_id=m.agent_id
  LEFT JOIN world_external_operators o ON o.id=b.operator_id WHERE m.world_id=p_world AND m.agent_id=p_agent
$$;
CREATE FUNCTION mirrorterra_external_independent_pair(p_world uuid,p_left uuid,p_right uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT l.independent AND r.independent AND l.operator_id<>r.operator_id
    FROM mirrorterra_external_operator(p_world,p_left) l CROSS JOIN mirrorterra_external_operator(p_world,p_right) r),false)
$$;

-- Holds are durable facts. Turning a feature off never erases a freeze or re-freezes released money.
CREATE TABLE world_external_reward_holds (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  real_days integer NOT NULL CHECK (real_days BETWEEN 1 AND 3650),
  required_acceptances integer NOT NULL CHECK (required_acceptances BETWEEN 1 AND 100000),
  released_at timestamptz,
  PRIMARY KEY (world_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_residents(world_id,agent_id) ON DELETE RESTRICT
);
CREATE FUNCTION validate_external_reward_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (NEW.world_id,NEW.agent_id,NEW.started_at,NEW.real_days,NEW.required_acceptances)
    IS DISTINCT FROM (OLD.world_id,OLD.agent_id,OLD.started_at,OLD.real_days,OLD.required_acceptances)
    OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
    OR NOT mirrorterra_external_probation_complete(OLD.world_id,OLD.agent_id) THEN
    RAISE EXCEPTION 'External probation facts are immutable; release only once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_reward_hold_check BEFORE UPDATE OR DELETE ON world_external_reward_holds
  FOR EACH ROW EXECUTE FUNCTION validate_external_reward_hold();

CREATE TABLE world_external_contribution_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('public_work','research','verification')),
  source_ref text NOT NULL CHECK (char_length(source_ref) BETWEEN 1 AND 100),
  entitlement_id uuid UNIQUE REFERENCES arc_sync_resident_reward_entitlements(id) ON DELETE RESTRICT,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,kind,source_ref),
  UNIQUE (world_id,id),
  CHECK ((kind='public_work')=(entitlement_id IS NULL)),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_operator_bindings(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_external_receipts_agent_idx ON world_external_contribution_receipts(world_id,agent_id);
CREATE TRIGGER world_external_contribution_receipt_immutable BEFORE UPDATE OR DELETE ON world_external_contribution_receipts
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE TABLE world_external_contribution_acceptances (
  world_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  acceptor_agent_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,receipt_id),
  UNIQUE (world_id,acceptor_agent_id,action_id),
  FOREIGN KEY (world_id,receipt_id) REFERENCES world_external_contribution_receipts(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,acceptor_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE TRIGGER world_external_contribution_acceptance_immutable BEFORE UPDATE OR DELETE ON world_external_contribution_acceptances
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE FUNCTION mirrorterra_external_probation_complete(p_world uuid,p_agent uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT released_at IS NOT NULL OR now()>=started_at+real_days*interval '24 hours'
    OR (SELECT count(*) FROM world_external_contribution_acceptances a
      JOIN world_external_contribution_receipts r ON r.world_id=a.world_id AND r.id=a.receipt_id
      WHERE r.world_id=h.world_id AND r.agent_id=h.agent_id)>=required_acceptances
    FROM world_external_reward_holds h WHERE h.world_id=p_world AND h.agent_id=p_agent),false)
$$;

CREATE FUNCTION mirrorterra_external_frozen_raw(p_world uuid,p_agent uuid)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN mirrorterra_external_probation_complete(p_world,p_agent) THEN 0::numeric
    ELSE COALESCE((SELECT sum(sync_amount_raw) FROM arc_sync_resident_reward_entitlements
      WHERE world_id=p_world AND agent_id=p_agent AND status='pending'),0)
      +COALESCE((SELECT sum(amount_raw) FROM world_sync_treasury_entries
      WHERE world_id=p_world AND to_agent_id=p_agent),0) END
$$;

-- Dedicated conversion journal. These accounts cannot represent Reserve/Operating Pool grants.
-- An existing resident claim is converted once into a wallet payable + infrastructure fee.
CREATE TABLE world_external_withdrawal_wallets (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  claim_digest text NOT NULL UNIQUE CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,agent_id),
  UNIQUE (wallet_address),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_operator_bindings(world_id,agent_id) ON DELETE RESTRICT
);
CREATE TRIGGER world_external_withdrawal_wallet_immutable BEFORE UPDATE OR DELETE ON world_external_withdrawal_wallets
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE TABLE world_external_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  gross_raw numeric(78,0) NOT NULL CHECK (gross_raw>0 AND gross_raw<2::numeric^256),
  net_raw numeric(78,0) NOT NULL CHECK (net_raw>0),
  fee_raw numeric(78,0) NOT NULL CHECK (fee_raw>0),
  status text NOT NULL DEFAULT 'committed' CHECK (status='committed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  UNIQUE (world_id,agent_id,action_id),
  CHECK (fee_raw=floor(gross_raw*3/100) AND net_raw+fee_raw=gross_raw),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_withdrawal_wallets(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_external_withdrawals_agent_idx ON world_external_withdrawals(world_id,agent_id);
CREATE TRIGGER world_external_withdrawal_immutable BEFORE UPDATE OR DELETE ON world_external_withdrawals
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE TABLE world_external_payout_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  withdrawal_id uuid NOT NULL,
  payout_id text NOT NULL UNIQUE CHECK (payout_id ~ '^0x[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('resident','infrastructure_fee')),
  chain_id integer NOT NULL DEFAULT 5042 CHECK (chain_id=5042),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-fA-F]{40}$'),
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw>0 AND amount_raw<2::numeric^256),
  status text NOT NULL DEFAULT 'committed' CHECK (status='committed'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  UNIQUE (world_id,withdrawal_id,kind),
  FOREIGN KEY (world_id,withdrawal_id) REFERENCES world_external_withdrawals(world_id,id) ON DELETE RESTRICT,
  CONSTRAINT external2_infrastructure_recipient_locked CHECK (kind<>'infrastructure_fee'
    OR lower(recipient)='0x37428832cc1546aea4bc72948d739b08677d7739')
);
CREATE TRIGGER world_external_payout_outbox_immutable BEFORE UPDATE OR DELETE ON world_external_payout_outbox
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE TABLE world_external_ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('resident_claim','external_wallet_payable','infrastructure_treasury')),
  account_key text NOT NULL,
  agent_id uuid,
  wallet_address text,
  opening_balance_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (opening_balance_raw=0),
  UNIQUE (world_id,id),
  UNIQUE (world_id,account_key),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_residents(world_id,agent_id) ON DELETE RESTRICT,
  CHECK (((kind='resident_claim' AND agent_id IS NOT NULL AND wallet_address IS NULL AND account_key='resident:'||agent_id::text)
    OR (kind='external_wallet_payable' AND agent_id IS NOT NULL AND wallet_address ~ '^0x[0-9a-f]{40}$'
      AND account_key='wallet:'||agent_id::text)
    OR (kind='infrastructure_treasury' AND agent_id IS NULL AND account_key='infrastructure-treasury'
      AND lower(wallet_address)='0x37428832cc1546aea4bc72948d739b08677d7739')) IS TRUE)
);
CREATE TRIGGER world_external_ledger_account_immutable BEFORE UPDATE OR DELETE ON world_external_ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE TABLE world_external_ledger_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  outbox_id uuid NOT NULL,
  account_id uuid NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw<>0 AND abs(amount_raw)<2::numeric^256),
  UNIQUE (world_id,outbox_id,account_id),
  FOREIGN KEY (world_id,outbox_id) REFERENCES world_external_payout_outbox(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,account_id) REFERENCES world_external_ledger_accounts(world_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER world_external_ledger_posting_immutable BEFORE UPDATE OR DELETE ON world_external_ledger_postings
  FOR EACH ROW EXECUTE FUNCTION prevent_arc_sync_append_only_rewrite();

CREATE FUNCTION validate_external_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE available numeric; frozen numeric; bound_wallet text; converted numeric; pool_balance numeric; chain_balance numeric; legacy_outbox numeric; purchased numeric;
BEGIN
  IF NOT (SELECT withdrawals FROM world_external2_policy WHERE singleton) THEN RAISE EXCEPTION 'EXTERNAL_WITHDRAWALS_CLOSED'; END IF;
  PERFORM agent_id FROM world_members WHERE world_id=NEW.world_id AND agent_id=NEW.agent_id FOR KEY SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('sync-internal:'||NEW.world_id::text||':'||NEW.agent_id::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('external-withdrawals:'||NEW.world_id::text,0));
  IF NOT COALESCE((SELECT independent FROM mirrorterra_external_operator(NEW.world_id,NEW.agent_id)),false) THEN
    RAISE EXCEPTION 'EXTERNAL_INDEPENDENT_OPERATOR_REQUIRED';
  END IF;
  SELECT wallet_address INTO bound_wallet FROM world_external_withdrawal_wallets WHERE world_id=NEW.world_id AND agent_id=NEW.agent_id;
  IF bound_wallet IS DISTINCT FROM NEW.wallet_address THEN RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_WALLET_MISMATCH'; END IF;
  SELECT spendable_raw INTO available FROM arc_sync_internal_balances WHERE world_id=NEW.world_id AND agent_id=NEW.agent_id;
  frozen:=LEAST(GREATEST(COALESCE(available,0),0),mirrorterra_external_frozen_raw(NEW.world_id,NEW.agent_id));
  IF available IS NULL OR available-frozen<NEW.gross_raw THEN RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_BALANCE_FROZEN_OR_INSUFFICIENT'; END IF;
  SELECT COALESCE(sum(gross_raw),0) INTO converted FROM world_external_withdrawals WHERE world_id=NEW.world_id;
  SELECT a.opening_balance_raw+COALESCE(sum(p.amount_raw),0) INTO pool_balance FROM arc_sync_ledger_accounts a
    LEFT JOIN arc_sync_ledger_postings p ON p.world_id=a.world_id AND p.account_id=a.id
    WHERE a.world_id=NEW.world_id AND a.account_type='operating_pool' AND a.account_key='operating-pool' GROUP BY a.id;
  SELECT onchain_pool_balance_raw INTO chain_balance FROM arc_sync_reward_capacity_snapshots WHERE world_id=NEW.world_id
    ORDER BY observed_at DESC,id DESC LIMIT 1;
  SELECT COALESCE(sum(amount_raw),0) INTO legacy_outbox FROM arc_sync_payout_outbox WHERE world_id=NEW.world_id AND status<>'reconciled';
  SELECT COALESCE(sum(sync_amount_raw),0) INTO purchased FROM world_sync_purchases WHERE world_id=NEW.world_id;
  IF pool_balance IS NULL OR chain_balance IS NULL OR converted+NEW.gross_raw>LEAST(pool_balance+purchased,chain_balance-legacy_outbox) THEN
    RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_POOL_BACKING_INSUFFICIENT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_withdrawal_check BEFORE INSERT ON world_external_withdrawals
  FOR EACH ROW EXECUTE FUNCTION validate_external_withdrawal();

CREATE FUNCTION validate_external_payout_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w world_external_withdrawals%ROWTYPE; expected_id text;
BEGIN
  SELECT * INTO w FROM world_external_withdrawals WHERE world_id=NEW.world_id AND id=NEW.withdrawal_id;
  expected_id:='0x'||encode(sha256(('mirrorterra-external2:'||NEW.withdrawal_id::text||':'||NEW.kind)::bytea),'hex');
  IF w.id IS NULL OR NEW.payout_id<>expected_id
    OR (NEW.kind='resident' AND (lower(NEW.recipient)<>w.wallet_address OR NEW.amount_raw<>w.net_raw))
    OR (NEW.kind='infrastructure_fee' AND (lower(NEW.recipient)<>'0x37428832cc1546aea4bc72948d739b08677d7739' OR NEW.amount_raw<>w.fee_raw)) THEN
    RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_PAYOUT_MISMATCH';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_payout_outbox_check BEFORE INSERT ON world_external_payout_outbox
  FOR EACH ROW EXECUTE FUNCTION validate_external_payout_outbox();

CREATE FUNCTION validate_external_ledger_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o world_external_payout_outbox%ROWTYPE; a world_external_ledger_accounts%ROWTYPE; resident uuid;
BEGIN
  SELECT * INTO o FROM world_external_payout_outbox WHERE world_id=NEW.world_id AND id=NEW.outbox_id;
  SELECT * INTO a FROM world_external_ledger_accounts WHERE world_id=NEW.world_id AND id=NEW.account_id;
  SELECT agent_id INTO resident FROM world_external_withdrawals WHERE world_id=NEW.world_id AND id=o.withdrawal_id;
  IF o.id IS NULL OR a.id IS NULL OR NOT COALESCE((
    (a.kind='resident_claim' AND a.agent_id=resident AND NEW.amount_raw=-o.amount_raw)
    OR (o.kind='resident' AND a.kind='external_wallet_payable' AND a.agent_id=resident
      AND a.wallet_address=lower(o.recipient) AND NEW.amount_raw=o.amount_raw)
    OR (o.kind='infrastructure_fee' AND a.kind='infrastructure_treasury' AND NEW.amount_raw=o.amount_raw)),false) THEN
    RAISE EXCEPTION 'EXTERNAL_LEDGER_SOURCE_OR_AMOUNT_INVALID';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_ledger_posting_check BEFORE INSERT ON world_external_ledger_postings
  FOR EACH ROW EXECUTE FUNCTION validate_external_ledger_posting();

CREATE FUNCTION validate_external_withdrawal_commit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE wid uuid; rid uuid; n integer; total numeric;
BEGIN
  wid:=NEW.world_id;
  IF TG_TABLE_NAME='world_external_withdrawals' THEN rid:=NEW.id;
  ELSIF TG_TABLE_NAME='world_external_payout_outbox' THEN rid:=NEW.withdrawal_id;
  ELSE SELECT withdrawal_id INTO rid FROM world_external_payout_outbox WHERE world_id=wid AND id=NEW.outbox_id;
  END IF;
  SELECT count(*) INTO n FROM world_external_payout_outbox WHERE world_id=wid AND withdrawal_id=rid;
  IF n<>2 THEN RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_REQUIRES_TWO_COMMITTED_PAYOUTS'; END IF;
  SELECT count(*),COALESCE(sum(p.amount_raw),0) INTO n,total FROM world_external_ledger_postings p
    JOIN world_external_payout_outbox o ON o.world_id=p.world_id AND o.id=p.outbox_id WHERE o.world_id=wid AND o.withdrawal_id=rid;
  IF n<>4 OR total<>0 OR EXISTS (SELECT 1 FROM world_external_payout_outbox o
      LEFT JOIN world_external_ledger_postings p ON p.world_id=o.world_id AND p.outbox_id=o.id
      WHERE o.world_id=wid AND o.withdrawal_id=rid GROUP BY o.id HAVING count(p.id)<>2 OR sum(p.amount_raw)<>0) THEN
    RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_DOUBLE_ENTRY_INVALID';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_external_withdrawal_commit_check AFTER INSERT ON world_external_withdrawals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_external_withdrawal_commit();
CREATE CONSTRAINT TRIGGER world_external_payout_commit_check AFTER INSERT ON world_external_payout_outbox
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_external_withdrawal_commit();
CREATE CONSTRAINT TRIGGER world_external_posting_commit_check AFTER INSERT ON world_external_ledger_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_external_withdrawal_commit();

CREATE VIEW world_external_infrastructure_balances AS
SELECT a.world_id,a.wallet_address,a.opening_balance_raw+COALESCE(sum(p.amount_raw),0) AS balance_raw
FROM world_external_ledger_accounts a LEFT JOIN world_external_ledger_postings p ON p.world_id=a.world_id AND p.account_id=a.id
WHERE a.kind='infrastructure_treasury' GROUP BY a.id;

CREATE FUNCTION mirrorterra_external_research_source(p world_research_payouts)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT COALESCE((SELECT independent FROM mirrorterra_external_operator(p.world_id,p.agent_id)),false) THEN RETURN false; END IF;
  IF p.source_type='research_grant' THEN
    RETURN p.kind='grant_final' AND EXISTS (
      SELECT 1 FROM world_research_grants g JOIN world_research_reports r ON r.world_id=g.world_id AND r.grant_id=g.id
      JOIN world_research_adoptions a ON a.world_id=r.world_id AND a.report_id=r.id
      JOIN world_events e ON e.world_id=a.world_id AND e.id=a.event_id AND e.actor_id=a.adopter_agent_id
      WHERE g.world_id=p.world_id AND g.id=p.grant_id AND g.agent_id=p.agent_id AND r.author_agent_id=p.agent_id
        AND r.status='published' AND r.citations_verified>0 AND r.citations_failed=0 AND r.uncited_numbers=0
        AND p.amount_raw<=g.amount_raw-COALESCE((SELECT sum(x.amount_raw) FROM world_research_payouts x
          WHERE x.world_id=g.world_id AND x.grant_id=g.id AND x.id<>p.id),0)
        AND mirrorterra_external_independent_pair(p.world_id,p.agent_id,a.adopter_agent_id)
        AND e.event_type='world.action_completed' AND e.data->>'status'='completed'
        AND e.data->'cognitionExecution'->>'planId'=a.plan_id AND e.data->'cognitionExecution'->>'stepId'=a.step_id);
  ELSIF p.source_type='research_verification' THEN
    RETURN EXISTS (SELECT 1 FROM world_research_verifications v JOIN world_gambit_claims c ON c.world_id=v.world_id AND c.id=v.claim_id
      WHERE v.world_id=p.world_id AND v.id=p.verification_id AND v.verifier_agent_id=p.agent_id
        AND c.verified_by_agent_id=p.agent_id AND mirrorterra_external_independent_pair(p.world_id,p.agent_id,c.agent_id)
        AND ((c.verification='true' AND v.kind='claim' AND p.kind='verification_replication' AND p.amount_raw=500000)
          OR (c.verification='false' AND p.kind='verification_exposure' AND p.amount_raw=1000000)));
  END IF;
  RETURN false;
END $$;

-- Preserve research1's narrow exceptions when the new piece is off. All other 0031 bans remain.
-- In particular an ineligible row always has a non-null epoch (external1b).
CREATE OR REPLACE FUNCTION mark_external_reward_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean; p world_research_payouts%ROWTYPE; policy world_external2_policy%ROWTYPE;
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id,NEW.agent_id) THEN
    SELECT * INTO policy FROM world_external2_policy WHERE singleton;
    allowed:=NEW.source_type IN ('research_grant','research_verification');
    IF (NEW.source_type='research_grant' AND policy.research_rewards)
      OR (NEW.source_type='research_verification' AND policy.verification_rewards) THEN
      SELECT * INTO p FROM world_research_payouts WHERE world_id=NEW.world_id AND id::text=NEW.source_entity_id;
      allowed:=p.id IS NOT NULL AND p.agent_id=NEW.agent_id AND mirrorterra_external_research_source(p);
    END IF;
    IF NOT COALESCE(allowed,false) THEN
      NEW.status:='not_eligible'; NEW.decision_reason:='external_resident';
      NEW.epoch_index:=COALESCE(NEW.epoch_index,(SELECT epoch_index FROM arc_sync_reward_capacity_snapshots
        WHERE world_id=NEW.world_id ORDER BY observed_at DESC,id DESC LIMIT 1),0);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION refuse_external_reward_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c arc_sync_resident_reward_contributions%ROWTYPE; p world_research_payouts%ROWTYPE; policy world_external2_policy%ROWTYPE;
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id,NEW.agent_id) THEN
    SELECT * INTO c FROM arc_sync_resident_reward_contributions WHERE world_id=NEW.world_id AND id=NEW.contribution_id;
    IF c.source_type NOT IN ('research_grant','research_verification') OR c.id IS NULL THEN
      RAISE EXCEPTION 'external residents receive no pool rewards';
    END IF;
    SELECT * INTO policy FROM world_external2_policy WHERE singleton;
    IF (c.source_type='research_grant' AND policy.research_rewards) OR (c.source_type='research_verification' AND policy.verification_rewards) THEN
      SELECT * INTO p FROM world_research_payouts WHERE world_id=NEW.world_id AND id::text=c.source_entity_id;
      IF p.id IS NULL OR p.agent_id<>NEW.agent_id OR NEW.sync_amount_raw<>p.amount_raw OR NOT mirrorterra_external_research_source(p) THEN
        RAISE EXCEPTION 'EXTERNAL_RESEARCH_EVIDENCE_REQUIRED';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION validate_external_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual numeric; valid boolean;
BEGIN
  IF NOT COALESCE((SELECT independent FROM mirrorterra_external_operator(NEW.world_id,NEW.agent_id)),false) THEN
    RAISE EXCEPTION 'EXTERNAL_INDEPENDENT_OPERATOR_REQUIRED';
  END IF;
  IF NEW.kind='public_work' THEN
    SELECT COALESCE(sum(e.amount_raw),0) INTO actual FROM world_sync_treasury_entries e
      JOIN world_public_works w ON w.world_id=e.world_id AND e.source_ref='public_work:'||w.id::text
      WHERE w.world_id=NEW.world_id AND w.id::text=NEW.source_ref AND w.builder_agent_id=NEW.agent_id
        AND w.status='completed' AND w.progress=100 AND w.milestones_paid=4 AND w.paid_raw=w.contract_price_raw
        AND e.to_agent_id=NEW.agent_id AND e.kind='public_works';
    valid:=actual=NEW.amount_raw AND actual>0;
  ELSE
    SELECT COALESCE(sum(e.sync_amount_raw),0),COALESCE(bool_and(mirrorterra_external_research_source(p)),false) INTO actual,valid
      FROM arc_sync_resident_reward_entitlements e JOIN arc_sync_resident_reward_contributions c ON c.world_id=e.world_id AND c.id=e.contribution_id
      JOIN world_research_payouts p ON p.world_id=c.world_id AND p.id::text=c.source_entity_id
      LEFT JOIN world_research_verifications v ON v.world_id=p.world_id AND v.id=p.verification_id
      WHERE e.world_id=NEW.world_id AND e.agent_id=NEW.agent_id AND e.id=NEW.entitlement_id
        AND ((NEW.kind='research' AND p.source_type='research_grant' AND p.grant_id::text=NEW.source_ref)
          OR (NEW.kind='verification' AND p.source_type='research_verification' AND v.claim_id::text=NEW.source_ref));
    valid:=valid AND actual=NEW.amount_raw;
  END IF;
  IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION 'EXTERNAL_CONTRIBUTION_EVIDENCE_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_receipt_check BEFORE INSERT ON world_external_contribution_receipts
  FOR EACH ROW EXECUTE FUNCTION validate_external_receipt();

CREATE FUNCTION create_external_reward_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO world_external_reward_holds(world_id,agent_id,started_at,real_days,required_acceptances)
    SELECT NEW.world_id,NEW.agent_id,e.created_at,p.probation_real_days,p.probation_acceptances
    FROM world_external_residents e CROSS JOIN world_external2_policy p
    WHERE e.world_id=NEW.world_id AND e.agent_id=NEW.agent_id AND p.singleton
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_receipt_hold AFTER INSERT ON world_external_contribution_receipts
  FOR EACH ROW EXECUTE FUNCTION create_external_reward_hold();
-- Starting the probation clock at the trusted binding also covers research1
-- entitlements earned before external2's reward switches are enabled.
CREATE FUNCTION create_external_binding_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO world_external_reward_holds(world_id,agent_id,started_at,real_days,required_acceptances)
    SELECT NEW.world_id,NEW.agent_id,e.created_at,p.probation_real_days,p.probation_acceptances
    FROM world_external_residents e CROSS JOIN world_external2_policy p
    WHERE e.world_id=NEW.world_id AND e.agent_id=NEW.agent_id AND p.singleton
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_binding_hold AFTER INSERT ON world_external_operator_bindings
  FOR EACH ROW EXECUTE FUNCTION create_external_binding_hold();

CREATE FUNCTION record_external_research_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p world_research_payouts%ROWTYPE; c arc_sync_resident_reward_contributions%ROWTYPE; source text; mode boolean;
BEGIN
  IF NOT mirrorterra_is_external_resident(NEW.world_id,NEW.agent_id) THEN RETURN NEW; END IF;
  SELECT * INTO c FROM arc_sync_resident_reward_contributions WHERE world_id=NEW.world_id AND id=NEW.contribution_id;
  SELECT * INTO p FROM world_research_payouts WHERE world_id=NEW.world_id AND id::text=c.source_entity_id;
  SELECT CASE WHEN p.source_type='research_grant' THEN research_rewards ELSE verification_rewards END INTO mode
    FROM world_external2_policy WHERE singleton;
  IF COALESCE(mode,false) THEN
    IF p.source_type='research_grant' THEN source:=p.grant_id::text;
    ELSE SELECT claim_id::text INTO source FROM world_research_verifications WHERE world_id=p.world_id AND id=p.verification_id;
    END IF;
    INSERT INTO world_external_contribution_receipts(world_id,agent_id,kind,source_ref,entitlement_id,amount_raw)
      VALUES(NEW.world_id,NEW.agent_id,CASE WHEN p.source_type='research_grant' THEN 'research' ELSE 'verification' END,source,NEW.id,NEW.sync_amount_raw);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_entitlement_external2_receipt AFTER INSERT ON arc_sync_resident_reward_entitlements
  FOR EACH ROW EXECUTE FUNCTION record_external_research_receipt();

CREATE OR REPLACE FUNCTION refuse_external_treasury_payout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_agent_id IS NOT NULL AND mirrorterra_is_external_resident(NEW.world_id,NEW.to_agent_id) THEN
    IF NEW.kind<>'public_works' OR NOT COALESCE((SELECT public_work_rewards FROM world_external2_policy WHERE singleton),false)
      OR NOT COALESCE((SELECT independent FROM mirrorterra_external_operator(NEW.world_id,NEW.to_agent_id)),false)
      OR NOT EXISTS (SELECT 1 FROM world_public_works w WHERE w.world_id=NEW.world_id AND NEW.source_ref='public_work:'||w.id::text
        AND w.builder_agent_id=NEW.to_agent_id AND w.status IN ('building','completed')) THEN
      RAISE EXCEPTION 'external residents receive no treasury SYNC';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION record_external_public_work_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE amount numeric;
BEGIN
  IF NEW.status='completed' AND OLD.status<>'completed' AND mirrorterra_is_external_resident(NEW.world_id,NEW.builder_agent_id)
    AND COALESCE((SELECT public_work_rewards FROM world_external2_policy WHERE singleton),false) THEN
    SELECT COALESCE(sum(amount_raw),0) INTO amount FROM world_sync_treasury_entries WHERE world_id=NEW.world_id
      AND to_agent_id=NEW.builder_agent_id AND kind='public_works' AND source_ref='public_work:'||NEW.id::text;
    IF amount>0 THEN INSERT INTO world_external_contribution_receipts(world_id,agent_id,kind,source_ref,amount_raw)
      VALUES(NEW.world_id,NEW.builder_agent_id,'public_work',NEW.id::text,amount); END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_public_work_external2_receipt AFTER UPDATE ON world_public_works
  FOR EACH ROW EXECUTE FUNCTION record_external_public_work_receipt();

CREATE FUNCTION validate_external_public_work_payment_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_agent_id IS NOT NULL AND mirrorterra_is_external_resident(NEW.world_id,NEW.to_agent_id) THEN
    IF NOT EXISTS (SELECT 1 FROM world_external_contribution_receipts r
      JOIN world_public_works w ON w.world_id=r.world_id AND w.id::text=r.source_ref
      WHERE r.world_id=NEW.world_id AND r.agent_id=NEW.to_agent_id AND r.kind='public_work'
        AND NEW.source_ref='public_work:'||r.source_ref AND w.status='completed' AND w.progress=100) THEN
      RAISE EXCEPTION 'EXTERNAL_PUBLIC_WORK_MUST_BE_COMPLETED_AND_ACCEPTED';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_treasury_external2_payment_commit AFTER INSERT ON world_sync_treasury_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_external_public_work_payment_commit();

CREATE FUNCTION validate_external_contribution_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r world_external_contribution_receipts%ROWTYPE; valid boolean;
BEGIN
  SELECT * INTO r FROM world_external_contribution_receipts WHERE world_id=NEW.world_id AND id=NEW.receipt_id;
  IF r.id IS NULL OR NOT mirrorterra_external_independent_pair(NEW.world_id,r.agent_id,NEW.acceptor_agent_id) THEN
    RAISE EXCEPTION 'EXTERNAL_ACCEPTANCE_REQUIRES_OTHER_OPERATOR';
  END IF;
  IF r.kind='public_work' THEN
    valid:=EXISTS (SELECT 1 FROM world_public_work_uses u WHERE u.world_id=r.world_id AND u.work_id::text=r.source_ref
      AND u.agent_id=NEW.acceptor_agent_id);
  ELSIF r.kind='research' THEN
    valid:=EXISTS (SELECT 1 FROM world_research_reports p JOIN world_research_adoptions a ON a.world_id=p.world_id AND a.report_id=p.id
      WHERE p.world_id=r.world_id AND p.grant_id::text=r.source_ref AND a.adopter_agent_id=NEW.acceptor_agent_id);
  ELSE
    valid:=EXISTS (SELECT 1 FROM world_gambit_claims c JOIN world_research_verifications v ON v.world_id=c.world_id AND v.claim_id=c.id
      WHERE c.world_id=r.world_id AND c.id::text=r.source_ref AND c.agent_id=NEW.acceptor_agent_id
        AND v.verifier_agent_id=r.agent_id AND v.status IN ('true','false'));
  END IF;
  IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION 'EXTERNAL_ACCEPTANCE_ENGINE_EVIDENCE_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_acceptance_check BEFORE INSERT ON world_external_contribution_acceptances
  FOR EACH ROW EXECUTE FUNCTION validate_external_contribution_acceptance();

CREATE FUNCTION validate_external_receipt_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='verification' AND NOT EXISTS (SELECT 1 FROM arc_sync_resident_reward_entitlements e
    JOIN arc_sync_resident_reward_contributions c ON c.world_id=e.world_id AND c.id=e.contribution_id
    JOIN world_research_payouts p ON p.world_id=c.world_id AND p.id::text=c.source_entity_id
    JOIN world_research_verifications v ON v.world_id=p.world_id AND v.id=p.verification_id
    WHERE e.id=NEW.entitlement_id AND v.status IN ('true','false') AND v.reward_payout_id=p.id) THEN
    RAISE EXCEPTION 'EXTERNAL_VERIFICATION_MUST_BE_SETTLED';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_external_receipt_commit_check AFTER INSERT ON world_external_contribution_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_external_receipt_commit();

CREATE FUNCTION record_external_adoption_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='research' THEN
    INSERT INTO world_external_contribution_acceptances(world_id,receipt_id,acceptor_agent_id,action_id)
      SELECT NEW.world_id,NEW.id,a.adopter_agent_id,'external2-adoption:'||NEW.id::text
      FROM world_research_reports r JOIN world_research_adoptions a ON a.world_id=r.world_id AND a.report_id=r.id
      WHERE r.world_id=NEW.world_id AND r.grant_id::text=NEW.source_ref
        AND mirrorterra_external_independent_pair(NEW.world_id,NEW.agent_id,a.adopter_agent_id)
      ORDER BY a.id LIMIT 1 ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_receipt_adoption_acceptance AFTER INSERT ON world_external_contribution_receipts
  FOR EACH ROW EXECUTE FUNCTION record_external_adoption_acceptance();

CREATE FUNCTION forbid_external_automatic_bid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id,NEW.agent_id) AND (
    NEW.source<>'llm' OR NOT COALESCE((SELECT public_work_rewards FROM world_external2_policy WHERE singleton),false)
    OR NOT COALESCE((SELECT independent FROM mirrorterra_external_operator(NEW.world_id,NEW.agent_id)),false)) THEN
    RAISE EXCEPTION 'EXTERNAL_SIGNED_PAID_BID_REQUIRED'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_public_work_bid_external2_check BEFORE INSERT ON world_public_work_bids
  FOR EACH ROW EXECUTE FUNCTION forbid_external_automatic_bid();

-- Same sender lock as ordinary transfers/taxes, acquired after the member lock.
-- This backstop applies even after all external2 switches have been turned off.
CREATE FUNCTION enforce_external_frozen_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sender uuid; available numeric; frozen numeric;
BEGIN
  sender:=NEW.from_agent_id;
  IF sender IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM world_external_reward_holds WHERE world_id=NEW.world_id AND agent_id=sender) THEN RETURN NEW; END IF;
  PERFORM agent_id FROM world_members WHERE world_id=NEW.world_id AND agent_id=sender FOR KEY SHARE;
  PERFORM pg_advisory_xact_lock(hashtextextended('sync-internal:'||NEW.world_id::text||':'||sender::text,0));
  SELECT spendable_raw INTO available FROM arc_sync_internal_balances WHERE world_id=NEW.world_id AND agent_id=sender;
  frozen:=LEAST(GREATEST(COALESCE(available,0),0),mirrorterra_external_frozen_raw(NEW.world_id,sender));
  IF available IS NULL OR available-frozen<NEW.amount_raw THEN RAISE EXCEPTION 'EXTERNAL_BALANCE_FROZEN_OR_INSUFFICIENT'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_internal_transfer_a_external2 BEFORE INSERT ON arc_sync_internal_transfers
  FOR EACH ROW EXECUTE FUNCTION enforce_external_frozen_balance();
CREATE TRIGGER world_sync_treasury_entry_a_external2 BEFORE INSERT ON world_sync_treasury_entries
  FOR EACH ROW EXECUTE FUNCTION enforce_external_frozen_balance();

CREATE FUNCTION validate_external_wallet_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other_wallet text;
BEGIN
  IF TG_TABLE_NAME='world_external_withdrawal_wallets' THEN
    IF NOT COALESCE((SELECT withdrawals FROM world_external2_policy WHERE singleton),false) THEN
      RAISE EXCEPTION 'EXTERNAL_WITHDRAWALS_CLOSED'; END IF;
    SELECT wallet_address INTO other_wallet FROM world_external_wallets WHERE world_id=NEW.world_id AND agent_id=NEW.agent_id;
  ELSE
    SELECT wallet_address INTO other_wallet FROM world_external_withdrawal_wallets WHERE world_id=NEW.world_id AND agent_id=NEW.agent_id;
  END IF;
  IF other_wallet IS NOT NULL AND lower(other_wallet)<>lower(NEW.wallet_address) THEN
    RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_WALLET_MISMATCH'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_withdrawal_wallet_check BEFORE INSERT ON world_external_withdrawal_wallets
  FOR EACH ROW EXECUTE FUNCTION validate_external_wallet_consistency();
CREATE TRIGGER world_external_wallet_external2_consistency BEFORE INSERT ON world_external_wallets
  FOR EACH ROW EXECUTE FUNCTION validate_external_wallet_consistency();

-- Never let the gross-entitlement legacy batch route pay an external actor, including switch-off.
CREATE FUNCTION refuse_external_legacy_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id,NEW.agent_id) THEN
    RAISE EXCEPTION 'EXTERNAL_WITHDRAWAL_REQUIRES_SPLIT_CONVERSION'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_batch_external2_guard BEFORE INSERT ON arc_sync_resident_reward_batches
  FOR EACH ROW EXECUTE FUNCTION refuse_external_legacy_batch();
CREATE TRIGGER arc_sync_payout_outbox_external2_guard BEFORE INSERT ON arc_sync_payout_outbox
  FOR EACH ROW EXECUTE FUNCTION refuse_external_legacy_batch();

GRANT SELECT ON world_external2_policy,world_external_operators TO synterra_app;
GRANT SELECT,INSERT ON world_external_operator_bindings,world_external_reward_holds,world_external_contribution_receipts,
  world_external_contribution_acceptances,world_external_withdrawal_wallets,world_external_withdrawals,
  world_external_payout_outbox,world_external_ledger_accounts,world_external_ledger_postings TO synterra_app;
GRANT UPDATE(released_at) ON world_external_reward_holds TO synterra_app;
GRANT SELECT ON world_external_infrastructure_balances TO synterra_app;

INSERT INTO world_external_ledger_accounts(world_id,kind,account_key,wallet_address)
  SELECT world_id,'infrastructure_treasury','infrastructure-treasury','0x37428832cc1546aea4bc72948d739b08677d7739'
  FROM arc_sync_tokenomics_deployments;

-- Existing columns/order are preserved for research1 rollback compatibility.
CREATE OR REPLACE VIEW arc_sync_internal_balances AS
SELECT member.world_id,member.agent_id,
  COALESCE(earned.amount_raw,0)::numeric(78,0) AS earned_raw,
  COALESCE(received.amount_raw,0)::numeric(78,0) AS received_raw,
  COALESCE(sent.amount_raw,0)::numeric(78,0) AS sent_raw,
  (COALESCE(earned.amount_raw,0)+COALESCE(received.amount_raw,0)-COALESCE(sent.amount_raw,0)
    +COALESCE(treasury_in.amount_raw,0)-COALESCE(treasury_out.amount_raw,0)
    +COALESCE(purchased.amount_raw,0)-COALESCE(withdrawn.amount_raw,0))::numeric(78,0) AS spendable_raw,
  COALESCE(treasury_in.amount_raw,0)::numeric(78,0) AS treasury_received_raw,
  COALESCE(treasury_out.amount_raw,0)::numeric(78,0) AS treasury_paid_raw,
  COALESCE(purchased.amount_raw,0)::numeric(78,0) AS purchased_raw
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
  WHERE entry.world_id=member.world_id AND entry.from_agent_id=member.agent_id) treasury_out ON true
LEFT JOIN LATERAL (SELECT sum(purchase.sync_amount_raw) AS amount_raw FROM world_sync_purchases purchase
  WHERE purchase.world_id=member.world_id AND purchase.agent_id=member.agent_id) purchased ON true
LEFT JOIN LATERAL (SELECT sum(w.gross_raw) AS amount_raw FROM world_external_withdrawals w
  WHERE w.world_id=member.world_id AND w.agent_id=member.agent_id) withdrawn ON true;
