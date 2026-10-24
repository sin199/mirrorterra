-- gambit1: resident gambits ("局") built on the Qianmen 108 patterns, as world physics only.
-- The engine holds the ledger, evidence and contract state; residents can only SAY things (lines, claims,
-- promises) into these tables. What a resident says may be false: claims carry a verification state that
-- only the engine sets, once, from world records. Consequences come from other residents' reactions.
--
-- Additive: new tables, triggers and grants. The ONLY change to an existing object is widening the
-- arc_sync_internal_transfers.kind CHECK to a superset (new resident-to-resident kinds). The balance views
-- (arc_sync_internal_balances, world_external_resident_balances) sum every transfer regardless of kind, the
-- transfer triggers (balance check, external guard) apply to every kind, and the 0027 order trigger only
-- accepts business_service_payment for orders, so SYNC conservation and the external guard are unchanged.
-- Old releases never read the new tables and never write the new kinds.
SET LOCAL lock_timeout = '10s';

-- 1. Widen the transfer kind CHECK (superset).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
      WHERE conrelid='public.arc_sync_internal_transfers'::regclass AND contype='c'
        AND pg_get_constraintdef(oid) LIKE '%business_service_payment%' AND pg_get_constraintdef(oid) LIKE '%kind%' LOOP
    EXECUTE format('ALTER TABLE public.arc_sync_internal_transfers DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE arc_sync_internal_transfers ADD CONSTRAINT arc_sync_internal_transfers_kind_check
  CHECK (kind IN ('business_service_payment','business_wage','material_sale','subcontract','capability_royalty',
    'gambit_settlement','verification_fee'));

-- 2. Gambits. Terms are immutable; status moves forward only; terminal states are final.
CREATE TABLE world_gambits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  scene text NOT NULL CHECK (scene IN ('tender_bid','material_trade','council_vote','capability_proposal','reputation',
    'verification','exit')),
  mode text NOT NULL DEFAULT 'bilateral' CHECK (mode IN ('bilateral','poll')),
  initiator_agent_id uuid NOT NULL,
  counterpart_agent_ids uuid[] NOT NULL CHECK (cardinality(counterpart_agent_ids) BETWEEN 1 AND 12),
  role text CHECK (role IS NULL OR role IN ('zheng','ti','fan','tuo','feng','huo','chu','yao')),
  pattern_ids text[] NOT NULL DEFAULT '{}'
    CHECK (array_to_string(pattern_ids, ',') ~ '^(QM[0-9]{3}(,QM[0-9]{3})*)?$' AND cardinality(pattern_ids) <= 6),
  move text NOT NULL CHECK (move ~ '^[a-z_]{2,40}$'),
  public_line text CHECK (public_line IS NULL OR char_length(public_line) BETWEEN 1 AND 240),
  exit_condition text CHECK (exit_condition IS NULL OR char_length(exit_condition) BETWEEN 1 AND 240),
  target_ref text CHECK (target_ref IS NULL OR char_length(target_ref) BETWEEN 1 AND 180),
  terms jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(terms)='object'),
  status text NOT NULL DEFAULT 'awaiting' CHECK (status IN ('awaiting','verifying','accepted','rejected','exited',
    'exposed','settled','void')),
  turn_agent_id uuid,
  turn_after_world_minute bigint,
  move_count smallint NOT NULL DEFAULT 1 CHECK (move_count BETWEEN 1 AND 40),
  model text CHECK (model IS NULL OR char_length(model) <= 80),
  ab_cohort text CHECK (ab_cohort IS NULL OR char_length(ab_cohort) <= 20),
  opened_world_minute bigint NOT NULL CHECK (opened_world_minute >= 0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= 0),
  settled_world_minute bigint,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(outcome)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  FOREIGN KEY (world_id,initiator_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_gambits_turn_idx ON world_gambits(world_id,status,turn_after_world_minute)
  WHERE status IN ('awaiting','verifying');
CREATE INDEX world_gambits_recent_idx ON world_gambits(world_id,opened_world_minute DESC);
CREATE INDEX world_gambits_initiator_idx ON world_gambits(world_id,initiator_agent_id,opened_world_minute DESC);

CREATE FUNCTION validate_world_gambit_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Gambits are never deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.scene<>OLD.scene OR NEW.mode<>OLD.mode
      OR NEW.initiator_agent_id<>OLD.initiator_agent_id OR NEW.counterpart_agent_ids<>OLD.counterpart_agent_ids
      OR NEW.opened_world_minute<>OLD.opened_world_minute OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'Gambit identity is immutable';
  END IF;
  IF OLD.status IN ('rejected','exited','exposed','settled','void') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Gambit % is final', OLD.status;
  END IF;
  IF OLD.status='accepted' AND NEW.status NOT IN ('accepted','settled','exited','exposed') THEN
    RAISE EXCEPTION 'An accepted gambit can only settle, be exited or be exposed';
  END IF;
  IF NEW.move_count<OLD.move_count OR NEW.updated_world_minute<OLD.updated_world_minute THEN
    RAISE EXCEPTION 'Gambit history only grows';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER world_gambit_update_check BEFORE UPDATE OR DELETE ON world_gambits
  FOR EACH ROW EXECUTE FUNCTION validate_world_gambit_update();

-- 3. Every move in a gambit (append-only).
CREATE TABLE world_gambit_moves (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gambit_id uuid NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 40),
  agent_id uuid NOT NULL,
  move text NOT NULL CHECK (move IN ('open','accept','counter','reject','verify','expose','exit','vote_yes','vote_no','lapse','void')),
  pattern_ids text[] NOT NULL DEFAULT '{}'
    CHECK (array_to_string(pattern_ids, ',') ~ '^(QM[0-9]{3}(,QM[0-9]{3})*)?$' AND cardinality(pattern_ids) <= 6),
  public_line text CHECK (public_line IS NULL OR char_length(public_line) BETWEEN 1 AND 240),
  private_note text CHECK (private_note IS NULL OR char_length(private_note) BETWEEN 1 AND 300),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload)='object'),
  model text CHECK (model IS NULL OR char_length(model) <= 80),
  ab_cohort text CHECK (ab_cohort IS NULL OR char_length(ab_cohort) <= 20),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,gambit_id,seq),
  FOREIGN KEY (world_id,gambit_id) REFERENCES world_gambits(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_gambit_moves_agent_idx ON world_gambit_moves(world_id,agent_id,world_minute DESC);

CREATE FUNCTION prevent_world_gambit_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER world_gambit_moves_immutable BEFORE UPDATE OR DELETE ON world_gambit_moves
  FOR EACH ROW EXECUTE FUNCTION prevent_world_gambit_rewrite();

-- 4. Claims residents make (in a gambit, or attached to a tender bid). Only the engine sets verification,
-- once, from world records; the claimed value itself never changes.
CREATE TABLE world_gambit_claims (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gambit_id uuid,
  context_ref text CHECK (context_ref IS NULL OR char_length(context_ref) BETWEEN 1 AND 180),
  agent_id uuid NOT NULL,
  fact_key text NOT NULL CHECK (fact_key IN ('build_skill','active_contracts','wins_count','output_quality','balance',
    'third_party_offer','bid_placed','vote_cast','private')),
  subject_ref text CHECK (subject_ref IS NULL OR char_length(subject_ref) BETWEEN 1 AND 180),
  claimed_value jsonb NOT NULL CHECK (jsonb_typeof(claimed_value) IN ('number','string','boolean','object')),
  verifiable boolean NOT NULL,
  verification text NOT NULL DEFAULT 'unverified' CHECK (verification IN ('unverified','true','false','unverifiable')),
  verified_by_agent_id uuid,
  verified_world_minute bigint,
  truth jsonb,
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (gambit_id IS NOT NULL OR context_ref IS NOT NULL),
  FOREIGN KEY (world_id,gambit_id) REFERENCES world_gambits(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_gambit_claims_gambit_idx ON world_gambit_claims(world_id,gambit_id) WHERE gambit_id IS NOT NULL;
CREATE INDEX world_gambit_claims_context_idx ON world_gambit_claims(world_id,context_ref) WHERE context_ref IS NOT NULL;
CREATE INDEX world_gambit_claims_agent_idx ON world_gambit_claims(world_id,agent_id,created_world_minute DESC);

CREATE FUNCTION validate_world_gambit_claim_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Claims are never deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.gambit_id IS DISTINCT FROM OLD.gambit_id
      OR NEW.context_ref IS DISTINCT FROM OLD.context_ref OR NEW.agent_id<>OLD.agent_id OR NEW.fact_key<>OLD.fact_key
      OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref OR NEW.claimed_value<>OLD.claimed_value
      OR NEW.verifiable<>OLD.verifiable OR NEW.created_world_minute<>OLD.created_world_minute THEN
    RAISE EXCEPTION 'What was claimed cannot be changed';
  END IF;
  IF OLD.verification<>'unverified' THEN RAISE EXCEPTION 'A claim is verified only once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_gambit_claim_update_check BEFORE UPDATE OR DELETE ON world_gambit_claims
  FOR EACH ROW EXECUTE FUNCTION validate_world_gambit_claim_update();

-- 5. Promises made in accepted gambits; the engine checks them against world records when due.
CREATE TABLE world_gambit_commitments (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gambit_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  counterparty_agent_id uuid,
  kind text NOT NULL CHECK (kind IN ('abstain_bid','place_bid','vote_stance','deliver_output','pay','support_capability',
    'oppose_capability','ban_vote')),
  target_ref text CHECK (target_ref IS NULL OR char_length(target_ref) BETWEEN 1 AND 180),
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_world_minute bigint NOT NULL CHECK (due_world_minute >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','kept','broken','released')),
  settled_world_minute bigint,
  evidence jsonb,
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,gambit_id) REFERENCES world_gambits(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_gambit_commitments_due_idx ON world_gambit_commitments(world_id,due_world_minute) WHERE status='pending';
CREATE INDEX world_gambit_commitments_gambit_idx ON world_gambit_commitments(world_id,gambit_id);

CREATE FUNCTION validate_world_gambit_commitment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Commitments are never deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.gambit_id<>OLD.gambit_id OR NEW.agent_id<>OLD.agent_id
      OR NEW.counterparty_agent_id IS DISTINCT FROM OLD.counterparty_agent_id OR NEW.kind<>OLD.kind
      OR NEW.target_ref IS DISTINCT FROM OLD.target_ref OR NEW.value<>OLD.value
      OR NEW.due_world_minute<>OLD.due_world_minute OR NEW.created_world_minute<>OLD.created_world_minute THEN
    RAISE EXCEPTION 'Commitment terms are immutable';
  END IF;
  IF OLD.status<>'pending' THEN RAISE EXCEPTION 'A commitment settles only once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_gambit_commitment_update_check BEFORE UPDATE OR DELETE ON world_gambit_commitments
  FOR EACH ROW EXECUTE FUNCTION validate_world_gambit_commitment_update();

-- 6. Public record of what happened between residents (append-only). delta_trust is the observer's own
-- reaction toward the subject; it never feeds any engine rule.
CREATE TABLE world_reputation_events (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  observer_agent_id uuid,
  kind text NOT NULL CHECK (kind IN ('kept','broken','released','exposed','exposer','claim_true','claim_false',
    'ban_passed','ban_failed','exit','royalty')),
  delta_trust numeric(6,2) NOT NULL DEFAULT 0 CHECK (delta_trust BETWEEN -100 AND 100),
  gambit_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_reputation_events_agent_idx ON world_reputation_events(world_id,agent_id,world_minute DESC);
CREATE INDEX world_reputation_events_observer_idx ON world_reputation_events(world_id,observer_agent_id,agent_id)
  WHERE observer_agent_id IS NOT NULL;
CREATE TRIGGER world_reputation_events_immutable BEFORE UPDATE OR DELETE ON world_reputation_events
  FOR EACH ROW EXECUTE FUNCTION prevent_world_gambit_rewrite();

-- 7. A skill output sold to a builder: reserved for that buyer (paid by an internal transfer).
CREATE TABLE world_material_reservations (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  output_id bigint NOT NULL REFERENCES world_skill_outputs(output_id) ON DELETE CASCADE,
  seller_id uuid NOT NULL,
  buyer_id uuid NOT NULL,
  gambit_id uuid,
  price_raw numeric(78,0) NOT NULL CHECK (price_raw >= 0),
  transfer_id uuid,
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,output_id),
  CHECK (seller_id <> buyer_id),
  FOREIGN KEY (world_id,buyer_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,seller_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_material_reservations_buyer_idx ON world_material_reservations(world_id,buyer_id);
CREATE TRIGGER world_material_reservations_immutable BEFORE UPDATE OR DELETE ON world_material_reservations
  FOR EACH ROW EXECUTE FUNCTION prevent_world_gambit_rewrite();

-- 8. Tender bans voted by residents (a ban is the residents' collective decision, recorded as a fact).
CREATE TABLE world_gambit_bans (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  gambit_id uuid NOT NULL,
  target_agent_id uuid NOT NULL,
  yes_votes smallint NOT NULL CHECK (yes_votes >= 0),
  no_votes smallint NOT NULL CHECK (no_votes >= 0),
  electorate smallint NOT NULL CHECK (electorate >= 1),
  from_world_minute bigint NOT NULL,
  until_world_minute bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (until_world_minute > from_world_minute),
  UNIQUE (world_id,gambit_id),
  FOREIGN KEY (world_id,gambit_id) REFERENCES world_gambits(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,target_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_gambit_bans_target_idx ON world_gambit_bans(world_id,target_agent_id,until_world_minute);
CREATE TRIGGER world_gambit_bans_immutable BEFORE UPDATE OR DELETE ON world_gambit_bans
  FOR EACH ROW EXECUTE FUNCTION prevent_world_gambit_rewrite();

-- 9. Capability royalty terms (P3) and the royalty paid per use (one row per use, backed by a transfer).
CREATE TABLE world_capability_royalties (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  proposer_agent_id uuid NOT NULL,
  royalty_raw numeric(78,0) NOT NULL CHECK (royalty_raw >= 0 AND royalty_raw <= 100000),
  affected jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(affected)='object'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,proposal_id),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_capability_proposals(world_id,id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,proposer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE TRIGGER world_capability_royalties_immutable BEFORE UPDATE OR DELETE ON world_capability_royalties
  FOR EACH ROW EXECUTE FUNCTION prevent_world_gambit_rewrite();

CREATE TABLE world_capability_royalty_payments (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  use_id bigint NOT NULL,
  proposal_id uuid NOT NULL,
  payer_agent_id uuid NOT NULL,
  proposer_agent_id uuid NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw >= 0),
  transfer_id uuid,
  status text NOT NULL CHECK (status IN ('paid','unfunded','self_use')),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,use_id)
);
CREATE INDEX world_capability_royalty_payments_proposer_idx ON world_capability_royalty_payments(world_id,proposer_agent_id);
CREATE TRIGGER world_capability_royalty_payments_immutable BEFORE UPDATE OR DELETE ON world_capability_royalty_payments
  FOR EACH ROW EXECUTE FUNCTION prevent_world_gambit_rewrite();

-- 10. Grants (no DELETE anywhere).
GRANT SELECT,INSERT ON world_gambits,world_gambit_moves,world_gambit_claims,world_gambit_commitments,
  world_reputation_events,world_material_reservations,world_gambit_bans,world_capability_royalties,
  world_capability_royalty_payments TO synterra_app;
GRANT UPDATE (status,turn_agent_id,turn_after_world_minute,move_count,pattern_ids,public_line,terms,updated_world_minute,
  settled_world_minute,outcome,model,ab_cohort,updated_at) ON world_gambits TO synterra_app;
GRANT UPDATE (verification,verified_by_agent_id,verified_world_minute,truth) ON world_gambit_claims TO synterra_app;
GRANT UPDATE (status,settled_world_minute,evidence) ON world_gambit_commitments TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_gambit_moves_id_seq,world_gambit_claims_id_seq,world_gambit_commitments_id_seq,
  world_reputation_events_id_seq,world_gambit_bans_id_seq TO synterra_app;
