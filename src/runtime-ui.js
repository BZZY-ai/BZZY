import { randomUUID } from 'node:crypto';
import { appendEvent, getRecord, putRecord, listRecords, now } from './database.js';
import { loadSession, saveSession } from './store.js';
import { delay } from './delegation.js';

export class RunnerUI {
  constructor(sessionId, options = {}) {
    this.sessionId = sessionId; this.options = options; this.interactive = true; this.json = true; this.cancelled = false; this.persistsEvents = true;
    // IDs supplied by a backend take precedence. The fallback is unique to this
    // execution and advances at turn/tool boundaries for backends without IDs.
    this.peerStreamId = randomUUID(); this.peerTurn = 0; this.peerReply = 0;
  }
  event(type, data = {}) {
    if (type === 'backend' && data.method === 'turn/started') {
      this.peerNativeTurn = data.params?.turn?.id || data.params?.turnId; this.peerTurn++; this.peerReply = 0;
    }
    this.beforeOutput?.(); appendEvent(this.sessionId, type, data);
    if (this.options.parentSessionId && ['tool', 'goal', 'error', 'summary'].includes(type)) appendEvent(this.options.parentSessionId, 'worker.progress', { workerSessionId: this.sessionId, agent: this.options.agent, type, ...data });
    if (this.options.parentSessionId && type === 'text' && this.options.peer) appendEvent(this.options.parentSessionId, 'peer.text', {
      agent: this.options.agent, sessionId: this.sessionId, childSessionId: this.sessionId, text: data.text,
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
    const record = { id: randomUUID(), sessionId: this.sessionId, question, kind, state: 'pending', createdAt: now() };
    putRecord('question', record.id, record); this.event('question', record);
    if (this.options.parentSessionId) appendEvent(this.options.parentSessionId, 'worker.question', record);
    const session = loadSession(this.sessionId); session.executionState = 'waiting_for_input'; saveSession(session);
    while (!this.cancelled) {
      const current = getRecord('question', record.id);
      if (current.state === 'answered') {
        const latest = loadSession(this.sessionId); latest.executionState = 'running'; saveSession(latest);
        return current.answer;
      }
      if (current.state !== 'pending') return '';
      await delay(100);
    }
    putRecord('question', record.id, { ...record, state: 'expired' }); return '';
  }
  async approve(label) { return /^y(es)?$/i.test((await this.ask(`${label}\nAllow once? [y/N] `, 'approval')) || ''); }
  close() { this.cancelled = true; }
}
