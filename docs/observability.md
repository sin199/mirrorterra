# World observability

The Observatory reads the same persistent world as the map. It does not write to World tables, schedule cognition, call a model, sign a wallet request or emit an Agent action. `src/observability-data.js` queries existing tables through a separate PostgreSQL pool configured with `default_transaction_read_only=on` and a 3-second statement timeout. `src/observability.js` normalizes, filters, ranks, deduplicates and aggregates records. The World Engine never imports either module. An Observatory failure cannot block its loop.

## API

All endpoints are GET and serve the current open world:

| Endpoint | Result |
| --- | --- |
| `/api/world/summary` | Deterministic last-24-hour category snapshot and top milestones |
| `/api/world/feed?category=&limit=&cursor=&period=` | Keyset-paged meaningful events; defaults to medium importance |
| `/api/world/intelligence` | Last-24-hour B.AI usage, model distribution, known cost and scheduler state |
| `/api/world/autonomy?period=24h|7d` | Counts from persisted goal, project, action, tool and cognition facts |
| `/api/world/health` | Current world identity, clock and freshness |
| `/api/agents` | Current resident summaries |
| `/api/agents/:id/summary` | Current structured goal, persisted plan steps and resident facts |
| `/api/agents/:id/timeline?period=today|7d|all&limit=&cursor=` | Agent-only meaningful events |

`limit` is 1–50. Cursors contain the last timestamp and source key. History, World events, capability uses, cognition tool outcomes, research jobs and artifacts are read in bounded pages before merging. The most recent feed is cached for 15 seconds; intelligence, autonomy and resident summaries are cached for 60 seconds. The browser polls the feed every 15 seconds and intelligence and health every 60 seconds while visible. Resident timelines load on selection.

## Taxonomy and provenance

The event catalog is an explicit allowlist. High-importance facts include completed projects, business formation, ownership change, artifacts, research completion and progression milestones. Medium facts include project contributions, fulfilled services, goal milestones below 100 percent and successful capability uses. Movement, repeated 100 percent goal snapshots, repeated cooperation actions, system-generated opportunities, idle/rest ticks, polling, routine cognition and ordinary balance refreshes are omitted. The source table and source ID remain on every event. Duplicates with the same resident, category, entity and minute are collapsed; project completion history and its authoritative action at the same timestamp appear once with both source IDs retained. A cursor carries recent fingerprints so adjacent pages do not repeat them.

Current plans are read from `world_agent_cognition_state.plans`. Completed step marks require stored `executionEvidence.success`; model claims alone are never treated as completion. Goal and plan histories are not inferred from the current JSON snapshot, so historical plan creation/completion counts are unavailable. Relationship strength is current state, while relationship timeline events require explicit history records. Decision traces are pruned, so full historical Fruitfly dependency is unavailable; only capability-use source counts are shown. Missing action-eligible cognition linkage leaves the grounding rate unavailable. Cost uses `bai_model_budget_calls` only when source is `usage_priced` or `provider_reported`, and is labelled as usage-derived rather than an invoice. Missing provider tokens and unknown costs remain unavailable. Legacy unlinked calls are included in raw usage when actually sent, but no correlation is invented.

Follow lives only in browser `localStorage` under `mirrorterra.followedResidents.v1`. It changes display priority and filters, and has no API or World write path. No raw prompts, private reasoning, tool request/results, wallet secrets or API credentials are returned.

See [observability-data-map.md](observability-data-map.md) for source-by-source mapping and unavailable fields.
