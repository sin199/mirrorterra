-- Real-world skill library (O*NET 31.0, CC BY 4.0) and per-resident skill progress.
-- Additive only. Library rows are loaded separately as data; residents only gain
-- world-internal progress from completed world actions.
CREATE TABLE world_skill_library (
  skill_id text PRIMARY KEY CHECK (skill_id ~ '^[a-z]+:[a-z]+:[A-Za-z0-9.]+$'),
  tier smallint NOT NULL CHECK (tier BETWEEN 1 AND 4),
  parent_id text REFERENCES world_skill_library(skill_id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 240),
  actions text[] NOT NULL CHECK (cardinality(actions) >= 1
    AND actions <@ ARRAY['learn','work','cooperate','socialize']::text[]),
  source_element text NOT NULL,
  source text NOT NULL DEFAULT 'onet-31.0',
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', name)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_skill_library_parent_idx ON world_skill_library(parent_id);
CREATE INDEX world_skill_library_actions_idx ON world_skill_library USING gin(actions);
CREATE INDEX world_skill_library_search_idx ON world_skill_library USING gin(search);

CREATE TABLE world_agent_library_skills (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  skill_id text NOT NULL REFERENCES world_skill_library(skill_id),
  status text NOT NULL DEFAULT 'learning' CHECK (status IN ('learning','mastered')),
  xp numeric(10,2) NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level smallint NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 10),
  practice_count integer NOT NULL DEFAULT 0 CHECK (practice_count >= 0),
  last_action text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_practiced_at timestamptz,
  mastered_at timestamptz,
  PRIMARY KEY (world_id,agent_id,skill_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_agent_library_skills_active_idx
  ON world_agent_library_skills(world_id,agent_id,status,last_practiced_at DESC);

GRANT SELECT ON world_skill_library TO synterra_app;
GRANT SELECT,INSERT,UPDATE ON world_agent_library_skills TO synterra_app;
