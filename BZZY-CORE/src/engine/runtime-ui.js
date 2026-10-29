import { randomUUID } from 'node:crypto';
import { appendEvent, getRecord, putRecord, listRecords, now } from './database.js';
import { loadSession, saveSession } from './store.js';
import { delay } from './delegation.js';
import { config } from './providers.js';
import { NotificationHub } from './notifications.js';
import { terminalYolo, approvePendingWithYolo } from './terminal-permissions.js';
import { createToolActivityProjector } from './tool-activity.js';
import { createSourceObserver } from './source-preview.js';

export class RunnerUI {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId; this.options = options; this.interactive = true; this.json = true; this.cancelled = false; this.persistsEvents = true;
    // IDs supplied by a backend take precedence. The fallback is unique to this
    // execution and advances at turn/tool boundaries for backends without IDs.
    this.peerStreamId = randomUUID(); this.peerTurn = 0; this.peerReply = 0;
    let saved;
    try { saved = loadSession(sessionId); } catch { /* Actor display must not change legacy event delivery. */ }
    this.actorName = options.agent || saved?.subagentDefinition?.name || (saved?.role === 'reviewer' ? 'Reviewer' : saved?.parentSessionId ? 'Executor' : 'BZZY');
    this.actorRole = options.peer ? 'peer' : saved?.subagentDefinition || options.parentSessionId && options.agent ? 'subagent' : saved?.role === 'reviewer' ? 'reviewer' : saved?.parentSessionId || options.parentSessionId ? 'worker' : 'main';
    this.toolActivity = createToolActivityProjector({ sessionId, runId: this.peerStreamId });
    this.sourceObserver = saved && createSourceObserver(saved, (type, data) => this.event(type, data));
  }
  event(type, data = {}) {
    data = { ...data, actorSessionId: this.sessionId, actorRole: this.actorRole, actorName: this.actorName };
    if (type === 'backend') data = { ...data, runId: data.runId || this.peerStreamId };
    if (type === 'backend' && data.method === 'turn/started') {
      this.peerNativeTurn = data.params?.turn?.id || data.params?.turnId; this.peerTurn++; this.peerReply = 0;
    }
    this.beforeOutput?.(); appendEvent(this.sessionId, type, data);
    if (type === 'backend') {
      try { this.sourceObserver?.(data); } catch { /* Preview failures cannot affect execution. */ }
    }
    if (this.options.parentSessionId && type === 'source.changed') appendEvent(this.options.parentSessionId, type, data);
    if (this.options.parentSessionId) {
      try {
        const action = this.toolActivity(type, data);
        if (action) appendEvent(this.options.parentSessionId, 'worker.tool', { ...action, workerSessionId: this.sessionId,
          assignmentId: this.options.assignmentId, agent: this.options.agent });
      } catch { /* Activity display cannot change a worker's execution. */ }
    }
    if (this.options.parentSessionId && ['tool', 'goal', 'error', 'summary'].includes(type)) appendEvent(this.options.parentSessionId, 'worker.progress', { workerSessionId: this.sessionId, assignmentId: this.options.assignmentId, agent: this.options.agent, type, ...data });
    if (this.options.parentSessionId && type === 'text' && this.options.peer) appendEvent(this.options.parentSessionId, 'peer.text', {
      agent: this.options.agent, sessionId: this.sessionId, childSessionId: this.sessionId, text: data.text,
      actorSessionId: this.sessionId, actorRole: this.actorRole, actorName: this.actorName,
      itemId: data.itemId || `bzzy-response:${this.peerStreamId}:${this.peerTurn}:${this.peerReply}`,
      turnId: data.turnId || this.peerNativeTurn || `bzzy-turn:${this.peerStreamId}:${this.peerTurn}`,
    });
    if (type === 'tool') this.peerReply++;
  }
  newline() { this.peerNativeTurn = null; this.peerTurn++; this.peerReply = 0; }
  async ask(question, kind = 'input') {
    if (this.options.unattended) {
      this.event('input.required', { question, kind });
      return '';
    }
    const seconds = config().inputTimeoutSeconds ?? 600;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) throw new Error('inputTimeoutSeconds must be an integer from 1 to 86400.');
    const deadline = Date.now() + (this.options.questionTimeoutMs ?? seconds * 1000);
    const record = { id: randomUUID(), sessionId: this.sessionId, question, kind, state: 'pending', createdAt: now(), expiresAt: deadline };
    putRecord('question', record.id, record); this.event('question', record);
    if (this.options.parentSessionId) appendEvent(this.options.parentSessionId, 'worker.question', record);
    const session = loadSession(this.sessionId); session.executionState = 'waiting_for_input'; saveSession(session);
    if (session.goal && !session.suppressNotifications) new NotificationHub({ ui: this }).publish(session, { question: record }).catch(error => this.event('error', { message: `Input notification failed: ${error.message}` }));
    try { while (!this.cancelled && Date.now() < deadline) {
      const current = getRecord('question', record.id);
      if (kind === 'approval' && current?.state === 'pending' && approvePendingWithYolo(record.id, this.sessionId)) return 'yes';
      if (current?.state === 'answered') return current.answer;
      if (current?.state !== 'pending') return '';
      await delay(100);
    } return ''; }
    finally {
      const current = getRecord('question', record.id);
      if (current?.state === 'pending') {
        const reason = this.cancelled ? 'execution_stopped' : 'input_timeout';
        putRecord('question', record.id, { ...current, state: 'expired', reason, expiredAt: now() });
        this.event('question.expired', { id: record.id, kind, reason, message: reason === 'input_timeout' ? 'Input timed out; approval was denied. Attach to the session to answer future questions.' : 'Question cancelled.' });
      }
      const latest = loadSession(this.sessionId);
      if (latest?.executionState === 'waiting_for_input' && !listRecords('question', { sessionId: this.sessionId, state: 'pending', limit: 1 }).length) { latest.executionState = 'running'; saveSession(latest); }
    }
  }
  async approve(label) { return terminalYolo(this.sessionId) === true || /^y(es)?$/i.test((await this.ask(`${label}\nAllow once? [y/N] `, 'approval')) || ''); }
  close() { this.cancelled = true; }
}
