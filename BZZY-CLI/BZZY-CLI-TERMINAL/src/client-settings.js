import { notificationDeliveryStatus } from '@bzzy/core/engine/push-status.js';
import { CoreAssistant } from '@bzzy/core';
import { chooseUnifiedModel, chooseEffort } from './model-controls.js';
import { randomUUID } from 'node:crypto';
import { terminalSession } from '@bzzy/core';
import { sessionPermissions } from '@bzzy/core/engine/session-access.js';
import { CoreWorkspaces } from '@bzzy/core/workspaces';
import { getProvider, saveKey, credentialStatus } from './providers.js';
import { sessions, loadSession } from './store.js';
import { copyText } from './clipboard.js';
import { PairingQRImage } from './pairing-qr-image.js';
import { home } from './files.js';

const loadRelay = () => {
  let location;
  try { location = import.meta.resolve('@bzzy/core/relay'); }
  catch { location = new URL('../../../BZZY-CORE/src/relay/index.js', import.meta.url).href; }
  return import(location);
};
const loadHost = () => import('@bzzy/core/engine/host-service.js');
const messages = {
  HOST_ENROLLMENT_REQUIRED: 'This host needs Relay enrollment. Run bzzy-core relay init and enroll its public certificate.',
  HOST_REQUIRED: 'Relay needs this host’s public certificate enrolled by its operator.',
  BZZY_LOCKED: 'Another Core Relay gateway is running. Stop that gateway before connecting here.',
  PRIVATE_DIRECTORY_REQUIRED: 'Core requires owner-only host storage. Check permissions on the BZZY home and relay directories.',
  ENOENT: 'The host identity is unavailable. Run bzzy-core relay init.',
  FORBIDDEN: 'Core rejected this request. Check the device, session scope and expiry.',
  UNCERTAIN: 'The pairing outcome is uncertain. Check the phone and paired devices before retrying.',
  CONFLICT: 'Settings changed while this prompt was open. Try again.',
  PROVIDER_UNAVAILABLE: 'The selected provider is unavailable in Core. Refresh the provider selection.',
  ASSISTANT_SETUP_REQUIRED: 'Choose Core’s own provider, model and effort before starting a Core task.',
  HOST_CONTEXT_CHANGED: 'The private Core host changed. Reopen Settings for the current host.',
  CORE_STOPPED: 'Core is stopped. Run bzzy-core start to continue.',
  CORE_ALREADY_RUNNING: 'Core is running outside its background service. Use Restart Core to switch it to the service.',
  SERVICE_MANAGER_UNAVAILABLE: 'The background service could not be controlled. Check Core status and your user login.',
  SERVICE_OUTDATED: 'The installed Core service needs updating. Run the BZZY installer again.',
  SERVICE_START_FAILED: 'Core did not become ready. Check Core status and the private service log.',
  SERVICE_PREREQUISITES: 'Core needs installation prerequisites fixed. Run bzzy-core doctor for details.',
  OPERATOR_STOP_FAILED: 'Core could not confirm that all work stopped. Check its status before trying again.',
  STOP_INCOMPLETE: 'Core could not verify that all work stopped. Check its status before trying again.',
  HOST_CONTROL_UNAVAILABLE: 'Core service controls are unavailable. Check the BZZY installation.',
};

