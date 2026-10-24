-- island1 (user decisions 2026-10-24 14:13 CST): a ferry and a neighbouring resort island (Lantern Isle), built
-- up by the residents through the existing public-works path. Additive only: three new tables, their guard
-- triggers, indexes and grants. No existing table, column, constraint, trigger, function, view or grant is
-- changed or dropped. The rollback release (4cfa80c-observer2) never reads these tables.
-- Island works are stored like every growth1 kind: world_public_works.kind and world_public_work_meta.building_type
-- carry the closest legacy kind (pier/ferry -> road, resort/boardwalk -> park, island cafe -> public_building;
-- both CHECKs unchanged) and the real type is recorded here. No money table is added: builders are paid through
-- world_sync_treasury_entries (kind 'public_works') as before, and a ferry fare is one ordinary resident-to-resident
-- arc_sync_internal_transfers row (kind 'business_service_payment', unchanged CHECK, balance and external guards).
SET LOCAL lock_timeout = '10s';

-- 1. The real island type of a public work (immutable once written).
CREATE TABLE world_island_works (
  work_id uuid PRIMARY KEY REFERENCES world_public_works(id) ON DELETE RESTRICT,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  island_type text NOT NULL CHECK (island_type IN ('pier','ferry','resort','boardwalk','island_cafe')),
  phase text NOT NULL CHECK (phase IN ('pier','ferry','resort','cruise')),
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_island_works_world_idx ON world_island_works(world_id,island_type);
CREATE FUNCTION refuse_world_island_work_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Island work records are immutable'; END $$;
CREATE TRIGGER world_island_work_immutable
  BEFORE UPDATE OR DELETE ON world_island_works
  FOR EACH ROW EXECUTE FUNCTION refuse_world_island_work_change();

-- 2. Ferry trips: one row per booked round trip (out on one sailing, back on the next sailing's return leg).
-- The fare, when paid, is exactly one internal transfer from the passenger to the operator (checked below).
-- Identity, times and fare are immutable; status only moves forward (booked -> completed | missed).
CREATE TABLE world_ferry_trips (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  ferry_work_id uuid NOT NULL REFERENCES world_public_works(id) ON DELETE RESTRICT,
  operator_agent_id uuid,
  ferry_level integer NOT NULL CHECK (ferry_level BETWEEN 1 AND 3),
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 60),
  depart_world_minute bigint NOT NULL CHECK (depart_world_minute >= 0),
  arrive_island_world_minute bigint NOT NULL,
  return_sailing_world_minute bigint NOT NULL,
  return_depart_world_minute bigint NOT NULL,
  return_arrive_world_minute bigint NOT NULL,
  fare_raw numeric(78,0) NOT NULL DEFAULT 0 CHECK (fare_raw >= 0),
  transfer_id uuid,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','completed','missed')),
  booked_world_minute bigint NOT NULL CHECK (booked_world_minute >= 0),
  completed_world_minute bigint,
  effect jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(effect)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (arrive_island_world_minute > depart_world_minute AND return_depart_world_minute > arrive_island_world_minute
    AND return_arrive_world_minute > return_depart_world_minute AND return_sailing_world_minute > depart_world_minute),
  CHECK ((transfer_id IS NULL) = (fare_raw = 0)),
  UNIQUE (world_id,agent_id,depart_world_minute),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE,
  FOREIGN KEY (world_id,transfer_id) REFERENCES arc_sync_internal_transfers(world_id,id) ON DELETE RESTRICT
);
CREATE INDEX world_ferry_trips_depart_idx ON world_ferry_trips(world_id,depart_world_minute);
CREATE INDEX world_ferry_trips_return_idx ON world_ferry_trips(world_id,return_sailing_world_minute);
CREATE INDEX world_ferry_trips_agent_idx ON world_ferry_trips(world_id,agent_id,depart_world_minute);
CREATE FUNCTION validate_world_ferry_trip() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  transfer arc_sync_internal_transfers%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Ferry trips are never deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'booked' THEN RAISE EXCEPTION 'A ferry trip starts as booked'; END IF;
    IF NEW.transfer_id IS NOT NULL THEN
      SELECT * INTO transfer FROM arc_sync_internal_transfers WHERE world_id=NEW.world_id AND id=NEW.transfer_id;
      IF transfer.id IS NULL OR transfer.kind<>'business_service_payment' OR transfer.from_agent_id<>NEW.agent_id
          OR NEW.operator_agent_id IS NULL OR transfer.to_agent_id<>NEW.operator_agent_id OR transfer.amount_raw<>NEW.fare_raw THEN
        RAISE EXCEPTION 'A ferry fare must match its internal transfer (passenger to operator, same amount)';
      END IF;
      IF EXISTS (SELECT 1 FROM world_ferry_trips other WHERE other.world_id=NEW.world_id AND other.transfer_id=NEW.transfer_id) THEN
        RAISE EXCEPTION 'A fare transfer pays for one ferry trip only';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.world_id<>OLD.world_id OR NEW.agent_id<>OLD.agent_id OR NEW.ferry_work_id<>OLD.ferry_work_id
      OR NEW.operator_agent_id IS DISTINCT FROM OLD.operator_agent_id OR NEW.ferry_level<>OLD.ferry_level OR NEW.seats<>OLD.seats
      OR NEW.depart_world_minute<>OLD.depart_world_minute OR NEW.arrive_island_world_minute<>OLD.arrive_island_world_minute
      OR NEW.return_sailing_world_minute<>OLD.return_sailing_world_minute
      OR NEW.return_depart_world_minute<>OLD.return_depart_world_minute OR NEW.return_arrive_world_minute<>OLD.return_arrive_world_minute
      OR NEW.fare_raw<>OLD.fare_raw OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
      OR NEW.booked_world_minute<>OLD.booked_world_minute THEN
    RAISE EXCEPTION 'Ferry trip identity, times and fare are immutable';
  END IF;
  IF OLD.status<>'booked' AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'A finished ferry trip is final'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER world_ferry_trip_check
  BEFORE INSERT OR UPDATE OR DELETE ON world_ferry_trips
  FOR EACH ROW EXECUTE FUNCTION validate_world_ferry_trip();

-- 3. Hourly beach-cove use samples (the pier's demand signal: sustained use over two world days). Append-only.
CREATE TABLE world_island_demand_hours (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  world_hour bigint NOT NULL CHECK (world_hour >= 0),
  beach_sessions integer NOT NULL DEFAULT 0 CHECK (beach_sessions >= 0),
  beach_agents uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(beach_agents) <= 200),
  sampled_actions integer NOT NULL DEFAULT 0 CHECK (sampled_actions >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,world_hour)
);
CREATE FUNCTION refuse_world_island_demand_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Island demand samples are append-only'; END $$;
CREATE TRIGGER world_island_demand_immutable
  BEFORE UPDATE OR DELETE ON world_island_demand_hours
  FOR EACH ROW EXECUTE FUNCTION refuse_world_island_demand_change();

GRANT SELECT,INSERT ON world_island_works TO synterra_app;
GRANT SELECT,INSERT ON world_ferry_trips TO synterra_app;
GRANT UPDATE (status,completed_world_minute,effect) ON world_ferry_trips TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_ferry_trips_id_seq TO synterra_app;
GRANT SELECT,INSERT ON world_island_demand_hours TO synterra_app;
