const modelLabel = selection => [selection?.provider, selection?.model].filter(Boolean).join(' / ');
const tokens = (value, complete = true) => value == null ? 'usage unavailable' : `${complete ? '' : 'at least '}${value.toLocaleString()} tokens`;

export function delegationTokenLines(session, usage) {
  const count = usage.assignmentCount ?? (usage.agents?.length || null);
  const providers = usage.providers || [], agents = usage.agents || [];
  const handsKnown = count === 0 || (providers.length ? providers.every(provider => provider.available) : agents.length > 0 && agents.every(agent => agent.available));
  const hands = count === 0 ? '0 tokens · not used (no assignments)'
    : handsKnown ? tokens(usage.delegatedTokens)
      : usage.delegatedTokens > 0 ? tokens(usage.delegatedTokens, false) + ' · some usage unavailable' : 'usage unavailable';
  const executor = providers.length === 1 ? providers[0] : session.executor;
  return [
    `BRAIN${modelLabel(session) ? ' · ' + modelLabel(session) : ''}: ${tokens(usage.supervisorTokens)}`,
    `HANDS / EXECUTOR${modelLabel(executor) ? ' · ' + modelLabel(executor) : ''}: ${hands}`,
    `TOTAL: ${tokens(usage.totalTokens, usage.complete)}${usage.complete ? '' : ' · some usage unavailable'}`,
  ];
}