// Host-only UI controller. Never route secrets, QR payloads or codes through
// model input, session events, transcripts, the runtime API or JSON output.
export class ClientSettings {
  #invitation;
  #qr = [];
  #expiry;
  #approvalRequest;
  constructor(ui, { relayLoader = loadRelay, hostLoader = loadHost, workspaces = new CoreWorkspaces(), qrImage = new PairingQRImage() } = {}) {
    this.ui = ui; this.relayLoader = relayLoader; this.workspaces = workspaces;
    this.hostLoader = hostLoader; this.hostHome = home();
    this.qrImage = qrImage;
    this.message = ''; this.warning = false; this.focus = 0; this.page = 'main';
  }
  changed() { if (this.closed) return; if (this.ui.tui) this.ui.tui.settingsEnsureFocus = true; this.ui.tui?.schedule(); }
  focusAction(action) {
    const index = this.rows().filter(row => row.action).findIndex(row => row.action === action);
    if (index >= 0) this.focus = index;
  }
  keyStatus() {
    try {
      return credentialStatus('deepseek');
    } catch { return { unavailable: true }; }
  }
  pending() { return this.gateway?.pendingPairings() || []; }
  grants() { return (this.gateway?.grants() || []).filter(grant => !grant.revokedAt && grant.expiresAt > Date.now()); }
  back() {
    if (this.page === 'main' || this.busy) return false;
    if (this.page === 'approve') {
      this.page = 'pair'; this.#approvalRequest = undefined; this.message = ''; this.warning = false;
      this.focusAction('approve'); this.changed(); return true;
    }
    const previous = this.page;
    this.page = 'main'; this.qrView = false; this.message = ''; this.warning = false;
    this.focusAction(previous === 'core' ? 'core' : 'pair'); this.changed(); return true;
  }
  rows() {
    const rows = [], put = (text = '', tone = 'text', action) => rows.push({ text, tone, action });
    if (this.page === 'main') {
      const key = this.keyStatus();
      put('DeepSeek API key', 'accent', 'deepseek');
      put(key.unavailable ? '  Unavailable' : key.environment ? '  Environment key · Enter to replace' : key.saved ? '  Configured · Enter to replace' : '  Add your key', 'muted');
      put();
      put('Default BZZY folder', 'accent', 'workspace-root');
      try { put('  ' + (this.workspaces.settings().root?.path || 'Choose a folder'), 'muted'); }
      catch { put('  Unavailable', 'warning'); }
      put();
      put('Pair iPhone', 'accent', 'pair');
      put(this.pending().length ? '  iPhone waiting for approval' : this.grants().length ? '  iPhone paired' : '  Full access · QR or code', 'muted');
      put(); put('BZZY Core' + (this.hostStatus ? ` · ${this.hostLabel()}` : ''), 'accent', 'core');
      return rows;
    }
    if (this.page === 'core') {
      put(`Status · ${this.hostLabel()}`, 'muted', 'core-status');
      put();
      put('Start', 'accent', 'core-start');
      put('Stop', 'warning', 'core-stop');
      put('Restart', 'accent', 'core-restart');
      const assistant = (this.assistant ||= new CoreAssistant()).settings();
      if (!Object.hasOwn(this, 'coreSelection')) { this.coreSelection = assistant.selection; this.coreRevision = assistant.revision; }
      put(); put('Default Core model · ' + (this.coreSelection ? `${this.coreSelection.provider} · ${this.coreSelection.model || 'provider default'} ▾` : 'Select model ▾'), 'accent', 'core-model');
      put('Effort · ' + (this.coreSelection?.effort || 'default') + ' ▾', 'accent', 'core-effort');
      put('Save Core default', 'accent', 'core-save');
      put('Independent from the CLI chat default.', 'muted');
      put(); put('Stop pauses work. Start keeps it paused until you resume.', 'muted');
      const push = notificationDeliveryStatus();
      put(); put(push.message, push.configured && push.compatibleDevices ? 'muted' : 'warning');
      put(); put('Back', 'muted', 'back');
      return rows;
    }
    if (this.page === 'approve') {
      put('Compare with “This iPhone” in BZZY on your phone.', 'muted');
      put(); put(this.#approvalRequest?.deviceId || '', 'text');
      put(); put('Full access · Terminals, Agents and sharing', 'muted');
      put(); put('Fingerprints match · Pair iPhone', 'accent', 'confirm-approve');
      put('Cancel', 'muted', 'cancel-approve');
      return rows;
    }
    put('Terminals, Agents and sharing · Full access', 'muted');
    if (this.certificate) put(`Host fingerprint: ${this.certificate.id}`, 'muted');
    put();
    if (this.#invitation) {
      put(this.#invitation.code, 'text');
      put(`Code expires at ${new Date(this.#invitation.expiresAt).toLocaleTimeString()} · access lasts 24 hours`, 'muted');
      put('Show QR', 'accent', 'qr');
      put('Open QR image', 'accent', 'open-qr');
      put('Copy code', 'accent', 'copy-code');
    } else put('Generate QR and code', 'accent', 'new-pair');
    const request = this.pending()[0];
    if (request) {
      put(); put('Confirm your iPhone', 'accent');
      put(`Phone fingerprint: ${request.deviceId}`, 'text');
      put('Compare the fingerprints on your phone and this Mac.', 'muted');
      put('Compare and approve iPhone…', 'accent', 'approve');
      put('Deny', 'warning', 'deny');
    }
    const devices = new Map();
    for (const grant of this.grants()) {
      if (!devices.has(grant.deviceId) || grant.expiresAt > devices.get(grant.deviceId).expiresAt) devices.set(grant.deviceId, grant);
    }
    for (const grant of devices.values()) {
      put(); put(`Paired device · ${grant.deviceId}`, 'muted');
      put(`Access expires ${new Date(grant.expiresAt).toLocaleString()}`, 'muted');
      put('Unpair device', 'warning', `revoke:${grant.id}`);
    }
    put(); put('Back', 'muted', 'back');
    return rows;
  }
  invitationCode() { return this.#invitation?.code; }
  clearInvitation() {
    this.#approvalRequest = undefined;
    if (this.page === 'approve') this.page = 'pair';
    this.qrImage.clear();
    clearTimeout(this.#expiry); this.#invitation = undefined; this.#qr = []; this.qrView = false; this.changed();
  }
  qrLines() { return this.#qr; }
  async adapter() {
    if (!this.relay) {
      try { this.relay = await this.relayLoader(); }
      catch { throw Object.assign(new Error(), { code: 'ADAPTER_UNAVAILABLE' }); }
    }
    return this.relay;
  }
  async connect() {
    const relay = await this.adapter();
    this.certificate = relay.initializeRelayIdentity();
    if (!this.gateway) {
      const Gateway = relay.CoreRelayClient || relay.RelayGateway;
      this.gateway = new Gateway();
      this.gateway.on('status', status => {
        try { if (!this.gateway.managed) this.relay.recordGatewayStatus({ ...status, relayUrl: this.gateway.status().relayUrl }); }
        catch { this.message = 'Unable to save local gateway status.'; this.warning = true; }
        this.changed();
      });
      this.gateway.on('fault', () => {
        if (this.busy) return;
        this.message = 'Relay connection interrupted. Check connectivity before trying again.'; this.warning = true; this.changed();
      });
      this.gateway.on('pairing.requested', () => {
        if (this.page !== 'approve') { this.page = 'pair'; this.focusAction('approve'); }
        this.qrView = false; this.message = 'Your iPhone is waiting. Compare its fingerprint to approve.'; this.warning = true; this.changed();
      });
    }
    await this.gateway.start();
    if (this.closed) await this.gateway.close();
  }
  async pair({ fresh = false } = {}) {
    if (this.#invitation) return;
    await this.connect();
    if (this.closed) return;
    if (!fresh && this.pending().length) {
      this.qrView = false; this.message = 'Your iPhone is waiting. Compare its fingerprint to approve.';
      this.focusAction('approve'); return;
    }
    if (!fresh && this.grants().length) {
      this.qrView = false; this.message = 'Your iPhone is paired.'; this.focusAction('back'); return;
    }
    let id = this.ui.activeTab || this.ui.sessionId;
    // The seed is a Core protocol detail; this phone always gets the full catalog.
    if (!id || !terminalSession(loadSession(id))) id = sessions().find(terminalSession)?.id;
    if (!id) { this.message = 'Start a terminal session with bzzy first, then pair your iPhone.'; return; }
    if (this.closed) return;
    const invitation = await this.gateway.createPairing({ sessionId: id, permissions: [...sessionPermissions],
      sessionAccess: true, shareAccess: true, agentAccess: true, ttlSeconds: 600, grantTtlSeconds: 86400 });
    if (this.closed) return;
    this.#invitation = invitation;
    // Only the SDK's fixed black/white SGR and block glyphs may enter the frame.
    this.#expiry = setTimeout(() => { this.clearInvitation(); this.message = 'Pairing code expired. Generate a new one.'; this.warning = true; this.changed(); }, Math.max(0, invitation.expiresAt - Date.now()));
    this.#expiry.unref();
    try {
      const rendered = await invitation.renderQR({ terminal: true });
      const qr = rendered.split('\n');
      if (qr.every(line => /^[ █▄▀]*$/.test(line.replace(/\x1b\[(?:0|30|37|40|47)m/g, '')))) this.#qr = qr.filter(line => line.replace(/\x1b\[(?:0|30|37|40|47)m/g, '').length);
    } catch { /* Manual entry still uses the same Core-generated invitation. */ }
    this.message = 'Scan in BZZY on your iPhone, or enter the code.';
    this.focusAction('qr'); this.qrView = true;
  }
  async saveDeepseek() {
    const provider = getProvider('deepseek');
    let key = (await this.ui.secret('DeepSeek API key · hidden · Enter saves · Esc cancels'))?.trim();
    if (!key) return;
    if (key.length > 8192 || /\s|[\x00-\x1f\x7f-\x9f]/u.test(key)) { this.message = 'Use an API key without whitespace or control characters.'; this.warning = true; return; }
    if (this.closed) return;
    saveKey(provider.id, key); key = undefined;
    delete process.env[provider.envKey];
    this.ui.accountMonitor?.close(); this.ui.accountMonitor = null;
    if (this.ui.accountStatus) delete this.ui.accountStatus.deepseek;
    this.message = 'API key saved. New requests will use it.';
  }
  async configureWorkspace() {
    const shown = this.workspaces.settings();
    const location = await this.ui.ask(`BZZY root · absolute host folder${shown.root ? ` · current: ${shown.root.path}` : ''} · created if missing · Esc cancels`);
    if (!location?.trim() || this.closed) return;
    const saved = this.workspaces.configure({ path: location.trim(), create: true }, { expectedRevision: shown.revision, requestId: randomUUID() });
    this.message = `BZZY root saved: ${saved.root.path}. Existing terminal directories are preserved.`;
  }
  hostLabel() {
    if (!this.hostStatus) return 'Unavailable';
    return this.hostStatus.operatorStopped ? this.hostStatus.running ? 'Stopping' : 'Stopped'
      : this.hostStatus.running ? 'Running' : 'Stopped';
  }
  async hostAdapter() {
    if (home() !== this.hostHome) throw Object.assign(new Error(), { code: 'HOST_CONTEXT_CHANGED' });
    return this.host ||= await this.hostLoader();
  }
  async refreshHost() {
    const host = await this.hostAdapter();
    this.hostStatus = await host.coreHostStatus();
    this.changed();
    return this.hostStatus;
  }
  async controlHost(action) {
    const host = await this.hostAdapter();
    // Leave old API/lease readers before stopping or replacing their daemon.
    // The CLI then stays in local Settings until the user leaves that screen.
    this.ui.coreLifecycleInterrupted = true;
    this.ui.hostMetrics = null;
    try {
      await host[{ 'core-start': 'startCoreHost', 'core-stop': 'stopCoreHost', 'core-restart': 'restartCoreHost' }[action]]();
      this.message = action === 'core-stop' ? 'Core stopped. Work is saved and paused.'
        : action === 'core-restart' ? 'Core restarted. Paused work stays paused.' : 'Core is running. Paused work stays paused.';
    } finally {
      this.hostStatus = undefined;
      await this.refreshHost().catch(() => {});
    }
  }
  async run(action) {
    if (!this.ui.interactive || !this.ui.tui || this.ui.closed || this.closed || this.busy) return;
    if (!this.rows().some(row => row.action === action)) return;
    this.busy = true; this.message = ''; this.warning = false; this.changed();
    try {
      if (action === 'workspace-root') await this.configureWorkspace();
      else if (action === 'deepseek') await this.saveDeepseek();
      else if (action === 'core') { delete this.coreSelection; delete this.coreRevision; this.page = 'core'; this.focus = 0; await this.refreshHost(); }
      else if (action === 'core-model') {
        const shown = (this.assistant ||= new CoreAssistant()).settings();
        this.coreRevision = shown.revision;
        const selected = await chooseUnifiedModel({ ...this.coreSelection, cwd: this.ui.tui.cwd || process.cwd() }, this.ui, { title: 'BZZY Core default model', scope: 'core' });
        if (selected) this.coreSelection = selected;
      } else if (action === 'core-effort') {
        if (!this.coreSelection) throw Object.assign(new Error('Select a Core model first.'), { code: 'ASSISTANT_SETUP_REQUIRED' });
        const selected = await chooseEffort({ ...this.coreSelection, selectedEffort: this.coreSelection.effort, modelCapabilities: this.coreSelection.capabilities, cwd: this.ui.tui.cwd || process.cwd() }, this.ui, { scope: 'core' });
        if (selected) this.coreSelection = { ...this.coreSelection, ...selected };
      } else if (action === 'core-save') {
        if (!this.coreSelection) throw Object.assign(new Error('Select a Core model first.'), { code: 'ASSISTANT_SETUP_REQUIRED' });
        const assistant = this.assistant ||= new CoreAssistant();
        const { provider, model, effort } = this.coreSelection;
        assistant.configure({ source: 'core', provider, model, effort }, { expectedRevision: this.coreRevision ?? assistant.settings().revision, requestId: randomUUID() });
        this.coreRevision = assistant.settings().revision;
        this.message = 'Core default saved. CLI default is independent.';
      }
      else if (action === 'core-status') await this.refreshHost();
      else if (['core-start', 'core-stop', 'core-restart'].includes(action)) await this.controlHost(action);
      else if (action === 'pair') { this.page = 'pair'; this.focus = 0; await this.pair(); }
      else if (action === 'new-pair') await this.pair({ fresh: true });
      else if (action === 'back') { this.busy = false; this.back(); }
      else if (action === 'qr') this.qrView = true;
      else if (action === 'open-qr') {
        const invitation = this.#invitation;
        try {
          const opened = await this.qrImage.show(() => invitation.renderQR({ terminal: false, format: 'png' }));
          if (opened && !this.closed && this.#invitation === invitation) this.message = 'QR image opened. Scan it with BZZY on your iPhone.';
        } catch {
          if (!this.closed && this.#invitation === invitation) { this.message = 'Unable to open a QR image here. Copy the code and enter it in BZZY on your iPhone.'; this.warning = true; }
        }
      }
      else if (action === 'copy-code') {
        const result = await (this.ui.clipboard?.copyText || copyText)(this.#invitation.code, this.ui.output);
        this.warning = !result?.copied;
        this.message = !result?.copied ? 'Clipboard unavailable. Enter the displayed code in BZZY on your iPhone.'
          : result.method === 'osc52' ? 'Copy request sent. Clipboard support must be enabled in your terminal.' : 'Pairing code copied.';
      }
      else if (action === 'cancel-approve') { this.busy = false; this.back(); }
      else if (action === 'confirm-approve') {
        const request = this.#approvalRequest;
        const current = request && this.pending().find(item => item.claimId === request.claimId && item.deviceId === request.deviceId);
        if (!current || current.expiresAt <= Date.now()) {
          this.#approvalRequest = undefined; this.page = 'pair'; this.message = 'This request is no longer pending. Check your iPhone.'; this.warning = true; return;
        }
        await this.gateway.approvePairing({ claimId: request.claimId, confirmedCertificate: request.certificate, confirmedFingerprint: request.deviceId });
        this.#approvalRequest = undefined; this.page = 'pair'; this.qrView = false;
        if (request.resource === this.#invitation?.resource) this.clearInvitation();
        this.message = 'iPhone paired. Your phone can now connect to Core.'; this.focusAction('back');
      }
      else if (action === 'approve' || action === 'deny') {
        const request = this.pending()[0];
        if (!request) return;
        if (action === 'approve') {
          this.#approvalRequest = structuredClone(request); this.page = 'approve'; this.qrView = false;
          this.focusAction('cancel-approve');
          return;
        } else { await this.gateway.denyPairing(request.claimId); this.message = 'Device denied.'; }
        if (request.resource === this.#invitation?.resource) this.clearInvitation();
      } else if (action.startsWith('revoke:')) {
        const id = action.slice(7), grant = this.grants().find(item => item.id === id);
        if (!grant) return;
        if (await this.ui.chooseOne('Unpair this device?', [{ value: 'cancel', label: 'Keep access', selected: true }, { value: 'revoke', label: 'Unpair device' }]) === 'revoke') {
          // Core denies locally first, including when Relay is offline.
          const relay = await this.adapter();
          for (const access of this.grants().filter(item => item.deviceId === grant.deviceId)) relay.revokeLocalRelayGrant(access.id);
          this.message = 'Device unpaired. Access is blocked on this Mac immediately.';
        }
      }
    } catch (error) {
      this.message = error.code === 'ADAPTER_UNAVAILABLE' ? 'Core pairing adapter unavailable. Install Core and its Relay dependencies alongside the CLI.' : messages[error.code] || (this.page === 'core' ? 'Core service action failed. Check bzzy-core status and try again.' : 'Settings action failed. Check Core/Relay status and try again.');
      this.warning = true;
    } finally { this.busy = false; this.changed(); }
  }
  close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true; this.clearInvitation();
    return this.closeTask = Promise.resolve(this.gateway?.close()).catch(() => {});
  }
}
