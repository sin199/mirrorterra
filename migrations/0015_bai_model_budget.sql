-- One service-wide B.AI admission ledger. No World or resident history is rewritten.
CREATE TABLE bai_model_budget_guard (
  id smallint PRIMARY KEY CHECK (id = 1),
  active_call_id uuid,
  active_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bai_model_budget_guard(id) VALUES(1);

CREATE TABLE bai_model_budget_calls (
  id uuid PRIMARY KEY,
  world_id uuid,
  agent_id uuid,
  source text NOT NULL CHECK (source IN
    ('openCognition','memorySelection','modelAnalysis','currencyGenesisAuthoring')),
  tier text NOT NULL CHECK (tier IN ('haiku','sonnet','opus','other')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','succeeded','failed','blocked')),
  request_bytes bigint NOT NULL CHECK (request_bytes >= 0),
  estimated_input_tokens bigint NOT NULL CHECK (estimated_input_tokens >= 0),
  max_output_tokens bigint NOT NULL CHECK (max_output_tokens >= 0),
  reserved_cost_nano_usd bigint NOT NULL CHECK (reserved_cost_nano_usd >= 0),
  effective_cost_nano_usd bigint NOT NULL CHECK (effective_cost_nano_usd >= 0),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  provider_cost_nano_usd bigint CHECK (provider_cost_nano_usd IS NULL OR provider_cost_nano_usd >= 0),
  cost_source text NOT NULL CHECK (cost_source IN ('reservation','usage_priced','provider_reported','blocked')),
  failure_code text,
  rolling24h_cost_nano_usd bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX bai_model_budget_calls_recent_idx ON bai_model_budget_calls(created_at DESC,id);
CREATE INDEX bai_model_budget_calls_source_recent_idx ON bai_model_budget_calls(source,created_at DESC);
GRANT SELECT,UPDATE ON bai_model_budget_guard TO synterra_app;
GRANT SELECT,INSERT,UPDATE ON bai_model_budget_calls TO synterra_app;

ALTER TABLE world_agent_cognition_state
  ADD COLUMN next_scheduled_at timestamptz,
  ADD COLUMN last_scheduled_at timestamptz,
  ADD COLUMN last_material_fingerprint text,
  ADD COLUMN pending_material_fingerprint text,
  ADD COLUMN budget_deferred_until timestamptz,
  ADD COLUMN memory_selection_cache jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(memory_selection_cache) = 'object');
