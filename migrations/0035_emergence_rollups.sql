-- Rebuildable observation data only. Raw events and World state are unchanged.
CREATE TABLE world_emergence_rollup_state (
  world_id uuid PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
  start_world_minute bigint NOT NULL CHECK (start_world_minute >= 0 AND start_world_minute % 60 = 0),
  through_world_minute bigint NOT NULL CHECK (through_world_minute >= start_world_minute
    AND through_world_minute % 60 = 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE world_emergence_hour_rollups (
  world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  bucket_world_minute bigint NOT NULL CHECK (bucket_world_minute >= 0 AND bucket_world_minute % 60 = 0),
  system text NOT NULL,
  stage text NOT NULL,
  action_key text NOT NULL,
  action_is_null boolean NOT NULL,
  reason_code text NOT NULL,
  event_count bigint NOT NULL CHECK (event_count > 0),
  PRIMARY KEY(world_id,bucket_world_minute,system,stage,action_key,action_is_null,reason_code),
  CHECK (NOT action_is_null OR action_key='')
);
GRANT SELECT,INSERT,UPDATE ON world_emergence_rollup_state,world_emergence_hour_rollups TO synterra_app;
GRANT DELETE ON world_emergence_hour_rollups TO synterra_app;
