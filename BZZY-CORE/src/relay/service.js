import path from 'node:path';
import { readJson, writeJson, home } from '../engine/files.js';
import { RelayGateway } from './gateway.js';
import { initializeRelayIdentity } from './identity.js';
import { recordGatewayStatus } from './status.js';
import { revokeLocalRelayGrant } from './revocation.js';
import { object, fail } from '../validation.js';

const configPath = () => path.join(home(), 'relay', 'service.json');
const safeError = error => ['HOST_ENROLLMENT_REQUIRED', 'BZZY_LOCKED', 'PRIVATE_DIRECTORY_REQUIRED',
  'PRIVATE_FILE_REQUIRED', 'NON_ROOT_REQUIRED', 'TLS_REQUIRED', 'INVALID_IDENTITY'].includes(error?.code)
  ? error.code : 'CONNECTION_FAILED';

export function prepareRelayService() {
  const current = readJson(configPath(), {});
  if (current.enabled === undefined) {
    initializeRelayIdentity();
    writeJson(configPath(), { ...current, enabled: true });
  }
}

// Owned by the Core daemon, never by the terminal UI. Administration stays on
// the authenticated local owner API and is absent from the encrypted allowlist.
export class CoreRelayService {
  #gateway;
  #starting;
  #timer;
  #stopped = false;
  #error;
  #factory;
  #retryMs;
  constructor({ gatewayFactory = options => new RelayGateway(options), retryMs = 30000 } = {}) {
    this.#factory = gatewayFactory;
    this.#retryMs = retryMs;
  }
  #config() {
    const config = readJson(configPath(), {});
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  }
  snapshot() {
    const enabled = this.#config().enabled === true;
    return { status: { ...(this.#gateway?.status() || { transport: 'offline', gateway: 'stopped' }),
      managed: true, enabled, ...(this.#error && !this.#gateway?.status().connection?.online ? { errorCode: this.#error } : {}) },
      pendingPairings: this.#gateway?.pendingPairings() || [], grants: this.#gateway?.grants() || [] };
  }
  #record() { recordGatewayStatus(this.snapshot().status); }
  #retry() {
    if (this.#stopped || this.#timer || this.#config().enabled !== true) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#start().catch(() => {});
    }, this.#retryMs);
    this.#timer.unref();
  }
  async #start() {
    if (this.#stopped) fail('GATEWAY_OFFLINE', 'The Core gateway service is stopping.');
    if (this.#starting) return this.#starting;
    if (this.#gateway) return this.snapshot();
    this.#starting = (async () => {
      const config = this.#config();
      let gateway;
      try {
        // The operator may configure a different TLS Relay. Plain ws is only
        // accepted by the existing SDK for an explicitly opted-in loopback host.
        gateway = this.#factory({ ...(config.url ? { url: config.url } : {}),
          allowInsecureLocal: config.allowInsecureLocal === true });
        gateway.on('status', () => { try { this.#record(); } catch { /* private status is best effort */ } });
        gateway.on('fault', () => { this.#error = 'CONNECTION_FAILED'; });
        this.#gateway = gateway;
        await gateway.start();
        this.#error = undefined;
        if (this.#stopped || this.#config().enabled !== true) {
          await gateway.close(); this.#gateway = undefined;
        }
        this.#record();
        return this.snapshot();
      } catch (error) {
        await gateway?.close().catch(() => {});
        this.#gateway = undefined;
        this.#error = safeError(error);
        try { this.#record(); } catch { /* never print private configuration */ }
        this.#retry();
        throw Object.assign(new Error('Core Relay connection is unavailable.'), { code: this.#error });
      }
    })();
    try { return await this.#starting; }
    finally { this.#starting = undefined; }
  }
  async restore() {
    if (this.#config().enabled === true) await this.#start().catch(() => {});
    return this.snapshot();
  }
  async enqueuePush(registration, request) {
    if (!this.#gateway) fail('GATEWAY_OFFLINE', 'The Core gateway is offline.');
    return this.#gateway.enqueuePush(registration, request);
  }
  async connect() {
    this.#stopped = false;
    writeJson(configPath(), { ...this.#config(), enabled: true });
    clearTimeout(this.#timer); this.#timer = undefined;
    return this.#start();
  }
  async disconnect() {
    writeJson(configPath(), { ...this.#config(), enabled: false });
    await this.close(); this.#stopped = false;
    this.#record(); return this.snapshot();
  }
  async close() {
    this.#stopped = true;
    clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#starting) await this.#starting.catch(() => {});
    const gateway = this.#gateway; this.#gateway = undefined;
    await gateway?.close();
  }
  async request(method, action, input = {}) {
    if (method === 'GET' && action === 'status') return this.snapshot();
    if (method !== 'POST') fail('INVALID_REQUEST', 'Unsupported gateway administration request.');
    if (action === 'init') { object(input, []); return { certificate: initializeRelayIdentity() }; }
    if (action === 'connect') { object(input, []); return this.connect(); }
    if (action === 'disconnect') { object(input, []); return this.disconnect(); }
    if (action === 'pair') {
      if (!this.#gateway) fail('GATEWAY_OFFLINE', 'Connect the Core gateway before pairing.');
      const invitation = await this.#gateway.createPairing(input);
      const { renderQR, ...data } = invitation;
      return { ...data, terminalQR: await renderQR({ terminal: true }) };
    }
    if (action === 'revoke') {
      object(input, ['grantId']);
      return this.#gateway ? this.#gateway.revokeGrant(input.grantId) : revokeLocalRelayGrant(input.grantId);
    }
    if (!this.#gateway) fail('GATEWAY_OFFLINE', 'Connect the Core gateway first.');
    if (action === 'share-create') return this.#gateway.createProjectShare(input);
    if (action === 'library-share-create') return this.#gateway.createLibraryShare(input);
    if (action === 'share-status') { object(input, ['shareId']); return this.#gateway.projectShareStatus(input.shareId); }
    if (action === 'share-approve') return this.#gateway.approveProjectShare(input);
    if (action === 'share-revoke') { object(input, ['shareId']); return this.#gateway.revokeProjectShare(input.shareId); }
    if (action === 'approve') return this.#gateway.approvePairing(input);
    if (action === 'deny') { object(input, ['claimId']); await this.#gateway.denyPairing(input.claimId); return { denied: true }; }
    fail('INVALID_REQUEST', 'Unsupported gateway administration action.');
  }
}
