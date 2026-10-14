-- Add resident-owned cognition without replacing or rewriting V1-V7 history.
-- Model output is a proposal. The World Engine remains the execution authority.
CREATE TABLE world_agent_cognition_state (
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  self_model jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(self_model) = 'object'),
  goals jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(goals) = 'array'),
  plans jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(plans) = 'array'),
  beliefs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(beliefs) = 'array'),
  values_state jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(values_state) = 'array'),
  policy_experiments jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(policy_experiments) = 'array'),
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(open_questions) = 'array'),
  pending_action jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pending_action) = 'object'),
  available_affordances jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(available_affordances) = 'array'),
  affordances_world_minute bigint CHECK (affordances_world_minute IS NULL OR affordances_world_minute >= 0),
  next_review_world_minute bigint NOT NULL DEFAULT 0 CHECK (next_review_world_minute >= 0),
  review_reason text NOT NULL DEFAULT 'initial',
  lease_token uuid,
  lease_until timestamptz,
  last_cognition_world_minute bigint,
  last_turn_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id,agent_id),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_agent_cognition_due_idx
  ON world_agent_cognition_state(world_id,next_review_world_minute,lease_until);

CREATE TABLE world_agent_cognition_turns (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  trigger_key text NOT NULL CHECK (char_length(trigger_key) BETWEEN 1 AND 160),
  observed_world_minute bigint NOT NULL CHECK (observed_world_minute >= 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  result_revision bigint NOT NULL CHECK (result_revision > base_revision),
  provider text NOT NULL,
  model text NOT NULL,
  model_tier text NOT NULL CHECK (model_tier IN ('haiku','sonnet','opus')),
  context_sha256 text NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
  decision_source text NOT NULL CHECK (decision_source IN ('open_cognition','plan_revision','tool_result','strategic_review')),
  intent jsonb NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,trigger_key),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_agent_cognition_turns_recent_idx
  ON world_agent_cognition_turns(world_id,agent_id,id DESC);

CREATE TABLE world_agent_cognition_memories (
  id bigserial PRIMARY KEY,
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  memory_key text NOT NULL CHECK (char_length(memory_key) BETWEEN 1 AND 160),
  memory_type text NOT NULL CHECK (memory_type IN
    ('episodic','semantic','relationship','project','economic','goal','tool','research','failure','skill')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 1200),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  source_event_id bigint REFERENCES world_events(id) ON DELETE SET NULL,
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,memory_key),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);
CREATE INDEX world_agent_cognition_memories_recent_idx
  ON world_agent_cognition_memories(world_id,agent_id,created_world_minute DESC,id DESC);
CREATE INDEX world_agent_cognition_memories_search_idx
  ON world_agent_cognition_memories USING gin (to_tsvector('simple',summary));

CREATE TABLE world_agent_cognition_tool_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  world_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  intent_key text NOT NULL CHECK (char_length(intent_key) BETWEEN 1 AND 160),
  capability_key text NOT NULL CHECK (char_length(capability_key) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('requested','running','succeeded','failed','blocked')),
  request jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(request) = 'object'),
  result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result) = 'object'),
  lease_token uuid,
  lease_until timestamptz,
  created_world_minute bigint NOT NULL CHECK (created_world_minute >= 0),
  updated_world_minute bigint NOT NULL CHECK (updated_world_minute >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (world_id,agent_id,intent_key),
  FOREIGN KEY (world_id,agent_id) REFERENCES world_members(world_id,agent_id) ON DELETE CASCADE
);

-- V8 business actions already exist in code. The prior check rejected them and
-- occasionally rolled back an otherwise valid World tick.
ALTER TABLE world_agent_states DROP CONSTRAINT world_agent_states_planned_action_check;
ALTER TABLE world_agent_states ADD CONSTRAINT world_agent_states_planned_action_check CHECK
  (planned_action IS NULL OR planned_action IN (
    'work','learn','rest','eat','socialize','trade','cooperate','opportunity','opportunity_reject','opportunity_propose',
    'project_propose','project_join','project_reject','project_contribute','project_leave','organization_found','organization_join',
    'organization_leave','organization_invite','organization_reject','organization_contribute','place_create','information_share',
    'information_accept','information_ignore','information_doubt','goal_review','project_invest','project_distribute',
    'business_found','business_service','business_apply','business_withdraw','business_leave','business_hire','business_work',
    'business_invest','business_reject','business_price','business_distribute','business_close','business_skill_practice',
    'business_seek_cofounder','business_market_observe','business_reopen','agreement_propose','agreement_respond',
    'commitment_resolve','organization_propose','organization_vote','capability_use',
    'business_token_price','business_token_wage','business_wage_accept'));

ALTER TABLE world_capability_uses DROP CONSTRAINT world_capability_uses_decision_source_check;
ALTER TABLE world_capability_uses ADD CONSTRAINT world_capability_uses_decision_source_check CHECK
  (decision_source IN ('agent_api','fruitfly','utility_fallback','agent_cognition'));

GRANT SELECT,INSERT,UPDATE ON world_agent_cognition_state TO synterra_app;
GRANT SELECT,INSERT ON world_agent_cognition_turns,world_agent_cognition_memories TO synterra_app;
GRANT SELECT,INSERT,UPDATE ON world_agent_cognition_tool_attempts TO synterra_app;
GRANT USAGE,SELECT ON SEQUENCE world_agent_cognition_turns_id_seq,world_agent_cognition_memories_id_seq TO synterra_app;
