-- Additive, non-content B.AI attribution. Historical rows deliberately remain unlinked.
ALTER TABLE bai_model_budget_calls
  ADD COLUMN correlation_id uuid,
  ADD COLUMN trigger text,
  ADD COLUMN goal_id text,
  ADD COLUMN plan_id text,
  ADD COLUMN step_id text,
  ADD COLUMN context_fingerprint text,
  ADD COLUMN material_fingerprint text,
  ADD COLUMN prompt_metrics_complete boolean,
  ADD COLUMN provider_request_id text,
  ADD COLUMN provider_response_id text,
  ADD COLUMN returned_model text,
  ADD COLUMN cache_read_tokens bigint CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  ADD COLUMN cache_write_tokens bigint CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  ADD COLUMN cached_input_tokens bigint CHECK (cached_input_tokens IS NULL OR cached_input_tokens >= 0),
  ADD COLUMN uncached_input_tokens bigint CHECK (uncached_input_tokens IS NULL OR uncached_input_tokens >= 0),
  ADD COLUMN application_status text,
  ADD COLUMN application_failure_code text;

ALTER TABLE world_agent_cognition_model_calls
  ADD COLUMN cognition_turn_id bigint REFERENCES world_agent_cognition_turns(id) ON DELETE SET NULL,
  ADD COLUMN context_fingerprint text,
  ADD COLUMN application_status text,
  ADD COLUMN application_failure_code text;
CREATE INDEX world_agent_cognition_model_calls_turn_idx
  ON world_agent_cognition_model_calls(cognition_turn_id) WHERE cognition_turn_id IS NOT NULL;

CREATE TABLE bai_model_prompt_sections (
  model_call_id uuid NOT NULL REFERENCES bai_model_budget_calls(id) ON DELETE CASCADE,
  section_name text NOT NULL,
  characters bigint NOT NULL CHECK (characters >= 0),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  estimated_tokens bigint NOT NULL CHECK (estimated_tokens >= 0),
  content_hash text,
  duplicate_hash text,
  duplicate_bytes bigint NOT NULL DEFAULT 0 CHECK (duplicate_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_call_id,section_name),
  CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  CHECK (duplicate_hash IS NULL OR duplicate_hash ~ '^[0-9a-f]{64}$')
);
GRANT SELECT,INSERT ON bai_model_prompt_sections TO synterra_app;

CREATE TABLE bai_model_call_effects (
  id bigserial PRIMARY KEY,
  model_call_id uuid NOT NULL REFERENCES bai_model_budget_calls(id) ON DELETE CASCADE,
  effect_type text NOT NULL,
  cognition_turn_id bigint REFERENCES world_agent_cognition_turns(id) ON DELETE SET NULL,
  goal_id text,
  plan_id text,
  step_id text,
  world_event_id bigint REFERENCES world_events(id) ON DELETE SET NULL,
  world_v7_event_id uuid REFERENCES world_v7_events(id) ON DELETE SET NULL,
  tool_attempt_id uuid REFERENCES world_agent_cognition_tool_attempts(id) ON DELETE SET NULL,
  execution_source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(model_call_id,effect_type,cognition_turn_id,world_event_id,tool_attempt_id)
);
CREATE INDEX bai_model_call_effects_call_idx ON bai_model_call_effects(model_call_id,id);
CREATE INDEX bai_model_call_effects_event_idx ON bai_model_call_effects(world_event_id)
  WHERE world_event_id IS NOT NULL;
GRANT SELECT,INSERT ON bai_model_call_effects TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE bai_model_call_effects_id_seq TO synterra_app;
