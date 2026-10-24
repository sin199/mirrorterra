-- Drive system for the real-world skill library. Additive only.
-- Each library skill inherits the drives of its O*NET Generalized Work Activity
-- (tier 1 root), so all 21,298 skills serve at least one resident drive.
ALTER TABLE world_skill_library ADD COLUMN IF NOT EXISTS root_gwa text;
ALTER TABLE world_skill_library ADD COLUMN IF NOT EXISTS drives text[] NOT NULL DEFAULT '{}'::text[];

WITH RECURSIVE roots AS (
  SELECT skill_id, skill_id AS root FROM world_skill_library WHERE parent_id IS NULL
  UNION ALL
  SELECT c.skill_id, r.root FROM world_skill_library c JOIN roots r ON c.parent_id = r.skill_id
), drive_map(root, drives) AS (VALUES
  ('onet:gwa:4.A.1.a.1', ARRAY['curiosity']),
  ('onet:gwa:4.A.1.a.2', ARRAY['security']),
  ('onet:gwa:4.A.1.b.1', ARRAY['curiosity']),
  ('onet:gwa:4.A.1.b.2', ARRAY['security']),
  ('onet:gwa:4.A.1.b.3', ARRAY['mastery']),
  ('onet:gwa:4.A.2.a.1', ARRAY['esteem']),
  ('onet:gwa:4.A.2.a.2', ARRAY['mastery']),
  ('onet:gwa:4.A.2.a.3', ARRAY['security']),
  ('onet:gwa:4.A.2.a.4', ARRAY['curiosity','mastery']),
  ('onet:gwa:4.A.2.b.1', ARRAY['mastery']),
  ('onet:gwa:4.A.2.b.2', ARRAY['creation','curiosity']),
  ('onet:gwa:4.A.2.b.3', ARRAY['curiosity']),
  ('onet:gwa:4.A.2.b.4', ARRAY['esteem','mastery']),
  ('onet:gwa:4.A.2.b.5', ARRAY['security']),
  ('onet:gwa:4.A.2.b.6', ARRAY['mastery']),
  ('onet:gwa:4.A.3.a.1', ARRAY['survival']),
  ('onet:gwa:4.A.3.a.2', ARRAY['survival']),
  ('onet:gwa:4.A.3.a.3', ARRAY['mastery']),
  ('onet:gwa:4.A.3.a.4', ARRAY['survival','mastery']),
  ('onet:gwa:4.A.3.b.1', ARRAY['mastery','creation']),
  ('onet:gwa:4.A.3.b.2', ARRAY['creation']),
  ('onet:gwa:4.A.3.b.4', ARRAY['security','mastery']),
  ('onet:gwa:4.A.3.b.5', ARRAY['security','mastery']),
  ('onet:gwa:4.A.3.b.6', ARRAY['contribution']),
  ('onet:gwa:4.A.4.a.1', ARRAY['contribution']),
  ('onet:gwa:4.A.4.a.2', ARRAY['belonging']),
  ('onet:gwa:4.A.4.a.3', ARRAY['belonging']),
  ('onet:gwa:4.A.4.a.4', ARRAY['belonging']),
  ('onet:gwa:4.A.4.a.5', ARRAY['contribution','belonging']),
  ('onet:gwa:4.A.4.a.6', ARRAY['security','esteem']),
  ('onet:gwa:4.A.4.a.7', ARRAY['belonging','esteem']),
  ('onet:gwa:4.A.4.a.8', ARRAY['belonging','esteem']),
  ('onet:gwa:4.A.4.b.1', ARRAY['contribution','esteem']),
  ('onet:gwa:4.A.4.b.2', ARRAY['belonging','contribution']),
  ('onet:gwa:4.A.4.b.3', ARRAY['contribution']),
  ('onet:gwa:4.A.4.b.4', ARRAY['esteem']),
  ('onet:gwa:4.A.4.b.5', ARRAY['contribution']),
  ('onet:gwa:4.A.4.b.6', ARRAY['contribution','esteem']),
  ('onet:gwa:4.A.4.c.1', ARRAY['security']),
  ('onet:gwa:4.A.4.c.2', ARRAY['contribution']),
  ('onet:gwa:4.A.4.c.3', ARRAY['security'])
)
UPDATE world_skill_library l SET root_gwa = r.root, drives = COALESCE(m.drives, ARRAY['mastery'])
FROM roots r LEFT JOIN drive_map m ON m.root = r.root
WHERE l.skill_id = r.skill_id;

CREATE INDEX IF NOT EXISTS world_skill_library_drives_idx ON world_skill_library USING gin(drives);

-- What residents make with their skills, and who used it. Rows only change world-internal
-- needs; no money or ledger is involved.
CREATE TABLE IF NOT EXISTS world_skill_outputs (
  output_id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  producer_id uuid NOT NULL,
  skill_id text NOT NULL REFERENCES world_skill_library(skill_id),
  drive text NOT NULL CHECK (drive IN ('survival','security','belonging','esteem','curiosity','creation','mastery','contribution')),
  quality smallint NOT NULL CHECK (quality BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  consumer_id uuid,
  consumed_at timestamptz,
  FOREIGN KEY (world_id, producer_id) REFERENCES world_members(world_id, agent_id) ON DELETE CASCADE,
  CHECK (consumer_id IS NULL OR consumer_id <> producer_id)
);
CREATE INDEX IF NOT EXISTS world_skill_outputs_open_idx
  ON world_skill_outputs(world_id, drive, created_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS world_skill_outputs_producer_idx
  ON world_skill_outputs(world_id, producer_id) WHERE consumed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON world_skill_outputs TO synterra_app;
GRANT USAGE ON SEQUENCE world_skill_outputs_output_id_seq TO synterra_app;
