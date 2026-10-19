-- One durable, content-free decision per claimed cognition gate.
CREATE TABLE world_agent_cognition_gate_decisions (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  correlation_id uuid NOT NULL UNIQUE,
  trigger_reason text NOT NULL,
  plan_id text,
  step_id text,
  scheduled_slot timestamptz,
  deferred_need_type text,
  material_fingerprint text,
  material_changed boolean,
  budget_admissible boolean,
  rate_admissible boolean,
  concurrency_admissible boolean NOT NULL,
  decision text NOT NULL,
  rejection_code text,
  next_eligible_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_agent_cognition_gate_agent_idx
  ON world_agent_cognition_gate_decisions(world_id,agent_id,created_at DESC);
CREATE INDEX bai_model_budget_calls_agent_started_idx
  ON bai_model_budget_calls(world_id,agent_id,provider_started_at DESC)
  WHERE provider_started_at IS NOT NULL;
GRANT SELECT,INSERT,UPDATE ON world_agent_cognition_gate_decisions TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_agent_cognition_gate_decisions_id_seq TO synterra_app;
