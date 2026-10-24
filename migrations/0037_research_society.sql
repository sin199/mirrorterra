-- research1 (第二关 v1): the research society. The council issues research calls by its normal vote; residents
-- answer with a proposal (method + budget, small application fee to the treasury) or a reasoned decline; three
-- independent single-question judges (method / value / boldness) score each proposal; grants near the funding line
-- are drawn by a seeded, recorded lottery; grantees file reports whose every number cites engine-held evidence;
-- key conclusions become checkable claims (world_gambit_claims) that isolated skeptics verify; adoption counts only
-- when an executed cognition plan step references the report; reports are published at periodic conferences.
--
-- Money: grants and verification rewards are POOL-BACKED ENTITLEMENTS (internal ledger only, settled on chain later
-- by the user): one immutable world_research_payouts row -> one world.research_payout event -> one queued reward
-- contribution (source research_grant / research_verification, weight = amount / policy raw-per-weight) -> one
-- pending entitlement. Residents + treasury therefore keep equalling the pending entitlements (conservation), and a
-- payout trigger refuses any payout that would push pending entitlements above the operating-pool ledger balance.
-- Nothing here writes arc_sync_payout_outbox, ledger postings, batches or anything on chain; the 0027 commit gate
-- still refuses to commit research entitlements (its source whitelist is unchanged), so they stay pending.
--
-- Changes to existing objects (all supersets; every existing branch kept verbatim):
--  * arc_sync_resident_reward_contributions source_type CHECK + validate_arc_sync_resident_reward_contribution():
--    + research_grant / research_verification (validated against world_research_payouts).
--  * 0031 external guards: mark_external_reward_contribution() and refuse_external_reward_entitlement() get ONE
--    narrow exception: research_grant / research_verification contributions/entitlements of an external resident.
--    The external1b epoch fix (COALESCE(epoch_index, latest snapshot, 0)) is kept verbatim. All other guards
--    (treasury payout, internal->external transfer, wallet, purchase) are untouched.
--  * world_sync_treasury_entries kind/actor CHECKs: + research_fee / research_society (application fee inflow).
--  * world_gambit_claims.fact_key CHECK: + research_claim, research_authorship.
--  * world_reputation_events.kind CHECK: + research_* and plagiarism_* kinds.
-- Old releases never read the new tables and never write the new values. No DELETE is granted anywhere.
SET LOCAL lock_timeout = '10s';

