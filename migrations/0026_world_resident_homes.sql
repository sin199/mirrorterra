-- Residents build their own homes. Additive only: one row per resident who has started building.
CREATE TABLE IF NOT EXISTS world_resident_homes (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building','built')),
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  style smallint NOT NULL DEFAULT 0 CHECK (style BETWEEN 0 AND 63),
  sessions integer NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  started_world_minutes bigint NOT NULL DEFAULT 0,
  built_at timestamptz,
  built_world_minutes bigint,
  PRIMARY KEY (world_id, agent_id),
  FOREIGN KEY (world_id, agent_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE
);
GRANT SELECT, INSERT, UPDATE ON world_resident_homes TO synterra_app;
