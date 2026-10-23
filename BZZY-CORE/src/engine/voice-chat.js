import { randomUUID } from 'node:crypto';
import { CoreAssistant } from '../assistant.js';
import { CoreWorkspaces } from '../workspaces.js';
import { insertConversation } from '../conversations.js';
import { authorizedUpdateGrant } from './update-access.js';
import { home } from './files.js';
import { database, getRecord, putRecord, listRecords, digest, transaction, now } from './database.js';
import { createSessionAccess, activeAccess } from './session-access.js';
import { fail, opaque } from '../validation.js';
import { messageBodyToPlainText } from '../message-format.js';

const active = ['queued', 'launching', 'running'];
const keyFor = (row, id) => digest({ host: row.hostId, peer: row.peerId, grant: row.id, resource: row.resource, id });
function requirePhone(row) {
  const current = row && authorizedUpdateGrant(row.id);
  if (!current || row.relayGrantId || current.resource !== row.resource || current.peerId !== row.peerId || current.hostId !== row.hostId) fail('FORBIDDEN', 'Voice chat requires the fully approved own-phone pairing.', 403);
  return current;
}

// The phone submits text only. Core chooses its own configured assistant,
// workspace and narrow execution credential; none are accepted from the wire.
export class CoreVoiceChat {
  #home = home();
  #pending = new Map();
  constructor({ client } = {}) { this.client = client; }
  async #serial(sessionId, action) {
    const pending = (this.#pending.get(sessionId) || Promise.resolve()).catch(() => {}).then(action);
    this.#pending.set(sessionId, pending);
    try { return await pending; }
    finally { if (this.#pending.get(sessionId) === pending) this.#pending.delete(sessionId); }
  }
  #check(row) { if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'The voice host changed.', 409); return requirePhone(row); }
  status(row) {
    this.#check(row);
    const assistant = new CoreAssistant().settings(), workspace = new CoreWorkspaces().settings();
    if (workspace.configured) new CoreWorkspaces().pin();
    return { configured: assistant.configured && workspace.configured, assistantConfigured: assistant.configured, workspaceConfigured: workspace.configured };
  }
  #context(row) {
    this.#check(row);
    const assistant = new CoreAssistant().settings();
    if (!assistant.configured) fail('ASSISTANT_SETUP_REQUIRED', 'Choose Core’s default assistant on the host first.', 409);
    const workspaces = new CoreWorkspaces(), root = workspaces.pin();
    const binding = keyFor(row, `${assistant.revision}:${root.id}:${root.revision}`);
    return transaction(db => {
      this.#check(row); workspaces.assertPin(root);
      const existing = listRecords('core.relay.context').find(context => context.kind === 'voice' && context.voiceBinding === binding && context.relayGrantId === row.id &&
        !context.revokedAt && context.expiresAt > Date.now() && activeAccess(getRecord('access-token', digest(context.token))));
      if (existing) return existing;
      if (listRecords('core.relay.context').filter(context => context.relayGrantId === row.id && !context.revokedAt && context.expiresAt > Date.now()).length >= 32) fail('CAPACITY', 'This phone has reached its context limit.');
      const remaining = Math.floor((row.expiresAt - Date.now()) / 1000);
      if (remaining < 60) fail('GRANT_UNAVAILABLE', 'Renew the phone pairing before starting voice chat.', 403);
      const session = insertConversation({ ...assistant.selection, cwd: root.path }, db, {
        purpose: 'core-assistant', voiceAssistant: true, assistantSelection: { source: 'core', revision: assistant.revision },
      });
      const token = createSessionAccess({ sessionId: session.id, permissions: ['observe', 'claim', 'execute', 'answer', 'pause', 'cancel'],
        recipient: `voice_${row.peerId}`, expiresInSeconds: remaining, includeChildren: false }, db);
      const resource = randomUUID(), context = { id: resource, resource, kind: 'voice', voiceBinding: binding, workspacePin: root,
        relayGrantId: row.id, hostId: row.hostId, peerId: row.peerId, relayUrl: row.relayUrl, peerDigest: row.peerDigest,
        sessionId: session.id, permissions: ['observe', 'claim', 'execute', 'answer', 'pause', 'cancel'], token: token.token,
        coreGrantId: token.id, expiresAt: Math.min(row.expiresAt, token.expiresAt), createdAt: now() };
      putRecord('core.relay.context', resource, context, db); return context;
    });
  }
  #job(row, requestId) {
    this.#check(row); opaque(requestId);
    const job = getRecord('core.voice.turn', keyFor(row, requestId));
    if (!job) return null;
    const context = getRecord('core.relay.context', job.contextResource);
    if (!context || context.kind !== 'voice' || context.relayGrantId !== row.id || context.peerId !== row.peerId || context.revokedAt || context.expiresAt <= Date.now() ||
      !activeAccess(getRecord('access-token', digest(context.token)))) fail('FORBIDDEN', 'This voice context is no longer authorized.', 403);
    new CoreWorkspaces().assertPin(context.workspacePin);
    const scope = `${job.operation === 'answer' ? 'answer' : 'execute'}:${context.sessionId}`;
    const receipt = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(scope, `voice.${job.id}`);
    if (receipt?.response) {
      const accepted = JSON.parse(receipt.response);
      job.executionId ||= accepted.executionId;
      job.state = 'accepted'; putRecord('core.voice.turn', job.id, job);
    }
    return { job, context };
  }
  async send(row, text, requestId) {
    row = this.#check(row); opaque(requestId);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16000) fail('INVALID_REQUEST', 'Voice input must be bounded nonempty text.');
    const id = keyFor(row, requestId), fingerprint = digest({ text }), previous = this.#job(row, requestId);
    if (previous) {
      if (previous.job.fingerprint !== fingerprint) fail('CONFLICT', 'This voice request ID belongs to different input.', 409);
      if (previous.job.state !== 'accepted') fail('UNCERTAIN', 'Check the saved voice request before retrying.', 409);
      return { state: 'accepted', requestId };
    }
    const context = this.#context(row), owner = `voice_${keyFor(row, 'owner').slice(0, 40)}`;
    const after = Number(database().prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session_id=?').get(context.sessionId).seq);
    let job = { id, requestId, fingerprint, contextResource: context.resource, sessionId: context.sessionId, owner,
      state: 'dispatching', operation: 'execute', after, createdAt: now() };
    putRecord('core.voice.turn', id, job);
    return this.#serial(context.sessionId, async () => {
      try {
        const client = await this.client(context); this.#job(row, requestId);
        const snapshot = await client.session(context.sessionId); this.#job(row, requestId);
        const question = snapshot.questions?.find(question => question.sessionId === context.sessionId);
        if (!question && snapshot.execution && active.includes(snapshot.execution.state)) fail('CONFLICT', 'The assistant is still answering.', 409);
        job.after = Number(database().prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session_id=?').get(context.sessionId).seq);
        putRecord('core.voice.turn', id, job);
        await client.claim(context.sessionId, owner); this.#job(row, requestId);
        if (question) {
          if (!snapshot.execution?.id) fail('CONFLICT', 'The assistant question has no current execution.', 409);
          job = { ...job, operation: 'answer', executionId: snapshot.execution?.id };
          putRecord('core.voice.turn', id, job);
          await client.answer(context.sessionId, { owner, questionId: question.id, answer: text, requestId: `voice.${id}` });
        } else {
          const result = await client.execute(context.sessionId, { owner, prompt: text, requestId: `voice.${id}` });
          job.executionId = result.executionId;
        }
        putRecord('core.voice.turn', id, { ...job, state: 'accepted', updatedAt: now() }); this.#check(row);
        return { state: 'accepted', requestId };
      } catch (error) {
        const accepted = this.#job(row, requestId);
        if (accepted?.job.state !== 'accepted') putRecord('core.voice.turn', id, { ...job, state: error.status >= 400 && error.status < 500 ? 'rejected' : 'uncertain', code: ['FORBIDDEN', 'CONFLICT', 'INVALID_REQUEST', 'PROVIDER_UNAVAILABLE', 'WORKSPACE_CHANGED', 'WORKSPACE_UNAVAILABLE', 'CORE_STOPPED'].includes(error.code) ? error.code : 'VOICE_UNAVAILABLE', updatedAt: now() });
        throw error;
      }
    });
  }
  poll(row, requestId, cursor = 0) {
    const saved = this.#job(row, requestId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 2000000) fail('INVALID_REQUEST', 'Invalid voice output cursor.');
    if (!saved) return { state: 'unknown', text: '', cursor: 0, hasMore: false };
    const { job, context } = saved;
    if (job.state !== 'accepted') return { state: job.state, text: '', cursor, hasMore: false, code: job.code || 'UNCERTAIN' };
    const execution = getRecord('execution', job.executionId);
    if (!execution || execution.sessionId !== context.sessionId) return { state: 'queued', text: '', cursor, hasMore: false };
    // A question ends a spoken turn even when its execution later continues.
    // Pin that event range so a delayed/repeated poll cannot read a later reply.
    if (!job.output) {
      const boundary = database().prepare("SELECT seq,type,data FROM events WHERE session_id=? AND seq>? AND (type='question' OR (type='execution.finished' AND json_extract(data,'$.id')=?)) ORDER BY seq LIMIT 1").get(context.sessionId, job.after, execution.id);
      if (!boundary) return { state: execution.state, text: '', cursor: 0, hasMore: false };
      const question = boundary.type === 'question' ? JSON.parse(boundary.data) : null;
      job.output = { through: boundary.seq, state: question ? 'waiting_for_input' : execution.state,
        ...(question ? { question: String(question.question || question.text || '').slice(0, 4000) } : {}) };
      putRecord('core.voice.turn', job.id, job);
    }
    let body = '', bodyBytes = 0;
    for (const event of database().prepare("SELECT json_extract(data,'$.text') AS text FROM events WHERE session_id=? AND seq>? AND seq<=? AND type='text' ORDER BY seq").iterate(context.sessionId, job.after, job.output.through)) {
      const piece = typeof event.text === 'string' ? event.text : ''; bodyBytes += Buffer.byteLength(piece);
      if (bodyBytes > 2000000) return { state: 'failed', text: '', cursor: 0, hasMore: false, code: 'VOICE_UNAVAILABLE' };
      body += piece;
    }
    const text = messageBodyToPlainText(body);
    if (cursor > text.length) fail('INVALID_REQUEST', 'Voice output cursor exceeds this reply.');
    let page = '', bytes = 0;
    for (const character of text.slice(cursor)) { const size = Buffer.byteLength(character); if (bytes + size > 6000) break; page += character; bytes += size; }
    const next = cursor + page.length;
    return { state: job.output.state, text: page, cursor: next, hasMore: next < text.length,
      ...(job.output.question ? { question: job.output.question } : {}), verification: 'not-assessed' };
  }
  async cancel(row, requestId, cancellationId) {
    const saved = this.#job(row, requestId); if (!saved) return { stopped: true };
    if (saved.job.state !== 'accepted' || !saved.job.executionId) fail('UNCERTAIN', 'Confirm the voice request before stopping it.', 409);
    opaque(cancellationId);
    return this.#serial(saved.context.sessionId, async () => {
      const client = await this.client(saved.context); this.#job(row, requestId);
      const snapshot = await client.session(saved.context.sessionId); this.#job(row, requestId);
      if (snapshot.execution?.id !== saved.job.executionId || ![...active, 'waiting_for_input'].includes(snapshot.execution.state)) return { stopped: true };
      await client.claim(saved.context.sessionId, saved.job.owner); this.#job(row, requestId);
      await client.control(saved.context.sessionId, { owner: saved.job.owner, action: 'pause', requestId: `voice-stop.${keyFor(row, cancellationId)}` });
      this.#check(row); return { stopped: true };
    });
  }
}
