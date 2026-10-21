import fs from 'node:fs';
import path from 'node:path';
import { Coordinator } from './coordination.js';
import { createSession, loadSession, saveSession, home, privateDir } from './store.js';
import { getProvider, apiKey } from './providers.js';
import { newGoal } from './goals.js';
import { getRecord, putRecord, listRecords, now } from './database.js';
import { snapshotWorkspace } from './evidence.js';
import { enqueueExecution } from './execution-queue.js';
import { reconcileSession } from './recovery.js';
import { peerCollaborationState } from './peer-collaboration.js';
import { delay } from './delegation.js';
import { supervisorTokens } from './delegation-usage.js';
import { assessGroupCompletion } from './verification.js';

const running = state => ['queued', 'launching', 'running'].includes(state);
export async function runBesties(session, options, ui) {
  const coordinator = new Coordinator(session, ui, options); session.acceptance = null; coordinator.start();
  let group, usage = { totalTokens: 0, complete: false, agents: [] };
  try {
    const choices = session.besties;
    if (!Array.isArray(choices) || choices.length !== 2) throw new Error('Besties needs exactly two independently selected peers.');
    if ((options.concurrency ?? session.contract.limits.concurrency ?? 2) < 2) throw new Error('Besties needs two concurrent peers. Increase the configured concurrency limit to at least 2.');
    for (const selection of choices) { const provider = getProvider(selection.provider); if (provider.auth === 'api-key') apiKey(provider); }
    group = getRecord('besties', session.id);
    if (group && group.goalId !== session.goal.id) group = null;
    if (!group) {
      const snapshot = snapshotWorkspace(session, 'besties-common-input'), peers = [];
      for (const [index, selection] of choices.entries()) {
        const namespace = `${selection.provider}-bestie-${index + 1}-${session.goal.id.slice(0, 8)}`, work = path.join(home(), 'besties', session.id, namespace);
        privateDir(path.dirname(work)); fs.cpSync(snapshot.directory, work, { recursive: true, dereference: false });
        const child = createSession(getProvider(selection.provider), work, selection.model);
        Object.assign(child, { mode: 'solo', role: 'bestie', parentSessionId: session.id, bestiesSessionId: session.id, parallelSessionId: session.id,
          projectRoot: session.cwd, agentNamespace: namespace, selectedEffort: selection.effort, modelCapabilities: selection.capabilities,
          contract: { ...session.contract, context: `${session.contract.context || ''}\nYou are peer ${index + 1} in a two-peer collaboration. Divide work through peer_message, publish decisive evidence, inspect and review the other peer's claims, preserve disagreement. Neither peer supervises the other.` },
          policy: session.policy, backendHomes: session.backendHomes, strictPolicy: true, suppressNotifications: true, goal: newGoal(session.goal.objective, session.goal.tokenBudget) });
        peers.push({ namespace, sessionId: child.id, selection }); saveSession(child);
      }
      group = { goalId: session.goal.id, peers, snapshotId: snapshot.id, cursors: {}, createdAt: now() }; putRecord('besties', session.id, group);
      for (const peer of peers) { const child = loadSession(peer.sessionId); child.peers = peers; saveSession(child); }
    }
    if (options.bestiesResume) { group.resumed = {}; putRecord('besties', session.id, group); }
    const currentJob = id => listRecords('execution').find(job => job.sessionId === id && running(job.state));
    const queue = (peer, cursor, initial, resuming) => {
      const child = loadSession(peer.sessionId), recovered = reconcileSession(child.id);
      if (recovered.live) return false;
      if (recovered.state === 'cleanup_required') throw new Error(recovered.reason);
      const remaining = session.goal.tokenBudget == null ? null : Math.max(0, session.goal.tokenBudget - usage.totalTokens);
      if (remaining === 0) { coordinator.stopping = 'token_limit'; return false; }
      const prompt = initial ? session.goal.objective : 'Your peer published new collaboration evidence. Read peer_inbox, inspect the cited artifacts, independently verify relevant claims, answer concrete objections and record peer_review. Continue the same shared objective; preserve unresolved disagreement.';
      const result = enqueueExecution(child.id, { prompt, goal: true, resumeGoal: Boolean(child.engineThreadId),
        options: { ...options, mode: 'solo', policy: child.policy, strictPolicy: true, scopedAutonomy: true, pet: false, detach: false, tokenBudget: remaining == null ? undefined : remaining + (child.goal.tokensUsed || 0) } }, `besties:${session.goal.id.slice(0, 8)}:${child.id}:${initial ? 'start' : resuming ? 'resume-' + options.bestiesRunId : cursor}`, {
        authorize: () => { if (loadSession(session.id)?.goal?.id !== group.goalId) throw new Error('The shared objective changed.'); },
        prepare: (fresh, db) => {
          if (remaining != null) fresh.goal.tokenBudget = remaining + (fresh.goal.tokensUsed || 0);
          Object.assign(fresh.goal, { status: 'active', noActivityTurns: 0, blockerStreak: 0, lastBlocker: null }); delete fresh.goal.reason;
          putRecord('session', fresh.id, fresh, db);
          const saved = getRecord('besties', session.id); saved.cursors[fresh.id] = cursor; saved.started ||= {}; saved.started[fresh.id] = true; putRecord('besties', session.id, saved, db); group = saved;
        },
      });
      ui.event('besties.turn', { sessionId: child.id, agent: peer.namespace, executionId: result.executionId, reason: initial ? 'initial work' : 'new peer evidence' }); return true;
    };
    let lastUsage;
    while (!coordinator.stopping) {
      group = getRecord('besties', session.id);
      usage.agents = group.peers.map(peer => { const child = loadSession(peer.sessionId), tokens = supervisorTokens(child);
        return { agent: peer.namespace, sessionId: child.id, provider: child.provider, model: child.model, status: child.goal.status, tokens, available: tokens != null, elapsedSeconds: child.goal.runtimeUsedSeconds || 0 }; });
      usage.totalTokens = usage.agents.reduce((sum, item) => sum + (item.tokens || 0), 0); usage.complete = usage.agents.every(item => item.available);
      coordinator.checkBudget(usage.totalTokens);
      if (coordinator.stopping) break;
      const key = JSON.stringify(usage.agents.map(item => [item.tokens, item.status]));
      if (key !== lastUsage) { lastUsage = key; ui.event('besties.usage', usage); }
      const collaboration = peerCollaborationState(session, { verifyEvidence: false });
      let active = false;
      for (const peer of group.peers) {
        if (currentJob(peer.sessionId)) { active = true; continue; }
        const child = loadSession(peer.sessionId), initial = !group.started?.[child.id];
        const cursor = collaboration.activity.find(item => item.sessionId === child.id)?.after || 0;
        const observedCursor = Math.max(group.cursors[child.id] || 0, getRecord('peer-cursor', child.id)?.after || 0);
        // Restart only for an explicit initial/resume request or previously unseen evidence.
        const resumable = options.bestiesResume && !group.resumed?.[child.id];
        const feedbackCanHelp = ['complete', 'awaiting_review', 'blocked'].includes(child.goal.status) && !child.failure;
        if (initial || resumable || feedbackCanHelp && cursor > observedCursor && !collaboration.supported) {
          if (resumable) { group.resumed ||= {}; group.resumed[child.id] = true; putRecord('besties', session.id, group); }
          active = queue(peer, cursor, initial, resumable) || active;
        }
      }
      if (!active) {
        const finished = group.peers.every(peer => loadSession(peer.sessionId).goal.status === 'complete'), assessment = peerCollaborationState(session);
        if (finished && assessment.supported) session.acceptance = await assessGroupCompletion(session, group.peers.map(peer => loadSession(peer.sessionId)), { mutualReviewed: true, signal: coordinator.abort.signal });
        const accepted = finished && assessment.supported && session.acceptance?.passed;
        const result = { version: 1, goalId: session.goal.id, goal: session.goal.objective, peers: group.peers, collaboration: assessment, usage,
          acceptance: session.acceptance || null, stopReason: accepted ? 'Both peers completed their verification and mutually supported the shared evidence.' : finished && assessment.supported ? 'The original workspace still has unmet deliverables or verification checks.' : assessment.unresolved || 'One or both peers remain unresolved. No disagreement was forced into agreement.' };
        putRecord('besties-result', session.id, result);
        return await coordinator.finish(accepted ? 'complete' : 'awaiting_review', result, usage);
      }
      await delay(150);
    }
    const result = { goalId: session.goal.id, peers: group?.peers || [], collaboration: group ? peerCollaborationState(session) : null, stopReason: coordinator.stopping, usage };
    putRecord('besties-result', session.id, result); return coordinator.finish('awaiting_review', result, usage);
  } catch (error) {
    coordinator.stopping ||= 'coordination_failure'; ui.event('error', { message: error.message });
    return coordinator.finish('awaiting_review', { peers: group?.peers || [], stopReason: error.message }, usage);
  }
}
