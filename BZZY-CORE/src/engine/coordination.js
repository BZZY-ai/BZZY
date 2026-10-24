import { guardedInterval } from './interval.js';
import { requireSandbox } from './policy.js';
import { removeExecutionEnvironment } from './execution-environment.js';
import { randomUUID } from 'node:crypto';
import { lockSession, saveSession, loadSession } from './store.js';
import { appendEvent, putRecord, getRecord, listRecords, transaction, now } from './database.js';
import { processIdentity } from './recovery.js';
import { initializeProject, writeProjectRecord } from './project.js';
import { printGoalSummary } from './controller.js';
import { NotificationHub } from './notifications.js';
import { artifact } from './evidence.js';
import { cancelAssignment, delay } from './delegation.js';
import { supervisorTokens, budgetUsage, delegationUsage } from './delegation-usage.js';
import { assessDebateCompletion } from './verification.js';

export class Coordinator {
  constructor(session, ui, options) {
    const group = ['parallel', 'besties'].includes(session.mode) ? getRecord(session.mode, session.id) : null;
    this.tokenOffset = group && group.goalId === session.goal?.id && (group.modeRevision || 0) === (session.modeRevision || 0)
      ? group.tokenOffset || 0 : Math.max(session.goal?.tokensUsed || 0, budgetUsage(session));
    Object.assign(this, { session, ui, options }); this.started = Date.now(); this.stopping = null; this.abort = new AbortController(); }
  start() {
    requireSandbox(`${this.session.mode} workers`);
    this.unlock = lockSession(this.session);
    try {
      initializeProject(this.session);
      this.session.executionState = 'running'; this.session.goal.status = 'active'; this.session.captureNetwork = Boolean(this.options.captureNetwork); saveSession(this.session);
      putRecord('run', this.session.id, { sessionId: this.session.id, state: 'running', runner: processIdentity(), startedAt: now() });
    } catch (error) { this.unlock(); this.unlock = null; throw error; }
    this.onInterrupt = () => {
      const job = listRecords('execution', { sessionId: this.session.id, states: ['launching', 'running'] }).find(job => job.stopAction);
      this.stopping ||= job?.stopAction === 'cancel' ? 'cancelled' : 'user_pause'; this.abort.abort();
    };
    process.on('SIGINT', this.onInterrupt); process.on('SIGTERM', this.onInterrupt);
    this.timer = guardedInterval(() => {
      for (const control of listRecords('control', { sessionId: this.session.id, state: 'queued' })) {
        if (['pause', 'cancel'].includes(control.action)) { this.stopping ||= control.action === 'cancel' ? 'cancelled' : 'user_pause'; putRecord('control', control.id, { ...control, state: 'observed' }); this.ui.event('control.observed', { id: control.id, action: control.action }); }
        else { const message = 'Steer an individual agent session; this conversation coordinates multiple agents.'; putRecord('control', control.id, { ...control, state: 'failed', error: message }); this.ui.event('control.failed', { id: control.id, action: control.action, message }); }
      }
      const runtime = this.options.runtimeSeconds || this.session.contract?.limits.runtimeSeconds;
      if (runtime && (Date.now() - this.started) / 1000 + (this.session.goal.runtimeUsedSeconds || 0) >= runtime) this.stopping ||= 'runtime_limit';
      if (this.stopping) this.abort.abort();
      const run = getRecord('run', this.session.id); putRecord('run', this.session.id, { ...run, heartbeatAt: now() });
    }, 100, { label: 'Coordination controls', onError: (_error, failures) => { if (failures >= 3) { this.stopping ||= 'persistence_failure'; this.abort.abort(); } } });
  }
  checkBudget(tokens) {
    if (this.session.goal.tokenBudget != null && tokens + this.tokenOffset >= this.session.goal.tokenBudget) this.stopping ||= 'token_limit';
    if (this.stopping) this.abort.abort();
    return !this.stopping;
  }
  async finish(status, record, usage) {
    clearInterval(this.timer); process.removeListener('SIGINT', this.onInterrupt); process.removeListener('SIGTERM', this.onInterrupt);
    try {
    if (this.session.mode === 'debate' && status === 'complete' && !this.stopping) {
      this.session.acceptance = await assessDebateCompletion(this.session, record, { signal: this.abort.signal });
      record.acceptance = this.session.acceptance;
      if (!this.session.acceptance.passed) {
        status = 'awaiting_review'; record.outcome = 'unresolved';
        record.stopReason = 'goal_acceptance_unsatisfied';
        record.reportedGoalSatisfaction = record.goalSatisfaction;
        record.goalSatisfaction = 'inconclusive'; record.assessment = { ...record.assessment, passed: false, acceptancePassed: false };
        record.decision = { ...record.decision, reportedGoalSatisfaction: record.decision?.goalSatisfaction, goalSatisfaction: 'inconclusive' };
        record.unresolvedDisagreement = [...new Set([...(record.unresolvedDisagreement || []), ...(this.session.acceptance.debate?.reasons || []), 'Original goal acceptance checks remain unsatisfied.'])];
      }
      putRecord('debate', this.session.id, record);
    }
    if (this.stopping) {
      status = this.stopping === 'cancelled' ? 'cancelled' : ['runtime_limit', 'token_limit'].includes(this.stopping) ? 'budget_limited' : this.stopping === 'coordination_failure' ? 'awaiting_review' : 'paused';
      for (const job of listRecords('assignment').filter(j => j.parentSessionId === this.session.id)) cancelAssignment(this.session.id, job.id, this.stopping);
      const currentPeers = ['parallel', 'besties'].includes(this.session.mode) ? new Set((getRecord(this.session.mode, this.session.id)?.peers || []).map(peer => peer.sessionId)) : null;
      const children = listRecords('session', { parentSessionId: this.session.id }).filter(s => !currentPeers || currentPeers.has(s.id)), childIds = new Set(children.map(s => s.id));
      const stopped = transaction(db => {
        const jobs = listRecords('execution', { sessionIds: [...childIds], state: 'queued' });
        for (const job of jobs) {
          putRecord('execution', job.id, { ...job, state: 'stopped', exitCode: 130, reason: this.stopping, finishedAt: now() }, db);
          appendEvent(job.sessionId, 'execution.finished', { id: job.id, exitCode: 130, reason: this.stopping }, db);
        }
        return jobs.map(job => job.id);
      });
      for (const id of stopped) removeExecutionEnvironment(id);
      for (const child of children) {
        const active = listRecords('execution', { sessionId: child.id, states: ['launching', 'running'], limit: 1 }).length > 0;
        if (active || ['running', 'waiting_for_input', 'verifying'].includes(child.executionState)) {
          const id = randomUUID(); putRecord('control', id, { id, sessionId: child.id, action: this.stopping === 'cancelled' ? 'cancel' : 'pause', state: 'queued', createdAt: now() });
        } else if (child.goal && ['active', 'verifying'].includes(child.goal.status)) {
          child.goal.status = this.stopping === 'cancelled' ? 'cancelled' : 'paused'; child.goal.reason = this.stopping; child.executionState = child.goal.status; saveSession(child);
        }
      }
      const pending = () => listRecords('execution', { sessionIds: [...childIds], states: ['launching', 'running'] });
      const deadline = Date.now() + 8000;
      while (pending().length && Date.now() < deadline) await delay(50);
      record.pendingStopSessions = pending().map(j => j.sessionId);
      if (usage.agents.some(a => a.sessionId)) {
        usage.agents = usage.agents.map(agent => {
          const child = agent.sessionId && loadSession(agent.sessionId); if (!child) return agent;
          const tokens = this.session.mode === 'besties' ? supervisorTokens(child) : child.goal?.nativeTokensUsed ?? child.goal?.supervisorTokensUsed ?? child.usage?.tokens ?? null;
          return { ...agent, status: child.goal?.status, tokens, available: tokens != null, elapsedSeconds: child.goal?.runtimeUsedSeconds || 0 };
        });
        usage.totalTokens = usage.agents.reduce((sum, a) => sum + (a.tokens || 0), 0);
        usage.complete = !record.pendingStopSessions.length && usage.agents.every(a => a.available);
      }
    }
    if (this.session.mode === 'parallel') { record.results = usage.agents; record.usage = usage; putRecord('parallel-result', this.session.id, record); }
    if (this.session.mode === 'besties') { record.results = usage.agents; record.usage = usage; putRecord('besties-result', this.session.id, record); }
    const resultArtifact = artifact(this.session, JSON.stringify(record, null, 2), `${this.session.mode}-decision`, 'application/json');
    for (const workspace of this.session.acceptance?.workspaces || []) if (workspace.changes.length) this.ui.event('info', { message: `${workspace.agent} · ${workspace.changes.length} changed file(s)${workspace.unapplied.length ? ' · integration required' : ' · present in project'}\nWorkspace: ${workspace.directory}\nChanges: ${workspace.changes.map(change => change.path).join(', ')}` });
    this.session.goal.status = status; this.session.goal.reason = this.stopping || record.stopReason || null;
    this.session.goal.tokensUsed = this.tokenOffset + usage.totalTokens;
    this.session.goal.supervisorTokensUsed = Math.max(0, this.session.goal.tokensUsed - delegationUsage(this.session).delegatedTokens); this.session.goal.runtimeUsedSeconds = (this.session.goal.runtimeUsedSeconds || 0) + (Date.now() - this.started) / 1000;
    this.session.goal.evidence = [...new Set([...(this.session.goal.evidence || []), resultArtifact.id])]; this.session.executionState = status === 'cancelled' ? 'cancelled' : status === 'paused' ? 'paused' : 'idle';
    if (this.session.mode === 'debate') {
      const consensus = record.investigationConsensus || record.decision?.consensus || null;
      const text = item => typeof item === 'string' ? item : item?.claim || item?.summary || item?.description || JSON.stringify(item);
      this.session.modeResult = { goalId: this.session.goal.id, kind: 'debate', outcome: record.outcome || null, stopReason: record.stopReason || null,
        goalSatisfaction: record.goalSatisfaction || 'inconclusive', sourceGoalId: this.session.reviewSource?.goalId || null,
        consensus: consensus ? { verdict: consensus.verdict, required: consensus.required, total: consensus.total, counts: consensus.counts, votes: consensus.votes } : null,
        conclusions: (record.decision?.acceptedConclusions || []).slice(0, 8).map(text),
        unresolved: (record.unresolvedDisagreement || []).slice(0, 8).map(text) };
    }
    this.session.summary = { usage, finishedAt: now() }; saveSession(this.session);
    putRecord('run', this.session.id, { ...getRecord('run', this.session.id), state: this.session.executionState, finishedAt: now() });
    writeProjectRecord(this.session, this.session.mode, this.session.id, { ...record, sessionId: this.session.id, artifactId: resultArtifact.id, summary: this.session.summary });
    printGoalSummary(this.session, this.ui); await new NotificationHub({ ui: this.ui }).publish(this.session);
    return status === 'complete' ? 0 : status === 'paused' || status === 'cancelled' ? 130 : 2;
    } finally { this.unlock?.(); this.unlock = null; }
  }
}
