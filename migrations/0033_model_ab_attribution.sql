-- modelab1: additive per-call model A/B attribution on the one B.AI call ledger.
-- ab_cohort: the resident's cohort ('haiku' or 'luna') when the A/B test assigned the call, else NULL.
-- fallback_from_model / fallback_reason: set on a gpt-6-luna call that replaced a failed or skipped
-- claude-haiku-5.5 call. Nullable columns without defaults or constraints: metadata-only on PostgreSQL 16,
-- no table rewrite or scan. No existing row, column, constraint or grant changes.
SET LOCAL lock_timeout = '10s';
ALTER TABLE bai_model_budget_calls
  ADD COLUMN ab_cohort text,
  ADD COLUMN fallback_from_model text,
  ADD COLUMN fallback_reason text;
