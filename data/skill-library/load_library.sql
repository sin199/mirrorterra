\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE skill_stage (skill_id text, tier smallint, parent_id text, name text, actions text[], source_element text) ON COMMIT DROP;
\copy skill_stage FROM '/root/skill-library.tsv' WITH (FORMAT text)
INSERT INTO world_skill_library(skill_id,tier,parent_id,name,actions,source_element)
  SELECT skill_id,tier,parent_id,name,actions,source_element FROM skill_stage ORDER BY tier
  ON CONFLICT (skill_id) DO NOTHING;
SELECT tier, count(*) FROM world_skill_library GROUP BY tier ORDER BY tier;
COMMIT;
