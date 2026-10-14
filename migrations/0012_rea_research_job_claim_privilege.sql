-- The REA worker sets this column when it claims a queued job.
-- Keep the runtime role limited to the single missing column.
GRANT UPDATE (started_world_minute) ON world_research_jobs TO synterra_app;
