-- MirrorTerra council2: fast treasury recirculation and competition between residents (additive).
-- Internal ledger only: nothing here touches the chain, the Genesis reserve, the operating pool,
-- arc_sync_payout_outbox, ledger postings, or any payout/commit gate. No table, column, view or
-- constraint of 0028 is dropped, so the 0028 release (rollback target) keeps working unchanged.
--  * validate_world_sync_treasury_entry() is re-created WITHOUT the governor's 50 SYNC daily
--    discretionary ceiling (user direction 2026-10-20: no caps). Every other rule is kept verbatim:
--    append-only, a resident payer never goes below its spendable balance (same advisory lock as
--    resident transfers), and the treasury never goes below zero (treasury lock).
--  * world_treasury_contests: competitive, treasury-escrowed contests. A bounty is won WHOLE by the
--    first resident to produce qualifying work ('first') or by the best quality within its window
--    ('best'); a contract goes to the lowest bidder ('lowest_bid') and is paid on delivery. The award
--    itself is a normal treasury entry, so the trigger above still refuses any overdraft.
--  * world_council_runtime.prize_output_cursor (added column): outputs after it compete for the next
--    immediate quality prize, so unclaimed bounty money never sits idle.
--  * world_business_sync_prices: an owner's competitive SYNC price for one service, as a multiplier of
--    the (council-adjusted) base price, bounded 0.5x-2x like the council price lever.

CREATE OR REPLACE FUNCTION validate_world_sync_treasury_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  available numeric;
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
    -- council2: no daily discretionary ceiling. The treasury balance is the only bound.
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE world_treasury_contests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES arc_sync_tokenomics_deployments(world_id) ON DELETE RESTRICT,
  contest_type text NOT NULL CHECK (contest_type IN ('bounty','contract')),
  win_rule text NOT NULL CHECK (win_rule IN ('first','best','lowest_bid')),
  drive text NOT NULL CHECK (drive IN ('survival','security','belonging','esteem','curiosity','creation','mastery','contribution')),
  reward_raw numeric(78,0) NOT NULL CHECK (reward_raw > 0),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  posted_by text NOT NULL CHECK (posted_by IN ('governor_cognition','governor_fallback')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','awarded','expired')),
  posted_world_day bigint NOT NULL CHECK (posted_world_day >= 0),
  posted_world_minute bigint NOT NULL CHECK (posted_world_minute >= 0),
  window_closes_world_minute bigint NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  bids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(bids)='array'),
  contractor_agent_id uuid,
  contract_price_raw numeric(78,0),
  winner_agent_id uuid,
  winning_output_id bigint,
  winning_quality smallint,
  awarded_raw numeric(78,0) CHECK (awarded_raw IS NULL OR awarded_raw > 0),
  awarded_world_minute bigint,
  treasury_entry_id uuid REFERENCES world_sync_treasury_entries(id) ON DELETE RESTRICT,
  UNIQUE (world_id,contest_type,drive,posted_world_minute),
  CHECK (window_closes_world_minute > posted_world_minute),
  CHECK ((contest_type='contract') = (win_rule='lowest_bid')),
  CHECK (contest_type<>'contract' OR (contractor_agent_id IS NOT NULL AND contract_price_raw IS NOT NULL
    AND contract_price_raw > 0 AND contract_price_raw <= reward_raw)),
  CHECK (contest_type<>'bounty' OR (contractor_agent_id IS NULL AND contract_price_raw IS NULL)),
  CHECK ((status='awarded') = (winner_agent_id IS NOT NULL AND awarded_raw IS NOT NULL)),
  CHECK (awarded_raw IS NULL OR awarded_raw <= reward_raw),
  CHECK (winner_agent_id IS NULL OR contractor_agent_id IS NULL OR winner_agent_id=contractor_agent_id),
  FOREIGN KEY (world_id,contractor_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,winner_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_treasury_contests_open_idx ON world_treasury_contests(world_id,status,drive);
CREATE INDEX world_treasury_contests_recent_idx ON world_treasury_contests(world_id,posted_world_minute DESC);

-- Contest terms are immutable; status moves open -> awarded/expired only; never deleted.
CREATE FUNCTION validate_world_treasury_contest_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Treasury contests are never deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.contest_type<>OLD.contest_type OR NEW.win_rule<>OLD.win_rule
      OR NEW.drive<>OLD.drive OR NEW.reward_raw<>OLD.reward_raw OR NEW.reason<>OLD.reason OR NEW.posted_by<>OLD.posted_by
      OR NEW.posted_world_minute<>OLD.posted_world_minute OR NEW.window_closes_world_minute<>OLD.window_closes_world_minute
      OR NEW.posted_at<>OLD.posted_at OR NEW.bids<>OLD.bids
      OR NEW.contractor_agent_id IS DISTINCT FROM OLD.contractor_agent_id
      OR NEW.contract_price_raw IS DISTINCT FROM OLD.contract_price_raw THEN
    RAISE EXCEPTION 'Treasury contest terms are immutable';
  END IF;
  IF OLD.status<>'open' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Treasury contest % is final', OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_treasury_contest_update_check
  BEFORE UPDATE OR DELETE ON world_treasury_contests
  FOR EACH ROW EXECUTE FUNCTION validate_world_treasury_contest_update();

CREATE TABLE world_business_sync_prices (
  world_id uuid NOT NULL,
  service_id uuid NOT NULL REFERENCES world_business_services(id) ON DELETE CASCADE,
  owner_agent_id uuid NOT NULL,
  price_milli integer NOT NULL CHECK (price_milli BETWEEN 500 AND 2000),
  previous_milli integer CHECK (previous_milli IS NULL OR previous_milli BETWEEN 500 AND 2000),
  set_by text NOT NULL CHECK (set_by IN ('owner_cognition','owner_heuristic')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,service_id),
  FOREIGN KEY (world_id,owner_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);

-- Quality-prize cursor: outputs after this id are eligible for the next immediate prize.
ALTER TABLE world_council_runtime ADD COLUMN prize_output_cursor bigint CHECK (prize_output_cursor IS NULL OR prize_output_cursor >= 0);

GRANT SELECT,INSERT ON world_treasury_contests TO synterra_app;
GRANT UPDATE (status,winner_agent_id,winning_output_id,winning_quality,awarded_raw,awarded_world_minute,treasury_entry_id)
  ON world_treasury_contests TO synterra_app;
GRANT SELECT,INSERT ON world_business_sync_prices TO synterra_app;
GRANT UPDATE (prize_output_cursor) ON world_council_runtime TO synterra_app;
GRANT UPDATE (owner_agent_id,price_milli,previous_milli,set_by,reason,updated_world_minute,updated_at)
  ON world_business_sync_prices TO synterra_app;