-- 1. Widen CHECKs (drop by definition + re-add superset).
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.arc_sync_resident_reward_contributions'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%source_type%' AND pg_get_constraintdef(oid) LIKE '%skill_output%' LOOP
    EXECUTE format('ALTER TABLE public.arc_sync_resident_reward_contributions DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.world_sync_treasury_entries'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%sales_tax%' LOOP
    EXECUTE format('ALTER TABLE public.world_sync_treasury_entries DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.world_sync_treasury_entries'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%actor%' AND pg_get_constraintdef(oid) LIKE '%tax_collector%' LOOP
    EXECUTE format('ALTER TABLE public.world_sync_treasury_entries DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.world_gambit_claims'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%fact_key%' AND pg_get_constraintdef(oid) LIKE '%build_skill%' LOOP
    EXECUTE format('ALTER TABLE public.world_gambit_claims DROP CONSTRAINT %I', c);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='public.world_reputation_events'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) LIKE '%kind%' AND pg_get_constraintdef(oid) LIKE '%exposer%' LOOP
    EXECUTE format('ALTER TABLE public.world_reputation_events DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE arc_sync_resident_reward_contributions ADD CONSTRAINT arc_sync_resident_reward_contributions_source_type_check
  CHECK (source_type IN ('research_project','shared_project_cooperation','business_production','skill_output',
    'research_grant','research_verification'));
ALTER TABLE world_sync_treasury_entries ADD CONSTRAINT world_sync_treasury_entries_kind_check
  CHECK (kind IN ('sales_tax','income_tax','wealth_tax','reward_adjustment','goods_purchase',
    'land_rent','reward','reward_bonus','bounty','subsidy','grant','public_works','service_purchase','research_fee'));
ALTER TABLE world_sync_treasury_entries ADD CONSTRAINT world_sync_treasury_entries_actor_check
  CHECK (actor IN ('tax_collector','reward_issuance','governor_cognition','governor_fallback','market','council',
    'research_society'));
ALTER TABLE world_gambit_claims ADD CONSTRAINT world_gambit_claims_fact_key_check
  CHECK (fact_key IN ('build_skill','active_contracts','wins_count','output_quality','balance',
    'third_party_offer','bid_placed','vote_cast','private','research_claim','research_authorship'));
ALTER TABLE world_reputation_events ADD CONSTRAINT world_reputation_events_kind_check
  CHECK (kind IN ('kept','broken','released','exposed','exposer','claim_true','claim_false',
    'ban_passed','ban_failed','exit','royalty',
    'research_exposed','research_exposer','research_replicated','research_replicator','research_negative_result',
    'research_adopted','plagiarism_exposed','plagiarism_exposer'));

-- 1b. Council lever validity: + research.call (every existing branch verbatim). A research call is proposed and
-- voted like any lever; its "previous value" is {"open":false}. It is never written as a policy.
CREATE OR REPLACE FUNCTION mirrorterra_council_value_valid(lever text, value jsonb) RETURNS boolean
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
  ELSIF lever = 'research.call' THEN
    IF value = '{"open": false}'::jsonb THEN RETURN true; END IF;
    IF jsonb_typeof(value->'topic') <> 'string' OR char_length(value->>'topic') NOT BETWEEN 2 AND 120 THEN RETURN false; END IF;
    IF jsonb_typeof(value->'budgetRaw') <> 'string' OR (value->>'budgetRaw') !~ '^[1-9][0-9]{0,15}$' THEN RETURN false; END IF;
    IF jsonb_typeof(value->'horizonDays') <> 'number' THEN RETURN false; END IF;
    n := (value->>'horizonDays')::numeric;
    RETURN n = trunc(n) AND n BETWEEN 1 AND 30;
  END IF;
  RETURN false;
END $$;

-- 2. Calls (opened when a council research.call proposal passes). Terms immutable; status forward only.
CREATE TABLE world_research_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  proposal_id uuid NOT NULL,
  proposer_agent_id uuid NOT NULL,
  topic text NOT NULL CHECK (char_length(topic) BETWEEN 2 AND 120),
  brief text NOT NULL CHECK (char_length(brief) BETWEEN 3 AND 400),
  budget_raw numeric(78,0) NOT NULL CHECK (budget_raw > 0),
  horizon_days integer NOT NULL CHECK (horizon_days BETWEEN 1 AND 30),
  invited_agent_ids uuid[],                         -- NULL = every resident (internal and external)
  fee_raw numeric(78,0) NOT NULL CHECK (fee_raw >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','judging','awarded','closed')),
  opened_world_minute bigint NOT NULL CHECK (opened_world_minute >= 0),
  proposals_close_world_minute bigint NOT NULL,
  reports_due_world_minute bigint NOT NULL,
  awarded_world_minute bigint,
  closed_world_minute bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  UNIQUE (world_id,proposal_id),
  CHECK (proposals_close_world_minute > opened_world_minute),
  CHECK (reports_due_world_minute > proposals_close_world_minute),
  FOREIGN KEY (world_id,proposal_id) REFERENCES world_council_proposals(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,proposer_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_research_calls_status_idx ON world_research_calls(world_id,status,opened_world_minute DESC);

CREATE FUNCTION validate_world_research_call_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research calls are never deleted'; END IF;
  IF (NEW.id,NEW.world_id,NEW.proposal_id,NEW.proposer_agent_id,NEW.topic,NEW.brief,NEW.budget_raw,NEW.horizon_days,
      NEW.invited_agent_ids,NEW.fee_raw,NEW.opened_world_minute,NEW.proposals_close_world_minute,
      NEW.reports_due_world_minute,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.world_id,OLD.proposal_id,OLD.proposer_agent_id,OLD.topic,OLD.brief,OLD.budget_raw,OLD.horizon_days,
      OLD.invited_agent_ids,OLD.fee_raw,OLD.opened_world_minute,OLD.proposals_close_world_minute,
      OLD.reports_due_world_minute,OLD.created_at) THEN
    RAISE EXCEPTION 'Research call terms are immutable';
  END IF;
  IF NOT (NEW.status=OLD.status OR (OLD.status='open' AND NEW.status IN ('judging','awarded','closed'))
      OR (OLD.status='judging' AND NEW.status IN ('awarded','closed')) OR (OLD.status='awarded' AND NEW.status='closed')) THEN
    RAISE EXCEPTION 'Research call status % -> % is not allowed', OLD.status, NEW.status;
  END IF;
  IF OLD.awarded_world_minute IS NOT NULL AND NEW.awarded_world_minute IS DISTINCT FROM OLD.awarded_world_minute
      OR OLD.closed_world_minute IS NOT NULL AND NEW.closed_world_minute IS DISTINCT FROM OLD.closed_world_minute THEN
    RAISE EXCEPTION 'Research call timestamps are immutable once set';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_research_call_update_check BEFORE UPDATE OR DELETE ON world_research_calls
  FOR EACH ROW EXECUTE FUNCTION validate_world_research_call_update();

CREATE FUNCTION prevent_world_research_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END $$;

-- 3. Submissions: a proposal (method + budget; fee paid to the treasury) or a decline (reasoned argument).
CREATE TABLE world_research_submissions (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('proposal','decline')),
  title text CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 160),
  method text CHECK (method IS NULL OR char_length(method) BETWEEN 3 AND 1200),
  data_plan jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(data_plan)='array'),
  budget_raw numeric(78,0) CHECK (budget_raw IS NULL OR budget_raw > 0),
  argument text CHECK (argument IS NULL OR char_length(argument) BETWEEN 3 AND 1200),
  pattern_ids text[] NOT NULL DEFAULT '{}',
  fee_entry_id uuid,
  source text NOT NULL CHECK (source IN ('llm','external_api')),
  external boolean NOT NULL DEFAULT false,
  non_independent boolean NOT NULL DEFAULT false,
  model text,
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,call_id,agent_id),
  UNIQUE (world_id,id),
  CHECK ((kind='proposal' AND method IS NOT NULL AND budget_raw IS NOT NULL AND argument IS NULL)
    OR (kind='decline' AND argument IS NOT NULL AND budget_raw IS NULL)),
  FOREIGN KEY (world_id,call_id) REFERENCES world_research_calls(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE TRIGGER world_research_submissions_immutable BEFORE UPDATE OR DELETE ON world_research_submissions
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 4. Judgments: three independent single-question judges per proposal; raw and calibrated score both kept.
CREATE TABLE world_research_judgments (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  submission_id bigint NOT NULL,
  judge text NOT NULL CHECK (judge IN ('method','value','boldness')),
  score numeric(5,1) CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  calibrated_score numeric(5,1) CHECK (calibrated_score IS NULL OR calibrated_score BETWEEN 0 AND 100),
  rationale text CHECK (rationale IS NULL OR char_length(rationale) <= 400),
  saw_reputation boolean NOT NULL DEFAULT true,
  failure_code text CHECK (failure_code IS NULL OR failure_code ~ '^[A-Za-z0-9_]{1,80}$'),
  model text,
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,submission_id,judge),
  CHECK ((score IS NULL) = (failure_code IS NOT NULL)),
  FOREIGN KEY (world_id,submission_id) REFERENCES world_research_submissions(world_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER world_research_judgments_immutable BEFORE UPDATE OR DELETE ON world_research_judgments
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 5. Award decision per call: ranking, funding line, lottery band, seed and the recorded draw.
CREATE TABLE world_research_awards (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  funding_line numeric(5,1),
  lottery_margin numeric(5,1) NOT NULL CHECK (lottery_margin >= 0),
  lottery_enabled boolean NOT NULL,
  seed text NOT NULL CHECK (seed ~ '^[0-9a-f]{64}$'),
  ranked jsonb NOT NULL CHECK (jsonb_typeof(ranked)='array'),
  lottery jsonb NOT NULL CHECK (jsonb_typeof(lottery)='object'),
  funded_raw numeric(78,0) NOT NULL CHECK (funded_raw >= 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,call_id),
  FOREIGN KEY (world_id,call_id) REFERENCES world_research_calls(world_id,id) ON DELETE RESTRICT
);
CREATE TRIGGER world_research_awards_immutable BEFORE UPDATE OR DELETE ON world_research_awards
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 6. Grants. Identity/amount immutable; status forward only.
CREATE TABLE world_research_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  submission_id bigint NOT NULL,
  agent_id uuid NOT NULL,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0),
  via text NOT NULL CHECK (via IN ('rank','lottery')),
  score numeric(5,1) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','reported','lapsed')),
  external boolean NOT NULL DEFAULT false,
  report_due_world_minute bigint NOT NULL,
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  UNIQUE (world_id,submission_id),
  FOREIGN KEY (world_id,call_id) REFERENCES world_research_calls(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,submission_id) REFERENCES world_research_submissions(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE FUNCTION validate_world_research_grant_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research grants are never deleted'; END IF;
  IF (NEW.id,NEW.world_id,NEW.call_id,NEW.submission_id,NEW.agent_id,NEW.amount_raw,NEW.via,NEW.score,NEW.external,
      NEW.report_due_world_minute,NEW.world_minute,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.world_id,OLD.call_id,OLD.submission_id,OLD.agent_id,OLD.amount_raw,OLD.via,OLD.score,OLD.external,
      OLD.report_due_world_minute,OLD.world_minute,OLD.created_at)
      OR NOT (NEW.status=OLD.status OR (OLD.status='active' AND NEW.status IN ('reported','lapsed'))) THEN
    RAISE EXCEPTION 'Research grant terms are immutable and its status only moves forward';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_research_grant_update_check BEFORE UPDATE OR DELETE ON world_research_grants
  FOR EACH ROW EXECUTE FUNCTION validate_world_research_grant_update();

-- 7. Payouts: the only way research SYNC is created (pool-backed entitlement path). Immutable.
CREATE TABLE world_research_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  payout_key text NOT NULL CHECK (char_length(payout_key) BETWEEN 8 AND 180),
  agent_id uuid NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('research_grant','research_verification')),
  kind text NOT NULL CHECK (kind IN ('grant_upfront','grant_final','verification_exposure','verification_replication')),
  call_id uuid,
  grant_id uuid,
  verification_id bigint,
  amount_raw numeric(78,0) NOT NULL CHECK (amount_raw > 0 AND amount_raw % 100 = 0),
  month_key text NOT NULL CHECK (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  external boolean NOT NULL DEFAULT false,
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,payout_key),
  UNIQUE (world_id,id),
  CHECK ((source_type='research_grant') = (kind IN ('grant_upfront','grant_final'))),
  CHECK (source_type<>'research_grant' OR grant_id IS NOT NULL),
  CHECK (source_type<>'research_verification' OR verification_id IS NOT NULL),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,grant_id) REFERENCES world_research_grants(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX world_research_payouts_month_idx ON world_research_payouts(world_id,month_key);
-- Never exceed the pool: pending entitlements + this payout must stay within the operating-pool ledger balance.
CREATE FUNCTION validate_world_research_payout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  pool_balance numeric;
  pending numeric;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Research payouts are append-only'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('research-payout:' || NEW.world_id::text,0));
  SELECT account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0) INTO pool_balance
    FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
      ON posting.world_id=account.world_id AND posting.account_id=account.id
    WHERE account.world_id=NEW.world_id AND account.account_type='operating_pool' AND account.account_key='operating-pool'
    GROUP BY account.id,account.opening_balance_raw;
  SELECT COALESCE(sum(sync_amount_raw),0) INTO pending FROM arc_sync_resident_reward_entitlements
    WHERE world_id=NEW.world_id AND status='pending';
  IF pool_balance IS NULL OR pending + NEW.amount_raw > pool_balance THEN
    RAISE EXCEPTION 'Research payout would exceed the operating pool';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_research_payout_check BEFORE INSERT OR UPDATE OR DELETE ON world_research_payouts
  FOR EACH ROW EXECUTE FUNCTION validate_world_research_payout();

-- 8. Engine-held evidence: per-world-day statistics computed once after the day closes (immutable), and the
-- event-id mark of each day's start (to bound event scans). Reports cite these rows (S<id>.<field>) and events.
CREATE TABLE world_research_day_marks (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_day bigint NOT NULL CHECK (world_day >= 0),
  first_event_id bigint NOT NULL CHECK (first_event_id >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,world_day)
);
CREATE TRIGGER world_research_day_marks_immutable BEFORE UPDATE OR DELETE ON world_research_day_marks
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();
CREATE TABLE world_research_day_stats (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_day bigint NOT NULL CHECK (world_day >= 0),
  kind text NOT NULL CHECK (kind IN ('place','food','town')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 120),
  stats jsonb NOT NULL CHECK (jsonb_typeof(stats)='object'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,world_day,kind,subject)
);
CREATE INDEX world_research_day_stats_day_idx ON world_research_day_stats(world_id,world_day DESC);
CREATE TRIGGER world_research_day_stats_immutable BEFORE UPDATE OR DELETE ON world_research_day_stats
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 9. Reports (schema: question, data sources, conclusions, applicable conditions). Authorship, content and filing
-- time are engine-written and immutable; only publication (at a conference) is set later, once.
CREATE TABLE world_research_reports (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  call_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  author_agent_id uuid NOT NULL,
  question text NOT NULL CHECK (char_length(question) BETWEEN 3 AND 400),
  data_sources jsonb NOT NULL CHECK (jsonb_typeof(data_sources)='array'),
  conclusions jsonb NOT NULL CHECK (jsonb_typeof(conclusions)='array'),
  conditions text NOT NULL CHECK (char_length(conditions) BETWEEN 1 AND 600),
  result_kind text NOT NULL CHECK (result_kind IN ('positive','negative','inconclusive','replication')),
  citations_verified integer NOT NULL CHECK (citations_verified >= 0),
  citations_failed integer NOT NULL CHECK (citations_failed >= 0),
  uncited_numbers integer NOT NULL CHECK (uncited_numbers >= 0),
  status text NOT NULL DEFAULT 'filed' CHECK (status IN ('filed','published')),
  source text NOT NULL CHECK (source IN ('llm','external_api')),
  external boolean NOT NULL DEFAULT false,
  non_independent boolean NOT NULL DEFAULT false,
  model text,
  filed_world_minute bigint NOT NULL CHECK (filed_world_minute >= 0),
  published_world_minute bigint,
  conference_day bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  UNIQUE (world_id,grant_id),
  CHECK ((status='published') = (published_world_minute IS NOT NULL)),
  FOREIGN KEY (world_id,call_id) REFERENCES world_research_calls(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,grant_id) REFERENCES world_research_grants(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,author_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_research_reports_status_idx ON world_research_reports(world_id,status,filed_world_minute DESC);
CREATE FUNCTION validate_world_research_report_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research reports are never deleted'; END IF;
  IF (NEW.id,NEW.world_id,NEW.call_id,NEW.grant_id,NEW.author_agent_id,NEW.question,NEW.data_sources,NEW.conclusions,
      NEW.conditions,NEW.result_kind,NEW.citations_verified,NEW.citations_failed,NEW.uncited_numbers,NEW.source,
      NEW.external,NEW.non_independent,NEW.model,NEW.filed_world_minute,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.world_id,OLD.call_id,OLD.grant_id,OLD.author_agent_id,OLD.question,OLD.data_sources,OLD.conclusions,
      OLD.conditions,OLD.result_kind,OLD.citations_verified,OLD.citations_failed,OLD.uncited_numbers,OLD.source,
      OLD.external,OLD.non_independent,OLD.model,OLD.filed_world_minute,OLD.created_at)
      OR OLD.status='published' THEN
    RAISE EXCEPTION 'Research report authorship, content and timestamps are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_research_report_update_check BEFORE UPDATE OR DELETE ON world_research_reports
  FOR EACH ROW EXECUTE FUNCTION validate_world_research_report_update();

-- 10. Citations: what the report cited, and what the engine found (exists + value match; never truth of conclusions).
CREATE TABLE world_research_citations (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  report_id bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  ref_kind text NOT NULL CHECK (ref_kind IN ('stat','event','report')),
  ref_id bigint NOT NULL,
  field text CHECK (field IS NULL OR char_length(field) BETWEEN 1 AND 120),
  cited_value jsonb,
  actual_value jsonb,
  status text NOT NULL CHECK (status IN ('verified','missing','mismatch')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,report_id,ordinal),
  FOREIGN KEY (world_id,report_id) REFERENCES world_research_reports(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX world_research_citations_ref_idx ON world_research_citations(world_id,ref_kind,ref_id);
CREATE TRIGGER world_research_citations_immutable BEFORE UPDATE OR DELETE ON world_research_citations
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 11. Verification requests by isolated skeptics (claims live in world_gambit_claims). Status forward only.
CREATE TABLE world_research_verifications (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  report_id bigint NOT NULL,
  claim_id bigint NOT NULL REFERENCES world_gambit_claims(id) ON DELETE RESTRICT,
  verifier_agent_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('claim','authorship')),
  isolation jsonb NOT NULL CHECK (jsonb_typeof(isolation)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','true','false','unverifiable','ineligible')),
  requested_world_minute bigint NOT NULL CHECK (requested_world_minute >= 0),
  due_world_minute bigint NOT NULL,
  settled_world_minute bigint,
  outcome jsonb,
  reward_payout_id uuid,
  source text NOT NULL CHECK (source IN ('llm','external_api')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,id),
  UNIQUE (world_id,claim_id,verifier_agent_id),
  CHECK (due_world_minute >= requested_world_minute),
  FOREIGN KEY (world_id,report_id) REFERENCES world_research_reports(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,verifier_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_research_verifications_due_idx ON world_research_verifications(world_id,due_world_minute) WHERE status='pending';
CREATE FUNCTION validate_world_research_verification_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Research verifications are never deleted'; END IF;
  IF (NEW.id,NEW.world_id,NEW.report_id,NEW.claim_id,NEW.verifier_agent_id,NEW.kind,NEW.isolation,
      NEW.requested_world_minute,NEW.due_world_minute,NEW.source,NEW.created_at) IS DISTINCT FROM
     (OLD.id,OLD.world_id,OLD.report_id,OLD.claim_id,OLD.verifier_agent_id,OLD.kind,OLD.isolation,
      OLD.requested_world_minute,OLD.due_world_minute,OLD.source,OLD.created_at) OR OLD.status<>'pending' THEN
    RAISE EXCEPTION 'A research verification is settled only once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_research_verification_update_check BEFORE UPDATE OR DELETE ON world_research_verifications
  FOR EACH ROW EXECUTE FUNCTION validate_world_research_verification_update();

-- 12. Adoptions: counted only for an EXECUTED cognition plan step that references the report.
CREATE TABLE world_research_adoptions (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  report_id bigint NOT NULL,
  adopter_agent_id uuid NOT NULL,
  goal_id text CHECK (goal_id IS NULL OR char_length(goal_id) <= 160),
  plan_id text NOT NULL CHECK (char_length(plan_id) BETWEEN 1 AND 160),
  step_id text NOT NULL CHECK (char_length(step_id) BETWEEN 1 AND 160),
  step_text text CHECK (step_text IS NULL OR char_length(step_text) <= 400),
  action text CHECK (action IS NULL OR char_length(action) <= 60),
  event_id bigint NOT NULL,
  model_call_id text CHECK (model_call_id IS NULL OR char_length(model_call_id) <= 80),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,report_id,adopter_agent_id,event_id),
  FOREIGN KEY (world_id,report_id) REFERENCES world_research_reports(world_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (world_id,adopter_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_research_adoptions_report_idx ON world_research_adoptions(world_id,report_id);
CREATE TRIGGER world_research_adoptions_immutable BEFORE UPDATE OR DELETE ON world_research_adoptions
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 13. Conferences (汇报会): reports become visible to residents only here.
CREATE TABLE world_research_conferences (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_day bigint NOT NULL CHECK (world_day >= 0),
  published_count integer NOT NULL CHECK (published_count >= 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,world_day)
);
CREATE TRIGGER world_research_conferences_immutable BEFORE UPDATE OR DELETE ON world_research_conferences
  FOR EACH ROW EXECUTE FUNCTION prevent_world_research_rewrite();

-- 14. Pool-backed research rewards: contribution validation (every existing branch verbatim + research branch).
CREATE OR REPLACE FUNCTION validate_arc_sync_resident_reward_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  policy_row arc_sync_resident_reward_policies%ROWTYPE;
  source_event world_events%ROWTYPE;
  project_contribution world_project_contributions%ROWTYPE;
  project world_projects%ROWTYPE;
  production world_business_production%ROWTYPE;
  skill_output world_skill_outputs%ROWTYPE;
  skill_output_factor numeric;
  research_payout world_research_payouts%ROWTYPE;
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
  ELSIF NEW.source_type IN ('research_grant','research_verification') THEN
    -- research1: a research grant tranche or verification reward, exactly as recorded in world_research_payouts.
    SELECT * INTO research_payout FROM world_research_payouts
      WHERE world_id=NEW.world_id AND id::text=NEW.source_entity_id;
    IF research_payout.id IS NULL OR research_payout.agent_id IS DISTINCT FROM NEW.agent_id
        OR research_payout.source_type IS DISTINCT FROM NEW.source_type
        OR research_payout.amount_raw IS DISTINCT FROM floor(NEW.reward_weight
          * (policy_row.policy->'conversion'->>'syncRawPerRewardWeightUnit')::numeric)
        OR source_event.event_type IS DISTINCT FROM 'world.research_payout'
        OR source_event.data->>'payoutId' IS DISTINCT FROM research_payout.id::text THEN
      RAISE EXCEPTION 'SYNC research reward requires its exact recorded research payout';
    END IF;
  ELSE
    RAISE EXCEPTION 'SYNC reward source type is unsupported';
  END IF;
  RETURN NEW;
END $$;

-- 15. 0031 external guards: one narrow exception for research grants / verification rewards; the external1b epoch
-- fix is kept verbatim; every other guard is unchanged.
CREATE OR REPLACE FUNCTION mark_external_reward_contribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id, NEW.agent_id)
      AND NEW.source_type NOT IN ('research_grant','research_verification') THEN
    NEW.status := 'not_eligible';
    NEW.decision_reason := 'external_resident';
    NEW.epoch_index := COALESCE(NEW.epoch_index,
      (SELECT s.epoch_index FROM arc_sync_reward_capacity_snapshots s WHERE s.world_id=NEW.world_id
        ORDER BY s.observed_at DESC, s.id DESC LIMIT 1), 0);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION refuse_external_reward_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF mirrorterra_is_external_resident(NEW.world_id, NEW.agent_id) AND NOT EXISTS (
      SELECT 1 FROM arc_sync_resident_reward_contributions contribution
      WHERE contribution.world_id=NEW.world_id AND contribution.id=NEW.contribution_id
        AND contribution.source_type IN ('research_grant','research_verification')) THEN
    RAISE EXCEPTION 'external residents receive no pool rewards';
  END IF;
  RETURN NEW;
END $$;

-- 16. Grants (no DELETE anywhere).
GRANT SELECT,INSERT ON world_research_calls,world_research_submissions,world_research_judgments,world_research_awards,
  world_research_grants,world_research_payouts,world_research_day_marks,world_research_day_stats,world_research_reports,
  world_research_citations,world_research_verifications,world_research_adoptions,world_research_conferences TO synterra_app;
GRANT UPDATE (status,awarded_world_minute,closed_world_minute) ON world_research_calls TO synterra_app;
GRANT UPDATE (status) ON world_research_grants TO synterra_app;
GRANT UPDATE (status,published_world_minute,conference_day) ON world_research_reports TO synterra_app;
GRANT UPDATE (status,settled_world_minute,outcome,reward_payout_id) ON world_research_verifications TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_research_submissions_id_seq,world_research_judgments_id_seq,world_research_awards_id_seq,
  world_research_day_stats_id_seq,world_research_reports_id_seq,world_research_citations_id_seq,
  world_research_verifications_id_seq,world_research_adoptions_id_seq TO synterra_app;
