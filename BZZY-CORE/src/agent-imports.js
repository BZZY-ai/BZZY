import { randomUUID } from 'node:crypto';
import { CoreAgents } from './agents.js';
import { CoreWorkspaces } from './workspaces.js';
import { providerSelection } from './conversations.js';
import { object, fail, uuid } from './validation.js';
import { digest, home } from './engine.js';
import { decodeInvitation } from '@bzzy/relay/invitation';
import { DEFAULT_RELAY_URL } from './relay/identity.js';

const errors = new Set(['CANCELLED', 'FORBIDDEN', 'IMPORT_UNAVAILABLE', 'IMPORT_INVALID', 'IMPORT_CONFLICT', 'PROVIDER_UNAVAILABLE',
  'WORKSPACE_SETUP_REQUIRED', 'WORKSPACE_CHANGED', 'WORKSPACE_UNAVAILABLE', 'CAPACITY', 'SECRET_DETECTED',
  'TRANSFER_UNAVAILABLE', 'CONFIRMATION_REQUIRED']);
const bindingKey = row => digest({ hostId: row.hostId, relayUrl: row.relayUrl, grantId: row.id, peerId: row.peerId, resource: row.resource });

// Codes and disposable receive identities live only in this bounded process-local
// controller. Durable gateway receipts contain an import ID, never the code.
export class CoreAgentImports {
  #home = home();
  #jobs = new Map();
  #agents;
  #importer;
  #url;
  #allowInsecureLocal;
  #timeoutMs;
  #closed = false;
  constructor({ agents = new CoreAgents(), importer, url = DEFAULT_RELAY_URL, allowInsecureLocal = false, timeoutMs = 3600000 } = {}) {
    this.#agents = agents; this.#importer = importer; this.#url = url; this.#allowInsecureLocal = allowInsecureLocal;
    this.#timeoutMs = Math.max(100, Math.min(3600000, timeoutMs));
  }
  #check() { if (this.#closed || home() !== this.#home) fail('IMPORT_UNAVAILABLE', 'The agent import controller is unavailable.', 409); }
  start(input, { binding, authorize }) {
    this.#check(); object(input, ['code', 'expectedSenderFingerprint', 'provider', 'model', 'effort', 'name']);
    if (typeof authorize !== 'function' || !binding) fail('FORBIDDEN', 'Explicit agent import approval is required.', 403);
    authorize();
    if (typeof input.expectedSenderFingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.expectedSenderFingerprint)) fail('CONFIRMATION_REQUIRED', 'Compare the source fingerprint before receiving.', 403);
    let code = input.code;
    if (typeof code === 'string' && code.startsWith('BZZY:INVITE:1:')) {
      const invitation = decodeInvitation(code, { allowInsecureLocal: this.#allowInsecureLocal });
      if (!invitation.code.startsWith('BZZY-AGENT-') || invitation.sender.id !== input.expectedSenderFingerprint || invitation.relay !== this.#url) fail('FORBIDDEN', 'This is not the confirmed Agent invitation.', 403);
      code = invitation.code;
    }
    if (typeof code !== 'string' || !/^BZZY-AGENT-[A-Za-z0-9_-]{43}$/.test(code)) fail('INVALID_REQUEST', 'Use an Agent import code.');
    if (!Object.hasOwn(input, 'model') || !Object.hasOwn(input, 'effort')) fail('INVALID_REQUEST', 'Choose the recipient provider, model and effort.');
    const selection = providerSelection({ provider: input.provider, model: input.model, effort: input.effort });
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || Buffer.byteLength(input.name) > 120 || /[\r\n\t\x00-\x1f\x7f-\x9f]/u.test(input.name))) fail('INVALID_REQUEST', 'Choose a valid agent name.');
    const workspaces = new CoreWorkspaces(), workspace = workspaces.pin();
    const active = [...this.#jobs.values()].filter(job => !['complete', 'failed', 'cancelled'].includes(job.state));
    if (active.length >= 2 || active.some(job => job.bindingKey === bindingKey(binding))) fail('CAPACITY', 'Finish or cancel the current Agent import first.');
    while (this.#jobs.size >= 32) {
      const old = [...this.#jobs.values()].find(job => ['complete', 'failed', 'cancelled'].includes(job.state));
      if (!old) fail('CAPACITY', 'The import receipt limit was reached.');
      this.#jobs.delete(old.importId);
    }
    const job = { importId: randomUUID(), bindingKey: bindingKey(binding), state: 'connecting', sourceFingerprint: input.expectedSenderFingerprint,
      recipientFingerprint: null, received: 0, total: null, expiresAt: Date.now() + this.#timeoutMs, controller: new AbortController(), authorize };
    this.#jobs.set(job.importId, job);
    const verify = () => { this.#check(); job.controller.signal.throwIfAborted(); authorize(); workspaces.assertPin(workspace); };
    const timer = setTimeout(() => job.controller.abort(), this.#timeoutMs); timer.unref?.();
    const guard = setInterval(() => { try { verify(); } catch { job.controller.abort(); } }, 250); guard.unref?.();
    job.done = Promise.resolve().then(async () => {
      const importer = this.#importer || (await import('./relay/project-transfer.js')).importProjectShare;
      verify();
      await importer({ expectedKind: 'AGENT', code: input.code, cwd: workspace.path,
        expectedSenderFingerprint: input.expectedSenderFingerprint, url: this.#url, allowInsecureLocal: this.#allowInsecureLocal,
        signal: job.controller.signal,
        onIdentity: ({ recipientFingerprint }) => { verify(); if (!/^[A-Za-z0-9_-]{43}$/.test(recipientFingerprint)) fail('IMPORT_INVALID', 'Invalid recipient identity.');
          job.recipientFingerprint = recipientFingerprint; job.state = 'awaitingApproval'; },
        onProgress: ({ received, total }) => { verify(); job.state = 'receiving'; job.received = received; job.total = total; },
        importArchive: async file => { verify(); job.state = 'importing';
          job.agent = await this.#agents.importArchive(file, { ...selection, ...(input.name ? { name: input.name } : {}) },
            { importId: job.importId, authorize: verify, signal: job.controller.signal }); return job.agent; } });
      verify(); if (!job.agent) fail('IMPORT_INVALID', 'The transfer did not register an Agent.'); job.state = 'complete';
    }).catch(error => {
      // The database commit is the winning boundary. A disconnect/cancel racing
      // its response must not report a registered Agent as a failed import.
      let committed; try { committed = this.#agents.imported(job.importId); } catch {}
      if (committed) { job.agent = committed; job.state = 'complete'; return; }
      delete job.agent; job.state = job.controller.signal.aborted ? 'cancelled' : 'failed';
      job.errorCode = job.controller.signal.aborted ? 'CANCELLED' : errors.has(error.code) ? error.code : 'IMPORT_UNAVAILABLE';
    }).finally(() => { clearTimeout(timer); clearInterval(guard); });
    return { state: 'accepted', importId: job.importId, sourceFingerprint: job.sourceFingerprint, expiresAt: job.expiresAt };
  }
  #job(importId, binding, authorize) {
    this.#check(); uuid(importId); authorize();
    const job = this.#jobs.get(importId);
    if (!job || job.bindingKey !== bindingKey(binding)) fail(job ? 'FORBIDDEN' : 'UNCERTAIN', 'This import receipt is unavailable.', 409);
    return job;
  }
  status(importId, options) {
    const job = this.#job(importId, options.binding, options.authorize);
    return { importId, state: job.state, sourceFingerprint: job.sourceFingerprint, recipientFingerprint: job.recipientFingerprint,
      received: job.received, total: job.total, expiresAt: job.expiresAt,
      ...(job.agent ? { agent: job.agent } : {}), ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
  }
  async cancel(importId, options) {
    const job = this.#job(importId, options.binding, options.authorize);
    if (job.state === 'complete') fail('CONFLICT', 'The Agent was already imported.');
    job.controller.abort(); await job.done;
    return { state: 'accepted', importId, cancelled: true };
  }
  async close() {
    this.#closed = true;
    for (const job of this.#jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.#jobs.values()].map(job => job.done)); this.#jobs.clear();
  }
}
