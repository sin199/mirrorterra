-- council3 (user direction 2026-10-20 14:23): residents decide with Luna, the treasury never hands
-- out money; treasury SYNC leaves only as payment for building the world (public works contracts).
-- Additive only: three new tables, one update-guard trigger, grants. No existing table, column,
-- constraint, trigger, function, view or grant is changed or dropped. Old releases never read
-- these tables, so they stay harmless to the rollback release.

-- A commissioned public work. Terms (kind, name, price) are immutable; the treasury pays the builder
-- per construction milestone (25/50/75/100%) and never more than the contract price.
CREATE TABLE world_public_works (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  project_key text NOT NULL CHECK (project_key ~ '^[a-z0-9_:.-]{3,80}$'),
  kind text NOT NULL CHECK (kind IN ('road','park','market_hall','clinic','school','bridge','public_building','expansion')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 3 AND 64),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  benefit jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(benefit)='object'),
  price_raw numeric(78,0) NOT NULL CHECK (price_raw > 0),
  required_skill text NOT NULL CHECK (required_skill IN ('engineering','research','social','trading')),
  target_work_id uuid REFERENCES world_public_works(id) ON DELETE RESTRICT,
  commissioned_by text NOT NULL CHECK (commissioned_by IN ('governor_llm','governor_fallback')),
  commissioned_world_minute bigint NOT NULL CHECK (commissioned_world_minute >= 0),
  bidding_closes_world_minute bigint NOT NULL,
  status text NOT NULL DEFAULT 'bidding' CHECK (status IN ('bidding','building','completed','cancelled')),
  builder_agent_id uuid,
  contract_price_raw numeric(78,0) CHECK (contract_price_raw IS NULL OR (contract_price_raw > 0 AND contract_price_raw <= price_raw)),
  awarded_world_minute bigint,
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  sessions integer NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  milestones_paid smallint NOT NULL DEFAULT 0 CHECK (milestones_paid BETWEEN 0 AND 4),
  paid_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (paid_raw >= 0 AND paid_raw <= price_raw),
  last_work_world_minute bigint,
  reassignments smallint NOT NULL DEFAULT 0 CHECK (reassignments >= 0),
  scene_id uuid REFERENCES world_scenes(id) ON DELETE SET NULL,
  completed_world_minute bigint,
  position jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(position)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,project_key),
  CHECK (bidding_closes_world_minute > commissioned_world_minute),
  CHECK (status NOT IN ('building','completed') OR (builder_agent_id IS NOT NULL AND contract_price_raw IS NOT NULL)),
  CHECK (contract_price_raw IS NULL OR paid_raw <= contract_price_raw),
  CHECK (status<>'completed' OR (progress=100 AND milestones_paid=4 AND completed_world_minute IS NOT NULL)),
  FOREIGN KEY (world_id,builder_agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE RESTRICT
);
CREATE INDEX world_public_works_status_idx ON world_public_works(world_id,status,commissioned_world_minute);
CREATE INDEX world_public_works_builder_idx ON world_public_works(world_id,builder_agent_id) WHERE status='building';

-- Terms immutable; status bidding -> building/cancelled, building -> building (reassigned)/completed/
-- cancelled; progress, sessions, milestones and paid SYNC only grow; never deleted.
CREATE FUNCTION validate_world_public_work_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Public works are never deleted'; END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.project_key<>OLD.project_key OR NEW.kind<>OLD.kind
      OR NEW.name<>OLD.name OR NEW.reason<>OLD.reason OR NEW.price_raw<>OLD.price_raw
      OR NEW.required_skill<>OLD.required_skill OR NEW.commissioned_by<>OLD.commissioned_by
      OR NEW.commissioned_world_minute<>OLD.commissioned_world_minute
      OR NEW.target_work_id IS DISTINCT FROM OLD.target_work_id THEN
    RAISE EXCEPTION 'Public work terms are immutable';
  END IF;
  IF OLD.status IN ('completed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Public work % is final', OLD.status;
  END IF;
  IF OLD.status='building' AND NEW.status='bidding' THEN RAISE EXCEPTION 'Public work cannot return to bidding'; END IF;
  IF NEW.progress<OLD.progress OR NEW.sessions<OLD.sessions OR NEW.milestones_paid<OLD.milestones_paid
      OR NEW.paid_raw<OLD.paid_raw OR NEW.reassignments<OLD.reassignments THEN
    RAISE EXCEPTION 'Public work progress and payments only grow';
  END IF;
  IF OLD.contract_price_raw IS NOT NULL AND NEW.contract_price_raw IS DISTINCT FROM OLD.contract_price_raw
      AND NEW.reassignments=OLD.reassignments THEN
    RAISE EXCEPTION 'Public work contract price changes only on reassignment';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER world_public_work_update_check
  BEFORE UPDATE OR DELETE ON world_public_works
  FOR EACH ROW EXECUTE FUNCTION validate_world_public_work_update();

-- Sealed bids on a public work (one per resident per work), from Luna or the heuristic.
CREATE TABLE world_public_work_bids (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  work_id uuid NOT NULL REFERENCES world_public_works(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  bid_raw numeric(78,0) NOT NULL CHECK (bid_raw > 0),
  skill_value numeric(8,2) NOT NULL DEFAULT 0,
  credible boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('llm','heuristic')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 240),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_public_work_bids_work_idx ON world_public_work_bids(work_id,bid_raw);

-- One row per council deliberation decision (Luna call or its deterministic fallback): who decided,
-- what (proposal / vote / commission / bid), the source (llm or fallback), latency and failure code.
CREATE TABLE world_council_deliberations (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_day integer NOT NULL CHECK (world_day >= 0),
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  phase text NOT NULL CHECK (phase IN ('propose','vote','commission','bid')),
  agent_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('llm','fallback')),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) <= 80),
  proposal_id uuid,
  work_id uuid,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(decision)='object'),
  reason text CHECK (reason IS NULL OR char_length(reason) <= 240),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_council_deliberations_day_idx ON world_council_deliberations(world_id,world_day,phase);
CREATE FUNCTION refuse_world_council_deliberation_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Council deliberations are append-only'; END $$;
CREATE TRIGGER world_council_deliberation_immutable
  BEFORE UPDATE OR DELETE ON world_council_deliberations
  FOR EACH ROW EXECUTE FUNCTION refuse_world_council_deliberation_change();

GRANT SELECT,INSERT ON world_public_works TO synterra_app;
GRANT UPDATE (status,builder_agent_id,contract_price_raw,awarded_world_minute,progress,sessions,milestones_paid,
  paid_raw,last_work_world_minute,reassignments,scene_id,completed_world_minute,position,updated_at)
  ON world_public_works TO synterra_app;
GRANT SELECT,INSERT ON world_public_work_bids TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_public_work_bids_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_council_deliberations TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_council_deliberations_id_seq TO synterra_app;
