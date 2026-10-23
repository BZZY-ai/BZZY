import { EventEmitter } from 'node:events';
import { ensureRuntime, runtimeRequest } from '../engine/runtime.js';
import { home } from '../engine/files.js';
import { fail } from '../validation.js';
import { decodeInvitation, renderInvitationQR } from './sdk.js';

// Trusted local host adapter for Settings. Closing this adapter only stops UI
// polling; the gateway remains owned by Core. No owner token is sent to Relay.
export class CoreRelayClient extends EventEmitter {
  #info;
  #timer;
  #closed = false;
  #polling = false;
  #home = home();
  #generation = 0;
  #snapshot = { status: { managed: true, transport: 'offline', gateway: 'stopped' }, pendingPairings: [], grants: [] };
  #pending = new Set();
  managed = true;
  #check(generation) {
    if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'BZZY_HOME changed after Relay client initialization. Use a separate process for each host.', 409);
    if (this.#closed || generation !== this.#generation) fail('CLIENT_CLOSED', 'This Relay view is closed.', 409);
  }
  async #request(method, action, body) {
    const generation = this.#generation;
    this.#check(generation);
    try {
      this.#info ||= await ensureRuntime();
      this.#check(generation);
      const result = await runtimeRequest(this.#info, method, `/v1/relay/${action}`, body);
      this.#check(generation);
      return result;
    } catch (error) { this.#info = undefined; throw error; }
  }
  #accept(snapshot) {
    if (this.#closed) return;
    const generation = this.#generation;
    this.#snapshot = snapshot;
    this.emit('status', snapshot.status);
    if (this.#closed || generation !== this.#generation) return;
    const current = new Set(snapshot.pendingPairings.map(item => item.claimId));
    for (const item of snapshot.pendingPairings) {
      if (this.#closed || generation !== this.#generation) return;
      if (!this.#pending.has(item.claimId)) this.emit('pairing.requested', item);
    }
    this.#pending = current;
  }
  async #refresh() {
    if (this.#polling || this.#closed) return;
    this.#polling = true;
    const generation = this.#generation;
    try { this.#accept(await this.#request('GET', 'status')); }
    catch {
      if (!this.#closed && generation === this.#generation) {
        this.#pending.clear();
        this.#accept({ status: { ...this.#snapshot.status, transport: 'offline', gateway: 'stopped' }, pendingPairings: [], grants: [] });
        this.emit('fault', { code: 'GATEWAY_UNAVAILABLE' });
      }
    }
    finally { this.#polling = false; }
  }
  async start() {
    this.#closed = false; this.#generation++;
    this.#accept(await this.#request('POST', 'connect', {}));
    if (!this.#timer) {
      this.#timer = setInterval(() => { void this.#refresh(); }, 750);
      this.#timer.unref();
    }
    return this.status();
  }
  status() { return this.#snapshot.status; }
  pendingPairings() { return this.#snapshot.pendingPairings; }
  grants() { return this.#snapshot.grants; }
  async createPairing(input) {
    const { terminalQR, ...result } = await this.#request('POST', 'pair', input);
    return { ...result, renderQR: async ({ terminal = true, ...options } = {}) => {
      if (terminal) return terminalQR;
      // The local gateway already supplied the v1 payload. Validate it before
      // rendering locally; insecure transport is still limited to loopback.
      const invitation = decodeInvitation(result.qr, { allowInsecureLocal: true });
      return renderInvitationQR(invitation, { ...options, terminal: false, allowInsecureLocal: true });
    } };
  }
  async approvePairing(input) { const result = await this.#request('POST', 'approve', input); await this.#refresh(); return result; }
  async denyPairing(claimId) { const result = await this.#request('POST', 'deny', { claimId }); await this.#refresh(); return result; }
  async revokeGrant(grantId) { const result = await this.#request('POST', 'revoke', { grantId }); await this.#refresh(); return result; }
  async disconnect() { const result = await this.#request('POST', 'disconnect', {}); this.#accept(result); await this.close(); }
  async close() {
    this.#closed = true; this.#generation++;
    clearInterval(this.#timer); this.#timer = undefined; this.#info = undefined; this.#pending.clear();
    this.#snapshot = { status: { ...this.#snapshot.status, transport: 'offline', gateway: 'stopped' }, pendingPairings: [], grants: [] };
  }
}
