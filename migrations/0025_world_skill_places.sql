-- Open-ended places. Additive: every existing scene type stays valid ('garden'...'data_center'),
-- and new lowercase slugs are allowed so places can grow from the skill library (no total cap).
-- The definition still names data_center, so schema.sql's legacy upgrade block leaves it alone.
ALTER TABLE world_scenes DROP CONSTRAINT IF EXISTS world_scenes_scene_type_check;
ALTER TABLE world_scenes ADD CONSTRAINT world_scenes_scene_type_check
  CHECK (scene_type IN ('garden','studio','library','cafe','workshop','observatory','commons','data_center')
    OR scene_type ~ '^[a-z][a-z_]{2,39}$');

CREATE INDEX IF NOT EXISTS world_scenes_skill_group_idx
  ON world_scenes(world_id, (features->>'skillGroup')) WHERE features ? 'skillGroup';
