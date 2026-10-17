-- Persistent, coalesced admission deferrals. Existing cognition/World state is untouched.
ALTER TABLE bai_model_budget_calls ADD COLUMN provider_started_at timestamptz;
CREATE TABLE bai_model_deferred_needs (
  need_key text PRIMARY KEY CHECK (need_key ~ '^[0-9a-f]{64}$'),
  world_id uuid,
  agent_id uuid,
  source text NOT NULL CHECK (source IN
    ('openCognition','memorySelection','modelAnalysis','currencyGenesisAuthoring')),
  goal_id text,
  plan_id text,
  step_id text,
  material_fingerprint text NOT NULL,
  budget_epoch text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('budget','rate_limit')),
  deferred_until timestamptz NOT NULL,
  blocked_count bigint NOT NULL DEFAULT 1 CHECK (blocked_count >= 1),
  suppressed_count bigint NOT NULL DEFAULT 0 CHECK (suppressed_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX bai_model_deferred_needs_agent_idx
  ON bai_model_deferred_needs(world_id,agent_id,last_seen_at DESC);
GRANT SELECT,INSERT,UPDATE,DELETE ON bai_model_deferred_needs TO synterra_app;
