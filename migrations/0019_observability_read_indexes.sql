-- Additive indexes for bounded observer reads. No World state is rewritten.
CREATE INDEX world_history_observer_recent_idx
  ON world_history(world_id,created_at DESC,id DESC);
CREATE INDEX world_history_observer_agent_idx
  ON world_history(world_id,actor_agent_id,created_at DESC,id DESC);
CREATE INDEX world_capability_uses_observer_recent_idx
  ON world_capability_uses(world_id,created_at DESC,id DESC);
CREATE INDEX world_cognition_tools_observer_recent_idx
  ON world_agent_cognition_tool_attempts(world_id,updated_at DESC,id DESC);
CREATE INDEX world_research_jobs_observer_recent_idx
  ON world_research_jobs(world_id,completed_at DESC,id DESC)
  WHERE status IN ('completed','failed','timed_out');
CREATE INDEX world_research_artifacts_observer_recent_idx
  ON world_research_artifacts(world_id,created_at DESC,id DESC);
