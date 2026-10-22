-- growth1 (user decision 2026-10-21): public works become places residents really use; new building
-- kinds, unbounded expansion with diminishing returns, wear and treasury-paid repair contracts, and outer
-- districts that unlock from measured use. Every commission is justified by measured resident demand.
-- Additive only: four new tables, their guard triggers and grants. No existing table, column,
-- constraint, trigger, function, view or grant is changed or dropped. The rollback release
-- (bea9d24-external1b) never reads these tables. No money table is added: payments still flow only
-- through world_sync_treasury_entries (kind 'public_works') with every 0028/0030/0031 guard unchanged.

-- What a public work really is and why it was commissioned (measured demand). New kinds are stored in
-- world_public_works under the closest legacy kind; expansions and repairs are kind 'expansion' with a
-- target. Immutable once written.
CREATE TABLE world_public_work_meta (
  work_id uuid PRIMARY KEY REFERENCES world_public_works(id) ON DELETE RESTRICT,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  building_type text NOT NULL CHECK (building_type IN ('road','bridge','park','market_hall','clinic','school',
    'public_building','library','hospital','workshop','harbor','apartment')),
  work_type text NOT NULL CHECK (work_type IN ('build','expand','repair')),
  target_level integer CHECK (target_level IS NULL OR target_level >= 1),
  district integer CHECK (district IS NULL OR district >= 1),
  demand jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(demand)='object'),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_public_work_meta_type_idx ON world_public_work_meta(world_id,work_type,building_type);
CREATE FUNCTION refuse_world_public_work_meta_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Public work metadata is immutable'; END $$;
CREATE TRIGGER world_public_work_meta_immutable
  BEFORE UPDATE OR DELETE ON world_public_work_meta
  FOR EACH ROW EXECUTE FUNCTION refuse_world_public_work_meta_change();

-- Condition of a built facility (0-100). Wear lowers it; it rises only through a completed repair
-- (repairs + 1). Use and repair counters only grow. Never deleted.
CREATE TABLE world_public_work_conditions (
  work_id uuid PRIMARY KEY REFERENCES world_public_works(id) ON DELETE RESTRICT,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  condition numeric(6,2) NOT NULL DEFAULT 100 CHECK (condition >= 0 AND condition <= 100),
  uses_total bigint NOT NULL DEFAULT 0 CHECK (uses_total >= 0),
  wear_world_minute bigint NOT NULL CHECK (wear_world_minute >= 0),
  repairs integer NOT NULL DEFAULT 0 CHECK (repairs >= 0),
  last_repair_world_minute bigint,
  initial_condition numeric(6,2) NOT NULL DEFAULT 100 CHECK (initial_condition >= 0 AND initial_condition <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_public_work_conditions_world_idx ON world_public_work_conditions(world_id,condition);
CREATE FUNCTION validate_world_public_work_condition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Public work conditions are never deleted'; END IF;
  IF NEW.work_id<>OLD.work_id OR NEW.world_id<>OLD.world_id OR NEW.initial_condition<>OLD.initial_condition THEN
    RAISE EXCEPTION 'Public work condition identity is immutable';
  END IF;
  IF NEW.uses_total<OLD.uses_total OR NEW.repairs<OLD.repairs OR NEW.wear_world_minute<OLD.wear_world_minute THEN
    RAISE EXCEPTION 'Public work use, repair and wear counters only grow';
  END IF;
  IF NEW.condition>OLD.condition AND NEW.repairs<>OLD.repairs+1 THEN
    RAISE EXCEPTION 'Public work condition rises only through a completed repair';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER world_public_work_condition_check
  BEFORE UPDATE OR DELETE ON world_public_work_conditions
  FOR EACH ROW EXECUTE FUNCTION validate_world_public_work_condition();

-- One row per real use of a public building: who, which building, what for, when and what it did.
-- Append-only.
CREATE TABLE world_public_work_uses (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  work_id uuid NOT NULL REFERENCES world_public_works(id) ON DELETE RESTRICT,
  scene_id uuid REFERENCES world_scenes(id) ON DELETE SET NULL,
  agent_id uuid NOT NULL,
  building_type text NOT NULL CHECK (char_length(building_type) BETWEEN 3 AND 40),
  activity text NOT NULL CHECK (activity ~ '^[a-z_]{2,40}$'),
  use_kind text NOT NULL CHECK (use_kind IN ('care','learn','leisure','social','market','trade','craft','housing')),
  external boolean NOT NULL DEFAULT false,
  world_minute bigint NOT NULL CHECK (world_minute >= 0),
  effect jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(effect)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_public_work_uses_work_idx ON world_public_work_uses(world_id,work_id,world_minute);
CREATE INDEX world_public_work_uses_minute_idx ON world_public_work_uses(world_id,world_minute);
CREATE INDEX world_public_work_uses_agent_idx ON world_public_work_uses(world_id,agent_id,world_minute);
CREATE FUNCTION refuse_world_public_work_use_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Public work uses are append-only'; END $$;
CREATE TRIGGER world_public_work_use_immutable
  BEFORE UPDATE OR DELETE ON world_public_work_uses
  FOR EACH ROW EXECUTE FUNCTION refuse_world_public_work_use_change();

-- Outer districts unlocked by measured building and usage thresholds. Append-only.
CREATE TABLE world_growth_districts (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  district integer NOT NULL CHECK (district >= 2),
  unlocked_world_minute bigint NOT NULL CHECK (unlocked_world_minute >= 0),
  scene_id uuid REFERENCES world_scenes(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
  demand jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(demand)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,district)
);
CREATE FUNCTION refuse_world_growth_district_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Growth districts are append-only'; END $$;
CREATE TRIGGER world_growth_district_immutable
  BEFORE UPDATE OR DELETE ON world_growth_districts
  FOR EACH ROW EXECUTE FUNCTION refuse_world_growth_district_change();

GRANT SELECT,INSERT ON world_public_work_meta TO synterra_app;
GRANT SELECT,INSERT ON world_public_work_conditions TO synterra_app;
GRANT UPDATE (condition,uses_total,wear_world_minute,repairs,last_repair_world_minute,updated_at)
  ON world_public_work_conditions TO synterra_app;
GRANT SELECT,INSERT ON world_public_work_uses TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_public_work_uses_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_growth_districts TO synterra_app;
