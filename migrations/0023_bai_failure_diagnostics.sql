-- Store only bounded, non-content provider failure diagnostics.
ALTER TABLE bai_model_budget_calls
  ADD COLUMN http_status smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  ADD COLUMN provider_error_code text CHECK (provider_error_code IS NULL
    OR provider_error_code ~ '^[a-z][a-z0-9_]{0,63}$');

ALTER TABLE world_agent_cognition_model_calls
  ADD COLUMN http_status smallint CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  ADD COLUMN provider_error_code text CHECK (provider_error_code IS NULL
    OR provider_error_code ~ '^[a-z][a-z0-9_]{0,63}$');
