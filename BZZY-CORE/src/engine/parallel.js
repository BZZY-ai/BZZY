import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Coordinator } from './coordination.js';
import { delay } from './delegation.js';
import { createSession, loadSession, saveSession, home, privateDir } from './store.js';
import { getProvider, apiKey } from './providers.js';
import { newGoal } from './goals.js';
import { putRecord, getRecord, listRecords, appendEvent, now } from './database.js';
import { snapshotWorkspace, copyWorkspaceSnapshot } from './evidence.js';
import { writeProjectRecord } from './project.js';
import { configuredParallel } from './parallel-setup.js';
import { conversationPrompt } from './conversation.js';
import { assessGroupCompletion } from './verification.js';

export async function runParallel(session, options, ui) {
  const coordinator = new Coordinator(session, ui, options); session.acceptance = null; coordinator.start();
  let peers = [], usage = { totalTokens: 0, complete: false, agents: [] };
  try {
    const saved = getRecord('parallel', session.id);
    const sameGoal = saved && (saved.modeRevision || 0) === (session.modeRevision || 0) && (saved.goalId === session.goal.id || !saved.goalId && saved.createdAt >= session.goal.createdAt && saved.goal === session.goal.objective);
    const choices = configuredParallel({ ...options, parallelAgents: options.parallelAgents || session.parallelAgents || (sameGoal ? saved.peers.map(peer => peer.selection) : undefined) });
    for (const choice of choices) { const p = getProvider(choice.provider); if (p.auth === 'api-key') apiKey(p); }
    if (sameGoal) peers = saved.peers;
    else {
      if (saved) putRecord('coordination-history', `${session.id}:parallel:${saved.modeRevision || 0}`, saved);
      const context = session.conversationHandoff?.pending ? conversationPrompt(session, session.goal.objective) : '';
      const snapshot = snapshotWorkspace(session, 'parallel-common-input', { ui });
      for (const [index, selection] of choices.entries()) {
        const namespace = `${selection.provider}-${index + 1}-${session.goal.id.slice(0, 8)}${session.modeRevision ? '-' + session.modeRevision : ''}`;
        const work = path.join(home(), 'parallel', session.id, namespace); privateDir(path.dirname(work));
        copyWorkspaceSnapshot(snapshot, work, { sessionId: session.id });
        const child = createSession(getProvider(selection.provider), work, selection.model);
        const tokenBudget = session.goal.tokenBudget == null ? undefined : Math.max(1, Math.floor((session.goal.tokenBudget - coordinator.tokenOffset) / choices.length));
        Object.assign(child, { mode: 'solo', role: 'peer', parentSessionId: session.id, projectRoot: session.cwd, agentNamespace: namespace,
          selectedEffort: selection.effort || 'default', modelCapabilities: selection.capabilities,
          contract: { ...session.contract, context: [session.contract.context, context].filter(Boolean).join('\n\n'), limits: { ...session.contract.limits, ...(tokenBudget ? { tokenBudget } : {}) } },
          policy: session.policy, backendHomes: session.backendHomes, strictPolicy: true, suppressNotifications: true, goal: newGoal(session.goal.objective, tokenBudget) });
        peers.push({ namespace, sessionId: child.id, selection }); saveSession(child);
        appendEvent(child.id, 'message.user', { text: session.goal.objective, kind: 'goal', source: 'parallel', parentSessionId: session.id });
      }
      putRecord('parallel', session.id, { peers, modeRevision: session.modeRevision || 0, tokenOffset: coordinator.tokenOffset, snapshotId: snapshot.id, goalId: session.goal.id, goal: session.goal.objective, createdAt: now() });
    }
    const concurrency = options.concurrency || choices.length;
    const executions = new Map();
    for (const peer of peers) {
      const child = loadSession(peer.sessionId); child.peers = peers; child.parallelSessionId = session.id; saveSession(child);
      const existing = listRecords('execution', { sessionId: child.id, states: ['queued', 'launching', 'running'], limit: 1 })[0];
      if (existing) executions.set(child.id, existing.id);
      writeProjectRecord(child, 'status', child.id, { sessionId: child.id, provider: child.provider, goal: child.goal.objective, peers, status: child.goal.status });
      ui.event('info', { message: `${peer.namespace} · ${child.id} · same goal, independent strategy` });
    }
    let next = 0, lastUsage;
    while (!coordinator.stopping) {
      const active = [...executions.values()].filter(id => ['queued', 'launching', 'running'].includes(getRecord('execution', id)?.state));
      while (next < peers.length && active.length < concurrency) {
        const peer = peers[next++], child = loadSession(peer.sessionId);
        if (child.goal.status === 'complete' || executions.has(child.id)) continue;
        const id = randomUUID(), job = { id, sessionId: child.id, goal: true, resumeGoal: Boolean(child.engineThreadId), state: 'queued', createdAt: now(),
          prompt: `Pursue the complete shared goal independently. You are ${peer.namespace}. Other peers: ${JSON.stringify(peers)}.
Read existing project constraints and relevant ledgers. Use peer_status to see progress, record issues and evidence under your agent namespace. Preserve disagreement; another agent's finding is a claim until verified. Only assess authorized scope.`,
          options: { ...options, mode: 'solo', policy: child.policy, strictPolicy: true, scopedAutonomy: true, tokenBudget: child.goal.tokenBudget, pet: false, detach: false } };
        putRecord('execution', id, job); executions.set(child.id, id); active.push(id);
      }
      usage.agents = peers.map(peer => {
        const child = loadSession(peer.sessionId);
        return { agent: peer.namespace, provider: peer.selection.provider, model: peer.selection.model, sessionId: child.id,
          status: child.goal.status, tokens: child.goal.nativeTokensUsed ?? child.usage?.tokens ?? null, available: child.goal.nativeTokensUsed != null || Boolean(child.usage?.available),
          elapsedSeconds: child.goal.runtimeUsedSeconds || 0 };
      });
      usage.totalTokens = usage.agents.reduce((sum, a) => sum + (a.tokens || 0), 0); usage.complete = usage.agents.every(a => a.available);
      coordinator.checkBudget(usage.totalTokens);
      const usageKey = JSON.stringify(usage.agents.map(agent => [agent.tokens, agent.status]));
      if (usageKey !== lastUsage) { lastUsage = usageKey; ui.event('parallel.usage', usage); }
      const pending = [...executions.values()].some(id => ['queued', 'launching', 'running'].includes(getRecord('execution', id)?.state));
      if (next >= peers.length && !pending) break;
      await delay(100);
    }
    const allComplete = peers.every(peer => loadSession(peer.sessionId).goal.status === 'complete');
    if (allComplete && !coordinator.stopping) session.acceptance = await assessGroupCompletion(session, peers.map(peer => loadSession(peer.sessionId)), { signal: coordinator.abort.signal });
    const accepted = allComplete && session.acceptance?.passed;
    const result = { version: 1, goal: session.goal.objective, peers, results: usage.agents, usage,
      acceptance: session.acceptance || null,
      stopReason: coordinator.stopping || (accepted ? 'Every agent and the original workspace passed acceptance.' : allComplete ? 'The original workspace still has unmet deliverables or verification checks.' : 'One or more independent goals remain unresolved.'),
      interpretation: 'Results retain agent attribution. Agreement or an agent finding is not independent proof of a vulnerability.' };
    putRecord('parallel-result', session.id, result);
    return await coordinator.finish(accepted ? 'complete' : 'awaiting_review', result, usage);
  } catch (error) {
    ui.event('error', { message: error.message }); return coordinator.finish('blocked', { peers, stopReason: error.message }, usage);
  }
}
