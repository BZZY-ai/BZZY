import { notificationDeliveryStatus } from '@bzzy/core/engine/push-status.js';
import { DefaultModels, chooseDefaultModel } from './default-models.js';
import { settingsActions } from './settings-layout.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { terminalSession } from '@bzzy/core';
import { sessionPermissions } from '@bzzy/core/engine/session-access.js';
import { CoreWorkspaces } from '@bzzy/core/workspaces';
import { providers, getProvider, saveKey, credentialStatus } from './providers.js';
import { sessions, loadSession } from './store.js';
import { copyText } from './clipboard.js';
import { PairingQRImage } from './pairing-qr-image.js';
import { home } from './files.js';
import { updateCommand } from './update-checker.js';
import { transferLibrary, libraryTransferErrorMessage } from './library-ui.js';
import { listSkills } from '@bzzy/core/engine/skills.js';
import { getSkillSignupAliases, setSkillSignupAliases, clearSkillSignupAliases } from '@bzzy/core/engine/skill-account-policy.js';
import { wrap } from './terminal-format.js';
import { WorkerBudgetSettings } from './worker-budget-settings.js';

const loadRelay = () => {
  let location;
  try { location = import.meta.resolve('@bzzy/core/relay'); }
  catch { location = new URL('../../../BZZY-CORE/src/relay/index.js', import.meta.url).href; }
  return import(location);
};
const loadHost = () => import('@bzzy/core/engine/host-service.js');
const loadGmailSettings = () => import('@bzzy/core/engine/gmail-account.js');
const messages = {
  MODE_INCOMPLETE: 'Choose a model for every agent before saving.',
  MODE_MODEL_REQUIRED: 'Choose this agent’s model first.',
  MODE_COUNT_INVALID: 'Choose two or three agents. Delegate always uses two.',
  DEFAULT_MODEL_REQUIRED: 'Choose a provider for this row before its model or effort.',
  DEFAULTS_STALE_CONTEXT: 'Settings changed while the selector was open. Reopen Default models.',
  INVALID_REQUEST: 'Choose a valid provider, model and supported effort for every row in this group.',
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
  SIGNUP_ALIASES_CONTEXT: 'The host, terminal or project changed. Reopen Signup email aliases.',
  SKILL_ACCOUNT_POLICY_STALE: 'The skill or its signup aliases changed. Reopen Signup email aliases before replacing them.',
  SKILL_ACCOUNT_POLICY_INVALID: 'Use 1–32 distinct plain email addresses separated by semicolons or newlines. Check private Core configuration if the list cannot be opened.',
  GMAIL_SETTINGS_STALE: 'The Gmail account changed. Reopen Gmail / email access before replacing it.',
  GMAIL_SETTINGS_INVALID: 'Use a plain Gmail mailbox address and its app password. Check private Core configuration if the account cannot be opened.',
  WORKER_BUDGET_CONTEXT: 'The host, terminal or goal changed. Reopen Agent execution settings.',
  WORKER_BUDGET_STALE: 'Agent execution settings changed. Reopen them before saving or applying.',
  WORKER_BUDGET_INVALID: 'Use positive whole numbers within Core’s supported ranges, or unlimited for a maximum. Maximums must cover the initial allocation.',
  WORKER_BUDGET_ACTIVE: 'Pause the current owner terminal goal before applying settings to its future workers.',
};
const aliasesContextChanged = () => { throw Object.assign(new Error(), { code: 'SIGNUP_ALIASES_CONTEXT' }); };
const directoryPin = location => {
  try {
    const root = fs.realpathSync(location), stat = fs.statSync(root);
    if (!stat.isDirectory()) aliasesContextChanged();
    return { root, device: stat.dev, inode: stat.ino };
  } catch { aliasesContextChanged(); }
};

