-- Admit model-authored goal projections without changing historical rows.
ALTER TABLE world_agent_goals DROP CONSTRAINT world_agent_goals_source_check;
ALTER TABLE world_agent_goals ADD CONSTRAINT world_agent_goals_source_check
  CHECK (source IN ('seed','experience','memory','relationship','opportunity',
    'strategy','self_generated','stagnation','model'));
