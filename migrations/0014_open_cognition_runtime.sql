-- Persist non-sensitive per-call token and execution telemetry.
-- Prompts, provider responses and private reasoning are intentionally excluded.
ALTER TABLE world_agent_cognition_state
  ADD COLUMN last_context_event_id bigint NOT NULL DEFAULT 0 CHECK (last_context_event_id >= 0),
  ADD COLUMN last_context_tool_sequence bigint NOT NULL DEFAULT 0
    CHECK (last_context_tool_sequence >= 0);
-- Tool attempt ids are UUIDs, so they cannot serve as ordered delta cursors.
-- Add a database-owned monotonic sequence while preserving the public UUID key.
ALTER TABLE world_agent_cognition_tool_attempts
  ADD COLUMN cognition_sequence bigserial UNIQUE CHECK (cognition_sequence > 0);
UPDATE world_agent_cognition_state state SET last_context_event_id=COALESCE((
  SELECT max(event.id) FROM world_events event
  WHERE event.world_id=state.world_id AND event.actor_id=state.agent_id),0);
UPDATE world_agent_cognition_state state SET last_context_tool_sequence=COALESCE((
  SELECT COALESCE(min(attempt.cognition_sequence) FILTER (WHERE attempt.status IN ('requested','running'))-1,
    max(attempt.cognition_sequence),0) FROM world_agent_cognition_tool_attempts attempt
  WHERE attempt.world_id=state.world_id AND attempt.agent_id=state.agent_id),0);

CREATE TABLE world_agent_cognition_model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  tier text NOT NULL CHECK (tier IN ('haiku','sonnet','opus')),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 160),
  trigger text NOT NULL CHECK (char_length(trigger) BETWEEN 1 AND 120),
  goal_id text,
  plan_id text,
  step_id text,
  status text NOT NULL CHECK (status IN ('started','succeeded','failed','cached')),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cache_hit boolean NOT NULL DEFAULT false,
  memory_candidates integer CHECK (memory_candidates IS NULL OR memory_candidates >= 0),
  memory_prefiltered integer CHECK (memory_prefiltered IS NULL OR memory_prefiltered >= 0),
  memory_selected integer CHECK (memory_selected IS NULL OR memory_selected >= 0),
  grounding_result text CHECK (grounding_result IS NULL OR char_length(grounding_result) <= 80),
  execution_result text CHECK (execution_result IS NULL OR char_length(execution_result) <= 80),
  failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_agent_cognition_model_calls_recent_idx
  ON world_agent_cognition_model_calls(world_id,agent_id,created_at DESC,id);
CREATE INDEX world_agent_cognition_model_calls_correlation_idx
  ON world_agent_cognition_model_calls(world_id,correlation_id);

GRANT SELECT,INSERT,UPDATE ON world_agent_cognition_model_calls TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_agent_cognition_tool_attempts_cognition_sequence_seq TO synterra_app;