// Host-only UI controller. Never route secrets, QR payloads or codes through
// model input, session events, transcripts, the runtime API or JSON output.
export class ClientSettings {
  #invitation;
  #qr = [];
  #expiry;
  #approvalRequest;
  #aliasDraft;
  #emailView;
  constructor(ui, { relayLoader = loadRelay, hostLoader = loadHost, workspaces = new CoreWorkspaces(),
    qrImage = new PairingQRImage(), modelPicker = chooseDefaultModel, updater = updateCommand, libraryTransfer = transferLibrary,
    gmailSettingsLoader = loadGmailSettings, workerBudgetLoader } = {}) {
    this.ui = ui; this.relayLoader = relayLoader; this.workspaces = workspaces;
    this.hostLoader = hostLoader; this.hostHome = home();
    this.qrImage = qrImage; this.modelPicker = modelPicker; this.updater = updater;
    this.libraryTransfer = libraryTransfer;
    this.gmailSettingsLoader = gmailSettingsLoader;
    this.workerBudget = new WorkerBudgetSettings(ui, { ...(workerBudgetLoader ? { loader: workerBudgetLoader } : {}),
      capture: () => { try {
        if (home() !== this.hostHome) throw new Error();
        const context = this.aliasContext(), session = context.session && loadSession(context.session);
        return { ...context, goalId: session?.goal?.id || null, goalStatus: session?.goal?.status, executionState: session?.executionState || 'idle',
          canApplyCurrentGoal: Boolean(session && !session.parentSessionId && !session.role && !session.agentId
            && (!session.purpose || session.purpose === 'terminal') && !session.importedUntrusted) };
      } catch { throw Object.assign(new Error(), { code: 'WORKER_BUDGET_CONTEXT' }); } },
      check: context => { try { this.checkAliasContext(context); } catch { throw Object.assign(new Error(), { code: 'WORKER_BUDGET_CONTEXT' }); } },
      isCurrent: () => !this.closed && this.page === 'worker-budget' && this.ui.tui?.panel === 'settings' });
    this.defaults = new DefaultModels(ui, { modelPicker, isCurrent: () => !this.closed && this.page === 'default-models'
      && (!this.ui.tui?.panel || this.ui.tui.panel === 'settings') });
    this.message = ''; this.warning = false; this.focus = 0; this.page = 'main';
  }
  changed() { if (this.closed) return; if (this.ui.tui) this.ui.tui.settingsEnsureFocus = true; this.ui.tui?.schedule(); }
  get pageTitle() {
    return { main: 'Settings', core: 'BZZY Core', keys: 'API keys', 'default-models': 'Default models', pair: 'Pair iPhone', approve: 'Confirm iPhone', 'signup-aliases': 'Signup email aliases', 'email-access': 'Gmail / email access', 'worker-budget': 'Agent execution' }[this.page] || 'Settings';
  }
  get pageSubtitle() {
    return { main: 'Your workspace, connections and defaults', core: 'Service, email, Library, updates and status',
      'default-models': 'Provider, model and effort for every role · Save each group when ready',
      pair: 'Your iPhone · full access through Core', approve: 'Compare the complete fingerprint with your iPhone' }[this.page] || '';
  }
  focusAction(action) {
    const index = settingsActions(this.rows()).findIndex(row => row.action === action);
    if (index >= 0) this.focus = index;
  }
  keyStatus(id = 'deepseek') {
    try {
      return credentialStatus(id);
    } catch { return { unavailable: true }; }
  }
  keyProviders() {
    try { return Object.values(providers()).filter(provider => provider.auth === 'api-key'); }
    catch { return null; }
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
    if (previous === 'default-models') this.defaults.leave();
    if (previous === 'worker-budget') { this.workerBudget.leave(); this.page = 'core'; this.message = ''; this.warning = false; this.focusAction('worker-budget'); this.changed(); return true; }
    this.page = 'main'; this.qrView = false; this.message = ''; this.warning = false;
    this.focusAction(previous === 'core' ? 'core' : previous === 'default-models' ? 'default-models' : previous === 'keys' ? 'deepseek' : 'pair'); this.changed(); return true;
  }
  rows() {
    const rows = [], put = (text = '', tone = 'text', action) => rows.push({ text, tone, action });
    if (this.page === 'default-models') return [...this.defaults.rows(), { text: '← Back', action: 'back', tone: 'muted' }];
    if (this.page === 'worker-budget') return [...this.workerBudget.rows(), { text: '← Back', action: 'back', tone: 'muted' }];
    if (this.page === 'main') {
      const keyProviders = this.keyProviders(), statuses = keyProviders?.map(provider => this.keyStatus(provider.id));
      const configured = statuses?.filter(status => status.saved || status.environment).length;
      rows.push({ text: 'API keys', action: 'deepseek', icon: '⌘', card: true, tone: 'accent',
        detail: !keyProviders ? 'Provider catalog unavailable' : keyProviders.map(provider => provider.name).join(' · ') + ' · ' +
          (statuses.some(status => status.unavailable) ? 'Key status unavailable' : configured ? `${configured}/${keyProviders.length} configured · replace securely` : 'Add your key securely') });
      let folder; try { folder = this.workspaces.settings().root?.path || 'Choose a folder'; } catch { folder = 'Unavailable'; }
      rows.push({ text: 'Default BZZY folder', action: 'workspace-root', icon: '▱', card: true, tone: 'accent', detail: folder });
      rows.push({ text: 'Pair iPhone', action: 'pair', icon: '⌁', card: true, tone: 'accent',
        detail: this.pending().length ? 'iPhone waiting for approval' : this.grants().length ? 'iPhone paired' : 'Full access · QR or code' });
      rows.push({ text: 'Default models', action: 'default-models', icon: '◎', card: true, tone: 'accent', detail: 'Solo · Core · Validate · Delegate · Consensus & Compactor' });
      rows.push({ text: 'BZZY Core', action: 'core', icon: '◈', card: true, tone: 'accent', detail: 'Service, email, Library transfers and updates', value: this.hostStatus ? this.hostLabel() : undefined });
      return rows;
    }
    if (this.page === 'keys') {
      const keyProviders = this.keyProviders();
      if (!keyProviders) put('Provider catalog unavailable', 'warning');
      for (const provider of keyProviders || []) {
        const status = this.keyStatus(provider.id);
        rows.push({ text: provider.name + ' API key', action: 'key:' + provider.id, card: true, icon: '⌘',
          detail: status.unavailable ? 'Unavailable' : status.environment ? 'Environment key · replace securely' : status.saved ? 'Configured · replace securely' : 'Add your key securely' });
      }
      put('← Back', 'muted', 'back'); return rows;
    }
    if (this.page === 'core') {
      rows.push({ text: 'Background service', section: true });
      put(`Status · ${this.hostLabel()}`, 'muted', 'core-status');
      put();
      put('Start', 'accent', 'core-start');
      put('Stop', 'warning', 'core-stop');
      put('Restart', 'accent', 'core-restart');
      rows.slice(-3).forEach(row => { row.inline = 'lifecycle'; row.control = true; });
      rows.push({ text: 'BZZY Library', section: true });
      put('Export Library', 'accent', 'library-export');
      put('Import Library', 'accent', 'library-import');
      rows.slice(-2).forEach(row => { row.inline = 'library-transfer'; });
      put('All skills, specialist agents, workflows and saved goals · current project + Core', 'muted');
      if (this.libraryResult) for (const text of this.libraryResult.split('\n')) put(text, this.libraryResultWarning ? 'warning' : 'accent');
      rows.push({ text: 'Gmail / email access', action: 'email-access', icon: '@', card: true, tone: 'accent',
        detail: 'Read-only Gmail account and approved signup aliases · private to this host' });
      rows.push({ text: 'Agent execution', action: 'worker-budget', icon: '◎', card: true, tone: 'accent',
        detail: 'Initial allocations and optional ceilings · new goals only unless explicitly applied' });
      rows.push({ text: 'Update BZZY CLI + Core', action: 'update-bzzy', icon: '↻', card: true, tone: 'accent',
        detail: 'Check the official release and update both products · this terminal reloads' });
      put(); put('Stop pauses work. Start keeps it paused until you resume.', 'muted');
      const push = notificationDeliveryStatus();
      put(); put(!push.configured ? 'iPhone push alerts · Apple setup needed' : push.message, 'muted');
      if (!push.configured) put('Core model and voice chat still work.', 'muted');
      put(); put('← Back', 'muted', 'back');
      return rows;
    }
    if (['signup-aliases', 'email-access'].includes(this.page)) {
      put('Private email settings are open in this terminal.', 'muted');
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
      put(`Code expires at ${new Date(this.#invitation.expiresAt).toLocaleTimeString()} · access lasts 30 days`, 'muted');
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
    put(); put('← Back', 'muted', 'back');
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
      sessionAccess: true, shareAccess: true, agentAccess: true, ttlSeconds: 600, grantTtlSeconds: 30 * 86400 });
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
  async saveDeepseek(id = 'deepseek') {
    const provider = getProvider(id);
    let key = (await this.ui.secret(`${provider.name} API key · hidden · Enter saves · Esc cancels`))?.trim();
    if (!key) return;
    if (key.length > 8192 || /\s|[\x00-\x1f\x7f-\x9f]/u.test(key)) { this.message = 'Use an API key without whitespace or control characters.'; this.warning = true; return; }
    if (this.closed) return;
    saveKey(provider.id, key); key = undefined;
    delete process.env[provider.envKey];
    this.ui.accountMonitor?.close(); this.ui.accountMonitor = null;
    if (this.ui.accountStatus) delete this.ui.accountStatus[id];
    this.message = 'API key saved. New requests will use it.';
  }
  async configureWorkspace() {
    const shown = this.workspaces.settings();
    const location = await this.ui.ask(`BZZY root · absolute host folder${shown.root ? ` · current: ${shown.root.path}` : ''} · created if missing · Esc cancels`);
    if (!location?.trim() || this.closed) return;
    const saved = this.workspaces.configure({ path: location.trim(), create: true }, { expectedRevision: shown.revision, requestId: randomUUID() });
    this.message = `BZZY root saved: ${saved.root.path}. Existing terminal directories are preserved.`;
  }
  aliasContext() {
    const ui = this.ui, session = ui.sessionId && loadSession(ui.sessionId);
    if (ui.sessionId && !session) aliasesContextChanged();
    const cwd = session?.cwd || ui.launchCwd || ui.tui.cwd || process.cwd();
    const projectRoot = session?.projectRoot || cwd;
    return { home: home(), session: ui.sessionId, tab: ui.activeTab, next: ui.nextSession?.id,
      cwd, projectRoot, cwdPin: directoryPin(cwd), projectPin: directoryPin(projectRoot) };
  }
  checkAliasContext(before) {
    if (this.closed || this.ui.closed || !this.ui.interactive || this.ui.json || !this.ui.tui
      || this.ui.settings !== this || this.ui.tui.panel !== 'settings' || home() !== this.hostHome) aliasesContextChanged();
    const current = this.aliasContext();
    for (const key of ['home', 'session', 'tab', 'next', 'cwd', 'projectRoot']) if (current[key] !== before[key]) aliasesContextChanged();
    for (const key of ['cwdPin', 'projectPin']) for (const field of ['root', 'device', 'inode']) {
      if (current[key][field] !== before[key][field]) aliasesContextChanged();
    }
  }
  async emailAccess() {
    if (this.ui.json || this.ui.input?.isTTY === false || this.ui.output?.isTTY === false) aliasesContextChanged();
    const ui = this.ui, before = this.aliasContext(); this.checkAliasContext(before);
    const backend = await this.gmailSettingsLoader(); this.checkAliasContext(before);
    let state = backend.getGmailSettings(), nested = false, contextError;
    const previous = ui.privateView, view = { title: 'Gmail / email access', lines: [], qr: [], actions: [], onCancel: () => ui.reader?.close() };
    this.#emailView = view; this.page = 'email-access'; ui.privateView = view;
    ui.tui.textSelection = null; if (ui.tui.copyMode) ui.tui.setCopyMode(false);
    const check = () => { this.checkAliasContext(before); if (this.#emailView !== view || !nested && ui.privateView !== view) aliasesContextChanged(); };
    const monitor = setInterval(() => {
      try { check(); }
      catch (error) { contextError = error; view.lines = []; view.actions = []; ui.reader?.close(); ui.tui?.schedule(); }
    }, 100); monitor.unref();
    const ask = async (question, options) => {
      check(); const value = await ui.ask(question, options);
      if (contextError) throw contextError;
      check(); return value;
    };
    try {
      while (!this.closed) {
        view.lines = [`Gmail mailbox login · ${state.address || 'Not configured'}`,
          `App password · ${state.configured ? '•••••••• · saved' : 'Not configured'}`,
          'Use approved aliases for website login / registration, rather than the Gmail mailbox login.',
          'Aliases must already forward to this mailbox; configure forwarding outside BZZY.',
          'General email requests read the connected main inbox.',
          'Account credentials and aliases stay on this host and are excluded from Library exports.'];
        view.actions = [{ value: 'configure', label: state.configured ? 'Replace account' : 'Configure Gmail' },
          { value: 'aliases', label: 'Login / signup aliases' }, ...(state.configured ? [{ value: 'disconnect', label: 'Disconnect' }] : []),
          { value: '/cancel', label: 'Back' }];
        view.actionMode = true; view.actionFocus = 0; ui.tui.schedule();
        const action = await ask('Arrows choose · Enter opens · Esc back');
        view.actionMode = false;
        if (action == null || action === '/cancel') return;
        view.notice = ''; view.actions = [];
        if (action === 'aliases') {
          view.lines = []; nested = true; ui.privateView = previous;
          try { await this.signupAliases(); }
          finally { nested = false; if (!this.closed) { this.page = 'email-access'; ui.privateView = view; } }
          check();
          if (this.message) { view.notice = this.message; this.message = ''; }
        } else if (action === 'configure') {
          view.lines = ['Save authorizes read-only access to this Gmail mailbox from owner terminal chats and goals.',
            'Persistent Agents and workers do not inherit this account access.',
            'Use a Gmail app password. It is stored privately and is never given to a model.'];
          const address = (await ask('Main Gmail mailbox login · Enter continues · Esc cancels', { initialValue: state.address || '' }))?.trim();
          if (!address) continue;
          let appPassword = await ask('Gmail app password · hidden · Enter saves read-only access · Esc cancels', { hidden: true });
          if (!appPassword?.trim()) continue;
          try {
            state = backend.setGmailSettings({ address, appPassword }, { expectedRevision: state.revision || 0 });
            view.notice = 'Gmail account saved on this host. Read-only access is authorized.'; view.noticeTone = 'success';
          } catch (error) {
            if (error.code !== 'GMAIL_SETTINGS_INVALID') throw error;
            view.notice = messages.GMAIL_SETTINGS_INVALID; view.noticeTone = 'warning';
          } finally { appPassword = undefined; }
        } else if (action === 'disconnect') {
          view.lines = ['Remove this host’s Gmail mailbox credentials and authorization? Signup aliases remain configured separately.'];
          view.actions = [{ value: 'keep', label: 'Keep account' }, { value: 'disconnect', label: 'Disconnect Gmail' }];
          view.actionMode = true; view.actionFocus = 0;
          const confirmed = await ask('Choose Disconnect Gmail to remove local mailbox access · Esc cancels');
          view.actionMode = false;
          if (confirmed !== 'disconnect') continue;
          state = backend.clearGmailSettings({ expectedRevision: state.revision || 0 });
          view.notice = 'Gmail disconnected on this host. Signup aliases were preserved.'; view.noticeTone = 'success';
        }
      }
    } finally {
      clearInterval(monitor); view.lines = []; view.actions = []; view.notice = ''; view.actionMode = false; view.onCancel = null;
      this.#emailView = undefined;
      if (ui.privateView === view) ui.privateView = previous;
      this.page = 'core'; this.focusAction('email-access');
      ui.tui.lastFrame = []; ui.tui.paintedFrame = null; this.changed();
    }
  }
  async signupAliases() {
    if (this.ui.json || this.ui.input?.isTTY === false || this.ui.output?.isTTY === false) aliasesContextChanged();
    const before = this.aliasContext(); this.checkAliasContext(before);
    const entries = [];
    for (const scope of ['project', 'global']) {
      let offset = 0;
      do {
        const page = listSkills({ projectRoot: before.projectPin.root, scope, offset, limit: 100 });
        entries.push(...page.skills); offset = page.nextOffset;
      } while (offset !== null);
    }
    if (!entries.length) { this.message = 'No skills are installed for this project or Core. Install a skill first.'; return; }
    const choices = [{ value: 'back', label: '← Back', selected: true }, ...entries.map((entry, index) => ({ value: String(index),
      label: `${entry.name} · ${entry.scope === 'global' ? 'Core' : 'project'}`,
      description: entry.enabled ? 'Enabled skill' : 'Disabled skill · addresses do not enable it' }))];
    let preferred = entries.findIndex(entry => entry.name === 'read-emails');
    while (!this.closed) {
      const selected = preferred >= 0 ? String(preferred) : await this.ui.chooseOne('Signup email aliases · choose a skill', choices);
      preferred = -1;
      this.checkAliasContext(before);
      if (selected == null || selected === 'back') return;
      const entry = entries.find((_entry, index) => String(index) === selected);
      if (!entry) aliasesContextChanged();
      const options = { projectRoot: before.projectPin.root, scope: entry.scope,
        expectedSkillId: entry.id, expectedSkillVersion: entry.version };
      this.#aliasDraft = { before, entry, options, policy: getSkillSignupAliases(entry.id, options) };
      const another = await this.editSignupAliases();
      if (!another) return;
    }
  }
  async editSignupAliases() {
    const draft = this.#aliasDraft, ui = this.ui, previous = ui.privateView;
    const view = { title: `Login / signup aliases · ${draft.entry.name} (${draft.entry.scope === 'global' ? 'Core' : 'project'}${draft.entry.enabled ? '' : ' · disabled'})`,
      lines: [], qr: [], actions: [], onCancel: () => ui.reader?.close() };
    const check = () => { this.checkAliasContext(draft.before); if (this.#aliasDraft !== draft || ui.privateView !== view) aliasesContextChanged(); };
    this.page = 'signup-aliases';
    ui.tui.textSelection = null; if (ui.tui.copyMode) ui.tui.setCopyMode(false);
    ui.privateView = view; this.changed();
    // A session/host switch must scrub the private screen even without input.
    let contextError;
    const monitor = setInterval(() => {
      try { check(); }
      catch (error) { contextError = error; view.lines = []; view.actions = []; ui.reader?.close(); ui.tui?.schedule(); }
    }, 100); monitor.unref();
    const ask = async (question, options) => {
      check(); const answer = await ui.ask(question, options);
      if (contextError) throw contextError;
      check(); return answer;
    };
    let aliasOffset = 0, previousOffsets = [];
    try {
      while (!this.closed) {
        const aliases = draft.policy?.approvedSignupAliases || [];
        const width = Math.max(1, (ui.output.columns || 80) - 5), available = Math.max(1, (ui.output.rows || 24) - 15);
        let end = aliasOffset, used = 0;
        while (end < aliases.length) {
          const lines = wrap(aliases[end], width).length;
          if (end > aliasOffset && used + lines > available) break;
          used += lines; end++;
        }
        view.lines = aliases.length ? [...aliases.slice(aliasOffset, end), ...(aliasOffset || end < aliases.length ? [`Addresses ${aliasOffset + 1}–${end} of ${aliases.length}`] : [])]
          : ['No approved login / signup aliases configured.'];
        view.actions = [{ value: 'edit', label: 'Edit' }, ...(aliases.length ? [{ value: 'clear', label: 'Clear' }] : []),
          ...(aliasOffset ? [{ value: 'previous', label: 'Previous' }] : []), ...(end < aliases.length ? [{ value: 'next', label: 'Next' }] : []),
          { value: 'skill', label: 'Choose skill' }, { value: '/cancel', label: 'Back' }];
        view.actionMode = true; view.actionFocus = 0; ui.tui.schedule();
        const action = await ask('Private to this host · arrows choose · Enter opens · Esc back');
        view.actionMode = false;
        if (action == null || action === '/cancel') return false;
        if (action === 'skill') return true;
        if (action === 'next') { previousOffsets.push(aliasOffset); aliasOffset = end; continue; }
        if (action === 'previous') { aliasOffset = previousOffsets.pop() || 0; continue; }
        view.notice = ''; view.actions = [];
        const options = { ...draft.options, expectedRevision: draft.policy?.revision || 0 };
        if (action === 'edit') {
          const value = await ask('Email addresses for login / registration · semicolons or pasted newlines · Enter saves · Esc cancels', { initialValue: aliases.join(';') });
          if (!value?.trim()) continue;
          try {
            draft.policy = setSkillSignupAliases(draft.entry.id, value.trim().split(/[;\r\n]+/).map(alias => alias.trim()).filter(Boolean), options);
            aliasOffset = 0; previousOffsets = [];
            view.notice = 'Signup email aliases saved on this host.'; view.noticeTone = 'success';
          } catch (error) {
            if (error.code !== 'SKILL_ACCOUNT_POLICY_INVALID') throw error;
            view.notice = messages.SKILL_ACCOUNT_POLICY_INVALID; view.noticeTone = 'warning';
          }
        } else if (action === 'clear') {
          view.lines = ['Clear this skill’s approved signup email aliases on this host? The skill remains installed.'];
          view.actions = [{ value: 'keep', label: 'Keep aliases' }, { value: 'clear', label: 'Clear aliases' }];
          view.actionMode = true; view.actionFocus = 0;
          const confirmed = await ask('Choose Clear aliases to remove the approved address list · Esc cancels');
          view.actionMode = false;
          if (confirmed !== 'clear') continue;
          const result = clearSkillSignupAliases(draft.entry.id, options);
          draft.policy = { skillId: result.skillId, approvedSignupAliases: [], revision: result.revision };
          aliasOffset = 0; previousOffsets = [];
          view.notice = 'Signup email aliases cleared on this host.'; view.noticeTone = 'success';
        }
      }
    } finally {
      clearInterval(monitor); view.lines = []; view.actions = []; view.notice = ''; view.actionMode = false; view.onCancel = null;
      this.#aliasDraft = undefined;
      if (ui.privateView === view) ui.privateView = previous;
      if (this.page === 'signup-aliases') { this.page = 'core'; this.focusAction('email-access'); }
      ui.tui.lastFrame = []; ui.tui.paintedFrame = null; this.changed();
    }
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
    if (action !== 'core-restart') this.ui.coreLifecycleInterrupted = true;
    this.ui.hostMetrics = null;
    try {
      await host[{ 'core-start': 'startCoreHost', 'core-stop': 'stopCoreHost', 'core-restart': 'restartCoreHost' }[action]]();
      this.message = action === 'core-stop' ? 'Core stopped. Work is saved and paused.'
        : action === 'core-restart' ? 'Core restarted. Active work continues; paused work stays paused.' : 'Core is running. Paused work stays paused.';
    } finally {
      this.hostStatus = undefined;
      await this.refreshHost().catch(() => {});
    }
  }
  async run(action) {
    if (!this.ui.interactive || !this.ui.tui || this.ui.closed || this.closed || this.busy) return;
    if (action !== 'modes' && !settingsActions(this.rows()).some(row => row.action === action)) return;
    this.busy = true; this.message = ''; this.warning = false; this.changed();
    try {
      if (action === 'update-bzzy') {
        this.busy = false; this.changed();
        await this.updater(this.ui);
        return;
      } else if (action === 'default-models' || action === 'modes') { this.page = 'default-models'; this.defaults.open(); this.focus = 0; }
      else if (action.startsWith('defaults:')) { const message = await this.defaults.run(action); if (message) this.message = message; }
      else if (action === 'workspace-root') await this.configureWorkspace();
      else if (action === 'deepseek') { this.page = 'keys'; this.focus = 0; }
      else if (action.startsWith('key:')) await this.saveDeepseek(action.slice(4));
      else if (action === 'core') { this.page = 'core'; this.focus = 0; await this.refreshHost(); }
      else if (action === 'core-status') await this.refreshHost();
      else if (['core-start', 'core-stop', 'core-restart'].includes(action)) await this.controlHost(action);
      else if (action === 'email-access') await this.emailAccess();
      else if (action === 'worker-budget') { this.page = 'worker-budget'; this.focus = 0; await this.workerBudget.open(); }
      else if (action.startsWith('worker-budget:')) { const message = await this.workerBudget.run(action); if (message) this.message = message; }
      else if (['library-export', 'library-import'].includes(action)) {
        if (home() !== this.hostHome) throw Object.assign(new Error(), { code: 'HOST_CONTEXT_CHANGED' });
        if (this.ui.coreLifecycleInterrupted) throw Object.assign(new Error(), { code: 'CORE_STOPPED' });
        const session = this.ui.sessionId && loadSession(this.ui.sessionId);
        if (this.ui.sessionId && !session) throw Object.assign(new Error(), { code: 'CONFLICT' });
        this.libraryResult = ''; this.libraryResultWarning = false; this.changed();
        await this.libraryTransfer(action === 'library-export' ? 'export' : 'import', session?.cwd || this.ui.launchCwd || this.ui.tui.cwd || process.cwd(), this.ui, {
          onComplete: (_result, message) => { if (!this.closed) { this.libraryResult = message; this.changed(); } },
        });
        this.ui.tui.bodyCache = null;
      }
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
      this.message = error.code === 'ADAPTER_UNAVAILABLE' ? 'Core pairing adapter unavailable. Install Core and its Relay dependencies alongside the CLI.' : messages[error.code] || (action.startsWith('library-') ? libraryTransferErrorMessage(error) : action === 'email-access' ? 'Gmail / email access is unavailable. Check private Core configuration and try again.' : this.page === 'core' ? 'Core service action failed. Check bzzy-core status and try again.' : 'Settings action failed. Check Core/Relay status and try again.');
      this.warning = true;
      if (action === 'library-import' && error.importDiagnostic) {
        this.libraryResult = this.message; this.libraryResultWarning = true;
        this.message = 'Library import blocked. See the details above.';
      }
    } finally { this.busy = false; this.changed(); }
  }
  close() {
    if (this.closeTask) return this.closeTask;
    this.closed = true; this.defaults.leave(); this.workerBudget.leave(); this.clearInvitation();
    if (this.#aliasDraft || this.#emailView) { this.#aliasDraft = undefined; this.#emailView = undefined; this.ui.reader?.close(); }
    return this.closeTask = Promise.resolve(this.gateway?.close()).catch(() => {});
  }
}
