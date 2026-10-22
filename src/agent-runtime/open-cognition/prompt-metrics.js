// An ephemeral partition of data already present in the outgoing request. No section content is persisted.
export function cognitionPromptSections({ context, systemPrompt, worldRules }) {
  const marker = 'Return one JSON object only';
  const split = systemPrompt.indexOf(marker);
  const prior = context.prior || {};
  const plans = Array.isArray(prior.plans) ? prior.plans : [];
  const activePlan = plans.find((plan) => plan.status === 'active' || plan.status === 'blocked');
  const capabilities = Array.isArray(context.capabilities) ? context.capabilities : [];
  return {
    system_protocol: split < 0 ? systemPrompt : systemPrompt.slice(0, split),
    world_rules: worldRules,
    agent_identity: context.resident,
    self_model: prior.selfModel,
    goal: (prior.goals || []).filter((goal) => goal.status === 'active'),
    plan: activePlan,
    plan_history: plans.filter((plan) => plan !== activePlan),
    memories: context.memories,
    relationships: context.relationships,
    economic_state: context.economy ? { syncBalances: context.syncBalances, council: context.economy } : context.syncBalances,
    world_state: { ...context.world, delta: undefined, targetState: context.targetState,
      existingWorldGoals: context.existingWorldGoals },
    world_delta: { delta: context.world?.delta, recentEvents: context.recentEvents },
    affordances: context.availableAffordances,
    capabilities: { nodes: capabilities.filter((row) => !String(row.key || '').startsWith('tool:')),
      gaps: context.capabilityGaps, proposals: context.capabilityProposals,
      experiences: context.capabilityExperiences },
    tool_schemas: capabilities.filter((row) => String(row.key || '').startsWith('tool:')),
    other_agents: context.peers,
    execution_results: { toolResults: context.toolResults, research: context.research },
    output_schema: split < 0 ? '' : systemPrompt.slice(split)
  };
}

export function memorySelectionPromptSections({ systemPrompt, query }) {
  const split = systemPrompt.indexOf('Return only JSON:');
  return { system_protocol: split < 0 ? systemPrompt : systemPrompt.slice(0, split),
    goal: query.currentGoals, plan: query.currentPlans,
    memories: query.candidates, world_state: query.environment,
    output_schema: split < 0 ? '' : systemPrompt.slice(split) };
}
