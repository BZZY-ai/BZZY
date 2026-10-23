import { loadSession } from './store.js';
import { getRecord } from './database.js';
import { saveDefaultSelection, saveParallelDefault, saveModeDefault, selectionFromSession } from './providers.js';

export function saveSessionDefaultSelection(session) {
  const parentId = session.parallelSessionId || session.parentSessionId;
  const parent = ['parallel', 'besties', 'debate'].includes(session.mode) ? session : parentId && loadSession(parentId);
  if (parent?.mode === 'debate') {
    if (!parent.debateAgents) throw new Error('Choose debate agents before saving this mode’s default.');
    return saveModeDefault('debate', [selectionFromSession(parent), ...parent.debateAgents.slice(1)]);
  }
  if (!['parallel', 'besties'].includes(parent?.mode)) {
    const delegated = session.mode === 'delegate' ? session : parent?.mode === 'delegate' ? parent : null;
    if (delegated) return saveModeDefault('delegate', [selectionFromSession(delegated), delegated.executor]);
    return saveDefaultSelection(session);
  }
  const stored = getRecord(parent.mode, parent.id);
  const group = !parent.goal || stored?.goalId === parent.goal.id ? stored : null;
  const selections = group?.peers?.length ? group.peers.map(peer => {
    const child = loadSession(peer.sessionId);
    if (!child) throw new Error('A parallel agent chat is missing. Restore it before saving this combo.');
    return selectionFromSession(child);
  }) : parent.mode === 'besties' ? parent.besties : parent.parallelAgents;
  return parent.mode === 'besties' ? saveModeDefault('besties', selections) : saveParallelDefault(selections);
}

export function savedDefaultMessage(selected) {
  if (selected.mode) return `${selected.mode[0].toUpperCase() + selected.mode.slice(1)} default saved · ${selected.agents.map((agent, index) =>
    `Agent ${index + 1}: ${agent.provider} · ${agent.model || 'provider default'} · effort ${agent.effort}`).join('\n')}
Use --${selected.mode} --default to reuse it directly.`;
  if (selected.parallelAgents) return `Parallel default saved · ${selected.parallelAgents.map((agent, index) =>
    `Agent ${index + 1}: ${agent.provider} · ${agent.model || 'provider default'} · effort ${agent.effort}`).join('\n')}
Next --parallel launch will ask whether to use this combo.`;
  return `Default saved · ${selected.provider} · ${selected.model || 'provider default'} · effort ${selected.effort}. New bzzy sessions will use it.`;
}
