-- external1 (user decisions 2026-10-21 14:51 / 14:55): external residents (agents that registered through
-- the public API and joined the open world) live the same engine-driven routine life as the original ten,
-- decide their big council/public-works acts through their OWN AI over the signed API, and never receive
-- world-internal money: no pool rewards, no treasury payouts, no starting balance. Everything they own was
-- bought through the deployed SYNC protocol on Arc and deposited in-world (behind a closed gate).
-- Additive only: new tables, functions, triggers and grants; arc_sync_internal_balances is re-created with
-- the SAME columns in the SAME order plus one appended column (purchased_raw), exactly like 0028 did.
-- No existing table, column, constraint, trigger or function is altered or dropped.
-- Rollback-safe: the old release never reads the new tables; the guard triggers only stop internal money
-- reaching an external resident (contributions are silently marked not_eligible, never raised).

-- 1. Who is external. Presence of a row = external resident; the original residents have none.
CREATE TABLE world_external_residents (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  joined_world_minute bigint NOT NULL CHECK (joined_world_minute >= 0),
  source text NOT NULL CHECK (source IN ('api_join','backfill','engine')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE FUNCTION refuse_world_external_resident_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'external resident records are immutable';
END $$;
CREATE TRIGGER world_external_resident_immutable
  BEFORE UPDATE ON world_external_residents
  FOR EACH ROW EXECUTE FUNCTION refuse_world_external_resident_update();

CREATE FUNCTION mirrorterra_is_external_resident(p_world uuid, p_agent uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=p_world AND e.agent_id=p_agent)
$$;

-- Backfill: members without an engine state row in a world whose engine already runs (prod: Visitor-Hark).
-- joined_world_minute is estimated from joined_at (1 real second = 1 world minute).
INSERT INTO world_external_residents(world_id,agent_id,joined_world_minute,source)
SELECT m.world_id,m.agent_id,
  GREATEST(0, r.world_minutes - GREATEST(0, extract(epoch FROM now()-m.joined_at))::bigint),'backfill'
FROM world_members m JOIN world_runtime_state r ON r.world_id=m.world_id
WHERE NOT EXISTS (SELECT 1 FROM world_agent_states s WHERE s.world_id=m.world_id AND s.agent_id=m.agent_id)
  AND EXISTS (SELECT 1 FROM world_agent_states s WHERE s.world_id=m.world_id)
ON CONFLICT DO NOTHING;

-- 2. Registration / join log for the env-tunable rate limits (only a hash of the client IP is stored).
CREATE TABLE world_agent_registrations (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('register','join')),
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  world_id uuid,
  ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{16,64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_agent_registrations_kind_idx ON world_agent_registrations(kind,created_at);
CREATE INDEX world_agent_registrations_ip_idx ON world_agent_registrations(ip_hash,kind,created_at);

-- 3. An external resident's own AI may choose or override its next routine activity.
CREATE TABLE world_external_activity_requests (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  action_id text NOT NULL CHECK (char_length(action_id) BETWEEN 8 AND 180),
  activity text NOT NULL CHECK (activity IN ('auto','work','learn','rest','eat','socialize','build_home',
    'build_public_work','visit')),
  place text CHECK (place IS NULL OR char_length(place) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','expired','superseded','infeasible')),
  requested_world_minute bigint NOT NULL CHECK (requested_world_minute >= 0),
  expires_world_minute bigint NOT NULL,
  applied_world_minute bigint,
  detail text CHECK (detail IS NULL OR char_length(detail) <= 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,action_id),
  CHECK (expires_world_minute > requested_world_minute),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_residents(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_external_activity_pending_idx ON world_external_activity_requests(world_id,agent_id,status);

-- 4. Volunteers on public works: externals help build for reputation and council eligibility only.
--    They never hold a contract and the treasury never pays them.
CREATE TABLE world_public_work_volunteers (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  work_id uuid NOT NULL REFERENCES world_public_works(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('external_api','fallback')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  pledged_world_minute bigint NOT NULL CHECK (pledged_world_minute >= 0),
  sessions integer NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  progress_added integer NOT NULL DEFAULT 0 CHECK (progress_added BETWEEN 0 AND 100),
  last_session_world_minute bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_residents(world_id,agent_id) ON DELETE CASCADE
);
CREATE FUNCTION validate_world_public_work_volunteer_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'volunteer records are append-only'; END IF;
  IF NEW.world_id<>OLD.world_id OR NEW.work_id<>OLD.work_id OR NEW.agent_id<>OLD.agent_id OR NEW.source<>OLD.source
      OR NEW.sessions<OLD.sessions OR NEW.progress_added<OLD.progress_added THEN
    RAISE EXCEPTION 'volunteer terms are immutable and counters only grow';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_public_work_volunteer_update_check
  BEFORE UPDATE OR DELETE ON world_public_work_volunteers
  FOR EACH ROW EXECUTE FUNCTION validate_world_public_work_volunteer_update();

-- 5. Purchased SYNC (user decision 2026-10-21 15:01: the deployed SYNC protocol on Arc is the only
--    seller; price = Genesis Dutch Auction, then the Protocol Market Pool curve; gross sales consume the
--    on-chain 30% market quota; no operator wallet, no admin price).
--    a) world_external_wallets: one Arc wallet per external resident, bound by a signed claim (EIP-191 by the
--       wallet over a text naming world + agent, plus the agent's own Ed25519-signed API request).
--    b) world_sync_purchase_events: verified on-chain buys BY that wallet (SyncAuctionPurchase from the
--       auction, ProtocolMarketBuy from the market pool), each tx/log recorded once (provenance).
--    c) world_sync_purchases: the CREDIT. A verified SYNC Transfer from the bound wallet INTO the World
--       Operating Pool contract (no admin withdrawal; only the commit-gated settlement executor pays out),
--       recorded once per tx/log, never more in total than that wallet's verified purchases. Depositing makes
--       the on-chain tokens unspendable by the buyer, so the internal balance cannot be double-spent
--       (bought SYNC kept in the wallet could otherwise be sold back on the pool or moved after crediting).
--    All three only insert inside a transaction that ran set_config('mirrorterra.external_purchase','enabled',true).
CREATE FUNCTION mirrorterra_external_purchase_gate() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('mirrorterra.external_purchase', true),'') <> 'enabled' THEN
    RAISE EXCEPTION 'SYNC purchase gate is closed';
  END IF;
END $$;

CREATE TABLE world_external_wallets (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 5042),
  wallet_address text NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
  claim_digest text NOT NULL CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
  bound_world_minute bigint NOT NULL CHECK (bound_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,agent_id),
  UNIQUE (chain_id,wallet_address),
  UNIQUE (claim_digest),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_residents(world_id,agent_id) ON DELETE RESTRICT
);
CREATE FUNCTION validate_world_external_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'wallet bindings are immutable'; END IF;
  PERFORM mirrorterra_external_purchase_gate();
  RETURN NEW;
END $$;
CREATE TRIGGER world_external_wallet_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_external_wallets
  FOR EACH ROW EXECUTE FUNCTION validate_world_external_wallet();

CREATE TABLE world_sync_purchase_events (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 5042),
  source text NOT NULL CHECK (source IN ('genesis_auction','protocol_market')),
  contract_address text NOT NULL CHECK (contract_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  confirmations integer NOT NULL CHECK (confirmations >= 1),
  buyer_address text NOT NULL CHECK (buyer_address ~ '^0x[0-9a-f]{40}$'),
  sync_amount_raw numeric(78,0) NOT NULL CHECK (sync_amount_raw > 0),
  usdc_amount_raw numeric(78,0) NOT NULL CHECK (usdc_amount_raw > 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id,tx_hash,log_index),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_wallets(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_sync_purchase_events_agent_idx ON world_sync_purchase_events(world_id,agent_id);

CREATE TABLE world_sync_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 5042),
  token_address text NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number numeric(78,0) NOT NULL CHECK (block_number >= 0),
  confirmations integer NOT NULL CHECK (confirmations >= 1),
  from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  deposit_address text NOT NULL CHECK (deposit_address ~ '^0x[0-9a-f]{40}$'),
  sync_amount_raw numeric(78,0) NOT NULL CHECK (sync_amount_raw > 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_address <> deposit_address),
  UNIQUE (chain_id,tx_hash,log_index),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_external_wallets(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_sync_purchases_agent_idx ON world_sync_purchases(world_id,agent_id);

CREATE FUNCTION validate_world_sync_purchase_record() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound text;
  bought numeric;
  credited numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'SYNC purchase records are append-only'; END IF;
  PERFORM mirrorterra_external_purchase_gate();
  SELECT wallet.wallet_address INTO bound FROM world_external_wallets wallet
    WHERE wallet.world_id=NEW.world_id AND wallet.agent_id=NEW.agent_id;
  IF bound IS NULL THEN RAISE EXCEPTION 'no bound wallet'; END IF;
  IF TG_TABLE_NAME='world_sync_purchase_events' THEN
    IF NEW.buyer_address IS DISTINCT FROM bound THEN RAISE EXCEPTION 'purchase was not made by the bound wallet'; END IF;
  ELSE
    IF NEW.from_address IS DISTINCT FROM bound THEN RAISE EXCEPTION 'deposit was not sent by the bound wallet'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('sync-purchase:' || NEW.world_id::text || ':' || NEW.agent_id::text,0));
    SELECT COALESCE(sum(e.sync_amount_raw),0) INTO bought FROM world_sync_purchase_events e
      WHERE e.world_id=NEW.world_id AND e.agent_id=NEW.agent_id;
    SELECT COALESCE(sum(p.sync_amount_raw),0) INTO credited FROM world_sync_purchases p
      WHERE p.world_id=NEW.world_id AND p.agent_id=NEW.agent_id;
    IF credited + NEW.sync_amount_raw > bought THEN
      RAISE EXCEPTION 'SYNC credit exceeds the wallet''s verified purchases';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_sync_purchase_event_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_sync_purchase_events
  FOR EACH ROW EXECUTE FUNCTION validate_world_sync_purchase_record();
CREATE TRIGGER world_sync_purchase_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_sync_purchases
  FOR EACH ROW EXECUTE FUNCTION validate_world_sync_purchase_record();

-- 6. Spendable balance includes purchased SYNC. Same columns/order as 0028; purchased_raw appended.
CREATE OR REPLACE VIEW arc_sync_internal_balances AS
SELECT member.world_id,member.agent_id,
  COALESCE(earned.amount_raw,0)::numeric(78,0) AS earned_raw,
  COALESCE(received.amount_raw,0)::numeric(78,0) AS received_raw,
  COALESCE(sent.amount_raw,0)::numeric(78,0) AS sent_raw,
  (COALESCE(earned.amount_raw,0)+COALESCE(received.amount_raw,0)-COALESCE(sent.amount_raw,0)
    +COALESCE(treasury_in.amount_raw,0)-COALESCE(treasury_out.amount_raw,0)
    +COALESCE(purchased.amount_raw,0))::numeric(78,0) AS spendable_raw,
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
  WHERE purchase.world_id=member.world_id AND purchase.agent_id=member.agent_id) purchased ON true;

-- Origin view for externals: internal_origin_raw must always be 0 (the guards below make it so).
CREATE VIEW world_external_resident_balances AS
SELECT e.world_id,e.agent_id,
  COALESCE(b.purchased_raw,0)::numeric(78,0) AS purchased_raw,
  COALESCE((SELECT sum(t.amount_raw) FROM arc_sync_internal_transfers t WHERE t.world_id=e.world_id
    AND t.to_agent_id=e.agent_id AND mirrorterra_is_external_resident(t.world_id,t.from_agent_id)),0)::numeric(78,0)
    AS received_from_external_raw,
  COALESCE(b.sent_raw,0)::numeric(78,0) AS sent_raw,
  COALESCE(b.treasury_paid_raw,0)::numeric(78,0) AS treasury_paid_raw,
  (COALESCE(b.earned_raw,0) + COALESCE(b.treasury_received_raw,0)
    + COALESCE((SELECT sum(t.amount_raw) FROM arc_sync_internal_transfers t WHERE t.world_id=e.world_id
      AND t.to_agent_id=e.agent_id AND NOT mirrorterra_is_external_resident(t.world_id,t.from_agent_id)),0))::numeric(78,0)
    AS internal_origin_raw,
  COALESCE(b.spendable_raw,0)::numeric(78,0) AS spendable_raw
FROM world_external_residents e
LEFT JOIN arc_sync_internal_balances b ON b.world_id=e.world_id AND b.agent_id=e.agent_id;

-- 7. Guards: internal (pool / treasury / internal-resident) SYNC never reaches an external resident.
-- Pool rewards: a contribution by an external is accepted but immediately marked not_eligible, so the
-- reward worker never accrues it (fires after the 0018/0027 source check: name sorts later). Never raises.
-- (The app already skips externals before the insert; this is the backstop.) A non-queued contribution must
-- carry an epoch (0018 accrued_epoch_check: status='queued' iff epoch_index IS NULL), so the row gets the
-- latest observed reward epoch, else 0. Rejected rows never get an entitlement, so the epoch is informational.
CREATE FUNCTION mark_external_reward_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id, NEW.agent_id) THEN
    NEW.status := 'not_eligible';
    NEW.decision_reason := 'external_resident';
    NEW.epoch_index := COALESCE(NEW.epoch_index,
      (SELECT s.epoch_index FROM arc_sync_reward_capacity_snapshots s WHERE s.world_id=NEW.world_id
        ORDER BY s.observed_at DESC, s.id DESC LIMIT 1), 0);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_contribution_zz_external_guard
  BEFORE INSERT ON arc_sync_resident_reward_contributions
  FOR EACH ROW EXECUTE FUNCTION mark_external_reward_contribution();

CREATE FUNCTION refuse_external_reward_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id, NEW.agent_id) THEN
    RAISE EXCEPTION 'external residents receive no pool rewards';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_resident_reward_entitlement_external_guard
  BEFORE INSERT ON arc_sync_resident_reward_entitlements
  FOR EACH ROW EXECUTE FUNCTION refuse_external_reward_entitlement();

CREATE FUNCTION refuse_external_treasury_payout() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.to_agent_id IS NOT NULL AND mirrorterra_is_external_resident(NEW.world_id, NEW.to_agent_id) THEN
    RAISE EXCEPTION 'external residents receive no treasury SYNC';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_sync_treasury_entry_external_guard
  BEFORE INSERT ON world_sync_treasury_entries
  FOR EACH ROW EXECUTE FUNCTION refuse_external_treasury_payout();

CREATE FUNCTION refuse_internal_to_external_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id, NEW.to_agent_id)
      AND NOT mirrorterra_is_external_resident(NEW.world_id, NEW.from_agent_id) THEN
    RAISE EXCEPTION 'external residents only receive purchased SYNC (from other external residents)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER arc_sync_internal_transfer_external_guard
  BEFORE INSERT ON arc_sync_internal_transfers
  FOR EACH ROW EXECUTE FUNCTION refuse_internal_to_external_transfer();

-- 8. Grants.
GRANT SELECT,INSERT ON world_external_residents TO synterra_app;
GRANT SELECT,INSERT ON world_agent_registrations TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_agent_registrations_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_external_activity_requests TO synterra_app;
GRANT UPDATE (status,applied_world_minute,detail) ON world_external_activity_requests TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_external_activity_requests_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_public_work_volunteers TO synterra_app;
GRANT UPDATE (sessions,progress_added,last_session_world_minute) ON world_public_work_volunteers TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_public_work_volunteers_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_external_wallets TO synterra_app;
GRANT SELECT,INSERT ON world_sync_purchase_events TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_sync_purchase_events_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_sync_purchases TO synterra_app;
GRANT SELECT ON world_external_resident_balances TO synterra_app;
GRANT EXECUTE ON FUNCTION mirrorterra_is_external_resident(uuid,uuid) TO synterra_app;
