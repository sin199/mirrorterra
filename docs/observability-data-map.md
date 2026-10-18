# MirrorTerra observability data map

All projections read the current open world. Real timestamps come from `created_at`; world minutes come only from sources that store them. A missing source produces an unavailable or empty value, never a synthetic event.

| Observable concept | Existing source | Projection | API | UI |
| --- | --- | --- | --- | --- |
| Identity, place, activity | `agents`, `world_members`, `world_agent_states`, `world_social_profiles` | Current resident snapshot | `/api/agents`, `/api/agents/:id/summary` | Residents, Agent Life |
| Current goals | `world_agent_goals`, `world_agent_cognition_state.goals` | Active structured goal; distinguish seeded and resident goals | Agent summary | Agent Life |
| Current plan and steps | `world_agent_cognition_state.plans` | Active plan, persisted current step and authoritative execution evidence only | Agent summary | Agent Life |
| World actions and goal milestones | `world_events` | Whitelisted consequential events; omit movement, rest, polling and routine ticks | `/api/world/feed`, Agent timeline | Feed, Timeline |
| Projects, businesses, relationships, progression | `world_history` | Existing human-readable milestones, mapped to deterministic categories | Feed, Timeline, autonomy | Feed, Timeline, Autonomy |
| Capability use and fallback | `world_capability_uses` | Completed or failed uses, grouped by `decision_source` | Feed, autonomy | Feed, Autonomy |
| Tool attempts and research jobs | `world_agent_cognition_tool_attempts`, `world_research_jobs` | Terminal outcomes only; no raw request/result body | Feed, Timeline, autonomy | Feed, Timeline, Autonomy |
| Research artifacts | `world_research_artifacts` | Artifact metadata only | Feed, Agent summary | Feed, Agent Life |
| Model calls, usage, cost | `bai_model_budget_calls`, `world_agent_cognition_model_calls`, `bai_model_call_effects` | Paid-call aggregates, actual usage and known/estimated cost separated | `/api/world/intelligence` | World Intelligence |
| Scheduler | `world_agent_cognition_state`, `world_agent_cognition_turns` | Due/last timestamps and recent counts; no scheduler changes | Intelligence, health | Intelligence, World Health |
| World time, freshness, continuity | `worlds`, `world_runtime_state` | Current open world identity and clock | `/api/world/health`, summary | World Health |
| Today summary | Normalized events | Deterministic counts and top events in last 24 real hours | `/api/world/summary` | Today in MirrorTerra |
| Follow | Browser `localStorage` | Local set of resident UUIDs, no server write | None | Residents, Feed |

There is no independent durable plan-history table. Plan stage is taken from the current persisted cognition state; historical plan transitions are displayed only when a corresponding authoritative history/effect record exists. Relationship strength has current state but no trustworthy change log; only explicit relationship/collaboration history is shown as an event.
