import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launch, root, version, assertCodexVersion, backendCommand } from '../process.js';
import { home, privateDir, writeJson, saveSession } from '../store.js';
import { apiKey, providerModelCapabilities, providerEffortPolicy, providerEffortCapabilities } from '../providers.js';
import { Rpc, BackendClosedError } from '../rpc.js';
import { backendIsolation } from '../policy.js';
import { taskTools } from '../tools.js';
import { agentInstructions, reasoningEffort } from '../instructions.js';
import { processIdentity } from '../recovery.js';
import { codexHome, subscriptionEnvironment, subscriptionStatus } from '../auth.js';
import { BackendTraffic } from '../backend-traffic.js';
import { conversationPrompt, completeConversationHandoff, conversationCursor } from '../conversation.js';
import { codexQuota } from '../account-status.js';
import { ActivityReporter } from '../live-activity.js';
import { agentPermissionProfile, isolatedAgentCodexHome, tomlValue } from '../agent-execution.js';
import { learningPermissionProfile, learningDisabledFeatures, learningCodexHome } from '../learning-backend.js';
import { markBackendStartupFailure } from '../backend-startup.js';
import { recordBackendDiagnostics } from '../session-diagnostics.js';
import { nativeContextBudget, prepareNativeReadiness, acknowledgeNativeReadiness, recordNativeCompaction,
  pendingNativeRefresh, consumeNativeRefresh, updateNativeRefresh } from '../native-context.js';
import { nativeInputEstimate, assertNativeInputFits, observeContextPressure, nativeGoalTokenBudget } from '../native-context.js';
import { toolSchemaManifest, observeNativeGoalProgress, recordNativeCompactionStall } from '../native-context.js';
import { database, digest, getRecord, listRecords } from '../database.js';
import { delegationUsage, assignmentFilter, assignmentParameters } from '../delegation-usage.js';
import { identityAlive } from '../process-identity.js';
import { recordWorkObservation } from '../episode.js';
import { hydrateModelContext } from '../model-context.js';
import { observeRunUsage } from '../usage-ledger.js';
import { beginSessionCost, observeSessionCost } from '../session-cost.js';

export { codexHome } from '../auth.js';

function rotateNativeThread(session) {
  if (session.engineThreadId) {
    // A fresh native goal counts from zero. Preserve all prior consumption so
    // a schema/home migration cannot replenish the owner's remaining budget.
    preserveNativeGoalUsage(session);
    if (Number.isFinite(session.usage?.tokens)) session.engineTokenOffset = Math.max(session.engineTokenOffset || 0, session.usage.tokens);
  }
  session.engineThreadId = null;
  session.conversationHandoff = { pending: true, throughSeq: conversationCursor(session.id) };
}

function missingNativeThread(error, threadId) {
  if (![-32600, -32001].includes(error?.rpcCode) || typeof threadId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(threadId)) return false;
  return error.message === `thread not found: ${threadId}` || error.message === `no rollout found for thread id ${threadId}`;
}

function preserveNativeGoalUsage(session) {
  const used = [session.goal?.nativeTokensUsed, session.goal?.supervisorTokensUsed].filter(Number.isFinite);
  if (session.goal && used.length) session.goal.nativeTokenOffset = Math.max(session.goal.nativeTokenOffset || 0, ...used);
}

export function codexDynamicTools(session, options = {}) {
  if (!options.toolHost || options.learningReview) return [];
  return taskTools(session, { goalMode: session.mode === 'delegate' ? true : options.goalMode })
    .filter(tool => !['get_goal', 'update_goal'].includes(tool.name)).map(tool => ({ type: 'function', name: tool.name,
      description: tool.name === 'delegate' ? tool.description + ' Available only during an explicit /goal; ordinary chat cannot launch assignments.' : tool.description,
      inputSchema: tool.inputSchema }));
}

// Native tools are fixed when a thread is created. The protocol version alone
// cannot detect chat -> goal routing or a changed role/skill availability.
export function synchronizeCodexTools(session, options = {}) {
  const tools = codexDynamicTools(session, options), expected = toolSchemaManifest(tools), prior = session.nativeBackendReadiness;
  if (!options.toolHost) return { tools, rotated: false };
  const inherited = prior?.backend === 'codex' && prior.threadRef === digest(session.engineThreadId || '') && prior.tools?.sha256 === expected.sha256;
  const changed = session.coreSkillsProtocol !== 7 || !inherited;
  const rotated = Boolean(session.engineThreadId && changed);
  if (rotated) {
    const previous = prior?.tools?.names || [];
    recordBackendDiagnostics(session, { method: 'native-tool-schema', outcome: 'rotation-required',
      reason: session.coreSkillsProtocol !== 7 ? 'protocol-changed' : prior?.tools?.sha256 ? 'tool-schema-changed' : 'inherited-schema-unknown',
      toolsSource: 'fresh-thread-required', tools: tools, reportedTools: previous });
    rotateNativeThread(session);
  }
  session.coreSkillsProtocol = 7;
  return { tools, rotated };
}

export function codexSandboxMode(options = {}) {
  // A strict-policy worker is already inside bzzy's bubblewrap filesystem
  // boundary. Avoid nesting Codex's command sandbox there: nested isolation can
  // prevent every local command from starting, especially in root-run services.
  // Keep Codex's own sandbox when it is needed to separate tool networking from
  // the model connection.
  if (options.yolo || options.strictPolicy && options.policy?.network !== 'disabled') return 'danger-full-access';
  return options.policy?.mode || 'workspace-write';
}

export function codexLaunch(provider, session, options = {}) {
  // Old conversations remain resumable in the store where their thread lives.
  const legacy = path.join(home(), 'codex');
  if (options.agentScope || options.learningReview) {
    const isolatedHome = options.learningReview ? learningCodexHome(provider, session) : isolatedAgentCodexHome(provider, session);
    if (session.engineHome !== isolatedHome || session.agentToolPolicy !== 1) {
      rotateNativeThread(session);
    }
    session.engineHome = isolatedHome; session.agentToolPolicy = 1;
  }
  session.engineHome ||= session.engineThreadId && fs.existsSync(legacy) ? legacy : (provider.auth === 'api-key' ? session.backendHomes?.codexApi : session.backendHomes?.codex) || codexHome(provider);
  privateDir(session.engineHome);
  const args = ['app-server', '--listen', 'stdio://', ...(options.learningReview ? ['--strict-config'] : ['--enable', 'goals'])];
  const env = { ...subscriptionEnvironment('codex'), ...options.networkEnv, CODEX_HOME: session.engineHome };
  const override = (key, value) => args.push('-c', `${key}=${tomlValue(value)}`);
  if (options.documentOnly) {
    override('features.shell_tool', false); override('features.multi_agent', false);
    args.push('-c', 'mcp_servers={}');
  }
  override('approval_policy', options.learningReview || options.agentScope || options.yolo || options.scopedAutonomy ? 'never' : 'on-request');
  if (options.learningReview) {
    const executable = fs.realpathSync(backendCommand('codex'));
    override('default_permissions', learningPermissionProfile);
    override(`permissions.${learningPermissionProfile}`, { filesystem: { ':root': 'deny', ':minimal': 'read',
      [session.cwd]: 'read', [executable]: 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny' }, network: { enabled: false } });
    for (const feature of learningDisabledFeatures) override(`features.${feature}`, false);
    override('features.skip_host_skill_discovery', true);
    override('shell_environment_policy.inherit', 'none'); override('shell_environment_policy.set', { PATH: '/usr/bin:/bin' });
    override('mcp_servers', {}); override('web_search', 'disabled');
    override('project_doc_max_bytes', 0); override('project_doc_fallback_filenames', []);
    // Codex splits CLI override keys on dots even inside quoted path segments.
    // Keep literal project paths (including .bzzy) inside a TOML table value.
    override('projects', { [session.cwd]: { trust_level: 'untrusted' } });
  } else if (options.agentScope) {
    const executable = fs.realpathSync(backendCommand('codex'));
    override('default_permissions', agentPermissionProfile);
    override(`permissions.${agentPermissionProfile}`, { filesystem: { ':root': 'deny', ':minimal': 'read',
      [session.cwd]: 'read', [executable]: 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny' }, network: { enabled: false } });
    for (const feature of ['shell_tool', 'multi_agent', 'multi_agent_v2', 'view_image', 'image_generation', 'apps', 'plugins', 'remote_plugin', 'hooks', 'skill_search', 'skill_mcp_dependency_install']) override(`features.${feature}`, false);
    override('features.skip_host_skill_discovery', true);
    override('shell_environment_policy.inherit', 'none'); override('shell_environment_policy.set', { PATH: '/usr/bin:/bin' });
    override('mcp_servers', {}); override('web_search', 'disabled');
    override('projects', { [session.cwd]: { trust_level: 'untrusted' } });
  } else {
    override('sandbox_mode', codexSandboxMode(options));
    if (options.policy?.network === 'disabled') override('sandbox_workspace_write.network_access', false);
    else if (options.strictPolicy) override('sandbox_workspace_write.network_access', true);
  }
  const effort = reasoningEffort(session, options);
  if (effort) override('model_reasoning_effort', effort);
  session.reasoningEffort = effort || 'provider default';
  const contextBudget = nativeContextBudget(provider, session);
  session.nativeContextBudget = contextBudget;
  if (options.scopedAutonomy) {
    override('agents.max_threads', 1); override('agents.enabled', false);
    override('features.multi_agent', false); override('features.multi_agent_v2', false);
  }
  if (provider.auth === 'api-key') {
    env.BZZY_PROVIDER_API_KEY = apiKey(provider);
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'model-template.json'), 'utf8'));
    Object.assign(catalog, {
      slug: session.model, display_name: session.model, description: `${provider.name} via bzzy`,
      prefer_websockets: false, context_window: contextBudget.tokens, max_context_window: contextBudget.maxTokens,
      default_reasoning_level: provider.reasoningEffort || 'high', default_reasoning_summary: 'none',
      tool_mode: null, shell_type: 'shell_command', model_specialty: null,
      guardian: null, node_repl_auto_review_required: false, requires_sandboxed_review: false,
      auto_review_model_override: null, use_responses_lite: false,
      model_messages: { instructions_template: fs.readFileSync(path.join(root, 'assets', 'agent-instructions.md'), 'utf8') },
    });
    const capabilities = providerModelCapabilities(provider, session.model, session.modelCapabilities);
    if (Number.isSafeInteger(contextBudget.maxInputTokens) && contextBudget.maxInputTokens > 0) {
      const reserve = nativeInputEstimate({ contextBudget }).outputHeadroomTokens;
      const threshold = Math.max(1, Math.min(Math.floor(contextBudget.maxInputTokens * 0.9), contextBudget.tokens - reserve));
      // Codex 0.162's supported model_auto_compact_token_limit controls native
      // growing-history planning independently of the model's total window.
      catalog.auto_compact_token_limit = threshold;
      override('model_auto_compact_token_limit', threshold);
      contextBudget.nativeAutoCompactTokens = threshold;
    }
    if (provider.catalogFormat === 'experiential') {
      // A gateway slug does not inherit the template model's capabilities.
      // Unknown context uses a local planning budget, not an upstream claim.
      catalog.context_window = catalog.max_context_window = contextBudget.tokens;
      catalog.input_modalities = ['text'];
      catalog.default_reasoning_level = null; catalog.supported_reasoning_levels = [];
      catalog.supports_reasoning_summary_parameter = false; catalog.supports_reasoning_summaries = false;
    }
    const effortPolicy = providerEffortPolicy(provider), effortCapabilities = providerEffortCapabilities(provider, session.model, session.modelCapabilities);
    if (capabilities?.defaultEffort && !effortPolicy) catalog.default_reasoning_level = capabilities.defaultEffort;
    const supported = effortCapabilities?.supportedEfforts || provider.supportedEfforts;
    if (capabilities?.supportsEffort === false && provider.catalogFormat === 'experiential' && !effortPolicy) {
      catalog.default_reasoning_level = null; catalog.supported_reasoning_levels = [];
    } else if (supported?.length) {
      catalog.supported_reasoning_levels = supported.map(effort => ({ effort, description: effort }));
      if (!supported.includes(catalog.default_reasoning_level) && !(provider.catalogFormat === 'experiential' && catalog.default_reasoning_level == null)) catalog.default_reasoning_level = supported[0];
    }
    if (capabilities?.inputModalities?.length) catalog.input_modalities = capabilities.inputModalities;
    const catalogPath = path.join(home(), 'runtime', `${session.id}-models.json`);
    writeJson(catalogPath, { models: [catalog] });
    override('model_catalog_json', catalogPath);
    override('model_provider', 'bzzy_api');
    override('model_providers.bzzy_api.name', provider.name);
    override('model_providers.bzzy_api.base_url', provider.baseUrl);
    override('model_providers.bzzy_api.env_key', 'BZZY_PROVIDER_API_KEY');
    override('model_providers.bzzy_api.wire_api', 'responses');
    override('model_providers.bzzy_api.requires_openai_auth', false);
    override('model_providers.bzzy_api.supports_websockets', false);
    override('model_providers.bzzy_api.capabilities.remote_compaction', 'unsupported');
    override('web_search', 'disabled');
  } else override('model_provider', 'openai');
  return { args, env, contextBudget };
}

export class CodexEngine {
  constructor(provider, session, options, ui) {
    Object.assign(this, { provider, session, options, ui });
    this.activeTurns = new Set();
    this.streamedItems = new Map();
    this.operation = null;
    this.interrupted = false;
    this.startedTurns = 0;
    this.limiting = false;
    this.goalUpdates = 0;
    this.finalizedItems = new Set();
    this.externalTools = new Set();
    this.progressClock = Date.now;
    this.traffic = new BackendTraffic(session, ui);
    this.progress = options.activityReporter || new ActivityReporter(session, ui);
  }

  async open() {
    if (this.rpc && !this.rpc.closed) {
      const expected = toolSchemaManifest(codexDynamicTools(this.session, this.options));
      if (!this.options.toolHost || this.session.nativeBackendReadiness?.tools?.sha256 === expected.sha256) return;
      if (this.operation || this.activeTurns.size) throw Object.assign(new Error('Native tool schemas changed during active work. Pause and resume at an authorized runner boundary.'), { code: 'NATIVE_TOOL_SCHEMA_CHANGED' });
      await this.close(); this.rpc = null;
    }
    let startupStage = 'configuration';
    const startedTurnsBeforeOpen = this.startedTurns;
    try {
      this.closing = null;
      if (this.session.nativeContext?.refresh?.state === 'dispatching') {
        updateNativeRefresh(this.session, { state: 'uncertain', reason: 'native-refresh-recovery-requires-safe-prompt' });
      }
      const nativeTools = synchronizeCodexTools(this.session, this.options).tools;
      startupStage = 'version';
      const installed = version('codex');
      assertCodexVersion(installed);
      startupStage = 'configuration';
      if (this.provider.auth === 'api-key' && !this.options.learningReview && !this.options.documentOnly && !this.options.documentTaskInstructions) {
        this.metadataAbort = new AbortController();
        const metadata = await hydrateModelContext(this.session, { signal: this.metadataAbort.signal });
        if (this.interrupted || this.metadataAbort.signal.aborted) return;
        if (metadata.provenance?.source === 'source-changed') throw Object.assign(new Error('Model selection or provider configuration changed while preparing context metadata. Resume with the current saved selection.'), { code: 'MODEL_CONTEXT_CHANGED' });
        recordBackendDiagnostics(this.session, { method: 'model-context-metadata', outcome: metadata.provenance?.source || 'unavailable',
          model: this.session.model, contextBudget: { metadata: metadata.provenance, changed: metadata.changed } });
      }
      const launchConfig = codexLaunch(this.provider, this.session, this.options);
      if (launchConfig.contextBudget.source === 'conservative-local-fallback' && !this.contextFallbackNoticed) {
        this.contextFallbackNoticed = true;
        this.ui.event('info', { message: 'Model capacity metadata is unavailable. BZZY is using an assumed local 32,768-token planning window; this is not the provider’s verified limit. Refresh model metadata or select a model with known capacity if context pressure continues.' });
      }
      this.nativeToolSchemaBytes = Buffer.byteLength(JSON.stringify(nativeTools)); this.nativeToolsKnown = true;
      const instructions = this.prepareInstructions(this.inputSource || '');
      if (this.provider.auth === 'subscription' && !subscriptionStatus(this.provider, { directory: launchConfig.env.CODEX_HOME }).available) throw new Error(`Codex / ChatGPT subscription authentication is unavailable in ${launchConfig.env.CODEX_HOME}. Run bzzy auth codex with the same BZZY_CODEX_HOME to sign in.`);
      startupStage = 'process_spawn';
      this.rpc = new Rpc(launch('codex', launchConfig.args, { env: launchConfig.env, cwd: this.session.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        canonicalExecutable: Boolean(this.options.agentScope || this.options.learningReview),
        isolation: !this.options.agentScope && this.options.strictPolicy ? backendIsolation('codex', launchConfig.env, this.session.cwd, this.options.policy) : null }), (method, params) => this.request(method, params));
      this.session.backendProcess = processIdentity(this.rpc.child.pid); saveSession(this.session);
      this.rpc.on('notification', (method, params) => this.notification(method, params));
      this.rpc.on('failure', error => this.operation?.reject(error));
      startupStage = 'initialize';
      const initialization = await this.rpc.request('initialize', { clientInfo: { name: 'bzzy', title: 'bzzy', version: '0.2.0' }, capabilities: { experimentalApi: true } });
      // No supported backend currently promises a host-refresh steer contract.
      // Unknown capability stays pending; normal user steering is unchanged.
      this.hostRefreshCapability = initialization.capabilities?.hostContextRefresh || null;
      this.rpc.notify('initialized');
      if (this.options.agentScope || this.options.learningReview) {
        startupStage = 'permission_profile';
        const profileId = this.options.learningReview ? learningPermissionProfile : agentPermissionProfile;
        const profiles = await this.rpc.request('permissionProfile/list', {});
        if (!profiles.data?.some(profile => profile.id === profileId && profile.allowed === true)) throw new Error('This Codex backend cannot enforce the required isolated permission profile. No unrestricted fallback was started.');
      }
      const policy = this.options.learningReview ? { approvalPolicy: 'never', permissions: learningPermissionProfile }
        : this.options.agentScope ? { approvalPolicy: 'never', permissions: agentPermissionProfile }
        : { approvalPolicy: this.options.yolo || this.options.scopedAutonomy ? 'never' : 'on-request', sandbox: codexSandboxMode(this.options) };
      const params = { cwd: this.session.cwd, ...policy,
        developerInstructions: instructions };
      this.nativeInstructions = params.developerInstructions;
      if (this.options.learningReview) { params.dynamicTools = []; params.ephemeral = true; }
      const effort = reasoningEffort(this.session, this.options);
      if (effort) params.config = { model_reasoning_effort: effort };
      if (this.session.model) params.model = this.session.model;
      if (this.provider.auth === 'api-key') params.modelProvider = 'bzzy_api';
      let resumed = false;
      if (this.session.engineThreadId) {
        startupStage = 'thread_resume';
        this.threadId = this.session.engineThreadId;
        let snapshot;
        try { snapshot = await this.rpc.request('thread/goal/get', { threadId: this.threadId }); }
        catch (error) {
          // A read-only miss alone does not prove the rollout is gone. Ask the
          // backend to resume it once before deciding whether to replace it.
          if (!missingNativeThread(error, this.threadId)) throw error;
        }
        if (snapshot?.goal?.status === 'active') {
          await this.rpc.request('thread/goal/set', { threadId: this.threadId, status: 'paused', origin: 'automatic' });
        }
        const setupId = recordBackendDiagnostics(this.session, { method: 'thread/resume', outcome: 'prepared', transport: 'codex-app-server',
          toolsSource: 'inherited-native-thread; not re-enumerated by BZZY', instructions: params.developerInstructions, threadId: this.threadId,
          model: params.model, policy, contextBudget: launchConfig.contextBudget,
          readiness: prepareNativeReadiness(this.session, { backend: 'codex', threadId: this.threadId, resumed: true,
            instructions: params.developerInstructions, contextBudget: launchConfig.contextBudget }) });
        let result, replacementRequired = false;
        try { result = await this.rpc.request('thread/resume', { threadId: this.threadId, ...params }); }
        catch (error) {
          if (!missingNativeThread(error, this.threadId) || this.interrupted || this.closing || this.operation || this.activeTurns.size
            || this.startedTurns !== startedTurnsBeforeOpen) throw error;
          recordBackendDiagnostics(this.session, { setupId, method: 'thread/resume', outcome: 'missing', threadId: this.threadId,
            reason: 'backend-confirmed-rollout-unavailable' });
          // No model turn/active-goal request has been sent in this open(). An
          // explicit metadata rejection permits one fresh thread, never replay
          // of an uncertain generation or tool side effect.
          rotateNativeThread(this.session); this.threadId = null; saveSession(this.session);
          replacementRequired = true;
          params.developerInstructions = this.prepareInstructions(this.inputSource || '');
          this.ui.event('info', { message: 'The saved backend thread is unavailable. Rebuilding it from this BZZY session’s saved context; the existing goal, scope and spent budget are preserved.' });
        }
        if (!replacementRequired) {
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The backend returned an invalid thread/resume response. No replacement thread was started.');
          resumed = true;
          recordBackendDiagnostics(this.session, { setupId, method: 'thread/resume', outcome: 'accepted', transport: 'codex-app-server',
            toolsSource: 'inherited-native-thread; not re-enumerated by BZZY', threadId: this.threadId, model: result.model || params.model,
            contextBudget: launchConfig.contextBudget, readiness: acknowledgeNativeReadiness(this.session, { threadId: this.threadId }) });
          startupStage = 'permission_activation'; this.assertAgentPermissions(result);
          if (!snapshot) {
            snapshot = await this.rpc.request('thread/goal/get', { threadId: this.threadId });
            if (snapshot.goal?.status === 'active') await this.rpc.request('thread/goal/set', { threadId: this.threadId, status: 'paused', origin: 'automatic' });
          }
          this.nativeGoalPresent = Boolean(snapshot.goal);
          if (!this.nativeGoalPresent && this.options.goalMode && this.session.goal) {
            // A missing goal resets only the goal's native counter. This thread
            // still retains its cumulative chat usage and history.
            preserveNativeGoalUsage(this.session);
            this.session.conversationHandoff = { pending: true, throughSeq: conversationCursor(this.session.id) };
            recordBackendDiagnostics(this.session, { method: 'native-goal-recovery', outcome: 'objective-required', threadId: this.threadId,
              reason: 'backend-confirmed-goal-absent' });
          }
          this.session.resolvedModel = result.model || this.session.model;
          this.nativeToolSchemaBytes = this.session.nativeBackendReadiness?.tools?.bytes || 0;
          this.nativeToolsKnown = Boolean(this.session.nativeBackendReadiness?.tools?.sha256);
          if (result.reasoningEffort) this.session.reasoningEffort = result.reasoningEffort;
          saveSession(this.session);
        }
      }
      if (!resumed) {
        // Native threads retain their initial tool schemas on resume. Reserve the
        // delegation tools even when the first turn is chat; ToolHost still denies
        // using them until an explicit goal execution authorizes them.
        if (this.options.toolHost) params.dynamicTools = nativeTools;
        this.nativeToolSchemaBytes = Buffer.byteLength(JSON.stringify(params.dynamicTools || [])); this.nativeToolsKnown = true;
        startupStage = 'thread_start';
        const setupId = recordBackendDiagnostics(this.session, { method: 'thread/start', outcome: 'prepared', transport: 'codex-app-server',
          toolsSource: 'submitted-dynamic-tools', tools: params.dynamicTools || [], instructions: params.developerInstructions, model: params.model, policy,
          contextBudget: launchConfig.contextBudget, readiness: prepareNativeReadiness(this.session, { backend: 'codex', tools: params.dynamicTools || [],
            instructions: params.developerInstructions, contextBudget: launchConfig.contextBudget }) });
        const result = await this.rpc.request('thread/start', params);
        recordBackendDiagnostics(this.session, { setupId, method: 'thread/start', outcome: 'accepted', transport: 'codex-app-server',
          toolsSource: 'submitted-dynamic-tools', threadId: result.thread.id, model: result.model || params.model,
          contextBudget: launchConfig.contextBudget, readiness: acknowledgeNativeReadiness(this.session, { threadId: result.thread.id }) });
        startupStage = 'permission_activation';
        this.assertAgentPermissions(result);
        this.threadId = result.thread.id;
        this.nativeGoalPresent = false;
        this.session.engineThreadId = this.threadId;
        this.session.resolvedModel = result.model || this.session.model;
        if (result.reasoningEffort) this.session.reasoningEffort = result.reasoningEffort;
        saveSession(this.session);
      }
      this.resumedThread = resumed;
    } catch (error) { throw markBackendStartupFailure(error, startupStage); }
  }

  assertAgentPermissions(result) {
    if (this.options.learningReview && (result.activePermissionProfile?.id !== learningPermissionProfile || result.activePermissionProfile.extends != null)) throw new Error('Codex did not activate the isolated learning permission profile. No review was started.');
    if (this.options.agentScope && (result.activePermissionProfile?.id !== agentPermissionProfile || result.activePermissionProfile.extends != null)) throw new Error('Codex did not activate the isolated Agent permission profile. No turn was started.');
  }

  async run(prompt, { goal = false, resumeGoal = false } = {}) {
    if (this.options.learningReview && (goal || resumeGoal || this.options.toolHost)) throw new Error('Learning reviews cannot execute goals or expose tools.');
    this.options.goalMode = goal;
    this.inputSource = goal ? this.session.goal.objective : prompt;
    this.progress.setPrompt(goal ? this.session.goal.objective : prompt);
    try {
      await this.open();
      if (this.interrupted) return;
      beginSessionCost(this.session, { threadId: this.threadId, resumed: this.resumedThread });
      this.spendingArmed = true;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      promise.catch(() => {});
      this.operation = { promise, resolve, reject, goal, pendingStart: true };
      if (goal) {
        if (!resumeGoal) {
          await this.rpc.request('thread/goal/clear', { threadId: this.threadId, origin: 'user' });
          this.nativeGoalPresent = false;
        }
        if (this.interrupted) return;
        const params = { threadId: this.threadId, status: 'active', origin: 'user' };
        let promptSetupId;
        let refreshEpoch;
        const budgetSession = this.session.goal.createdAt ? this.session : { ...this.session,
          goal: { ...this.session.goal, createdAt: '9999-12-31T23:59:59.999Z' } };
        const observedUsage = delegationUsage(budgetSession);
        if (this.session.goal.tokenBudget != null && observedUsage.unboundedUnknown) throw markBackendStartupFailure(Object.assign(new Error('This goal has unresolved model usage without a bounded allowance. Reconcile its accounting before resuming a finite token budget.'), { code: 'GOAL_TOKEN_BUDGET_UNCERTAIN' }), 'budget_admission');
        const budget = nativeGoalTokenBudget(this.session.goal, observedUsage.chargedDelegatedTokens);
        const conservativeSupervisorCharge = Math.max(0, observedUsage.chargedSupervisorTokens - (observedUsage.supervisorTokens || 0));
        if (this.session.goal.tokenBudget != null) {
          budget.remainingTokens = Math.min(budget.remainingTokens, Math.max(0, this.session.goal.tokenBudget - observedUsage.chargedTotalTokens));
          budget.nativeBudget = Math.max(0, budget.nativeBudget - conservativeSupervisorCharge);
        }
        const nativeBudget = budget.nativeBudget;
        recordBackendDiagnostics(this.session, { method: 'goal-budget-admission', outcome: budget.remainingTokens === 0 ? 'rejected' : 'admitted', budgetState: budget });
        if (budget.remainingTokens === 0) throw markBackendStartupFailure(Object.assign(new Error('This goal has exhausted its aggregate token budget, including specialist and delegate usage. Raise the authorized goal budget before resuming.'), { code: 'GOAL_TOKEN_BUDGET_EXHAUSTED' }), 'budget_admission');
        if (resumeGoal && this.session.goal.tokenBudget != null) params.tokenBudget = nativeBudget;
        if (!resumeGoal || this.session.conversationHandoff?.pending) {
          refreshEpoch = this.session.nativeContext?.refresh?.epoch;
          let objective = this.preparePrompt(this.session.goal.objective);
          promptSetupId = recordBackendDiagnostics(this.session, { method: 'thread/goal/set', outcome: 'prepared',
            delivery: objective.length > 500 && !this.options.agentScope ? 'objective-file-reference' : 'inline-objective', prompt: objective }, 'diagnostic.prompt');
          if (objective.length > 500 && !this.options.agentScope) {
            const objectivePath = path.join(home(), 'runtime', `${this.session.id}-objective.md`);
            privateDir(path.dirname(objectivePath));
            fs.writeFileSync(objectivePath, objective, { mode: 0o600 });
            objective = `Read the complete goal objective at ${objectivePath} before continuing. Satisfy every requirement in that file.`;
          }
          params.objective = objective;
          params.tokenBudget = nativeBudget;
        }
        const version = this.goalUpdates;
        this.goalArmed = true;
        const result = await this.rpc.request('thread/goal/set', params);
        if (params.objective) consumeNativeRefresh(this.session, refreshEpoch, 'accepted-native-goal-objective');
        recordBackendDiagnostics(this.session, { setupId: promptSetupId, method: 'thread/goal/set', outcome: 'accepted',
          delivery: params.objective ? 'prepared-objective' : 'resume-existing-native-objective', threadId: this.threadId }, 'diagnostic.prompt');
        if (this.goalUpdates === version) this.updateGoal(result.goal);
      } else {
        const effort = reasoningEffort(this.session, this.options);
        const refreshEpoch = this.session.nativeContext?.refresh?.epoch;
        const text = this.preparePrompt(prompt);
        const setupId = recordBackendDiagnostics(this.session, { method: 'turn/start', outcome: 'prepared', delivery: 'inline-message', prompt: text }, 'diagnostic.prompt');
        await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], ...(effort ? { effort } : {}) });
        consumeNativeRefresh(this.session, refreshEpoch, 'accepted-native-turn-input');
        recordBackendDiagnostics(this.session, { setupId, method: 'turn/start', outcome: 'accepted', delivery: 'inline-message', threadId: this.threadId }, 'diagnostic.prompt');
      }
      this.operation.pendingStart = false;
      this.settle();
      await promise;
      if (!this.interrupted) completeConversationHandoff(this.session);
    } catch (error) {
      if (!this.interrupted || !(error instanceof BackendClosedError)) throw error;
    } finally { this.operation = null; this.goalArmed = false; }
  }

  updateGoal(goal) {
    if (goal) this.nativeGoalPresent = true;
    // Native thread goals survive ordinary turns. Their notifications are not
    // evidence that the current BZZY execution is pursuing a goal.
    if (!this.operation?.goal || !this.goalArmed || !this.session.goal || !goal) return;
    this.goalUpdates++;
    const tokens = (this.session.goal.nativeTokenOffset || 0) + goal.tokensUsed;
    Object.assign(this.session.goal, { nativeStatus: goal.status, status: this.contextStallRequested ? 'paused' : goal.status === 'complete' ? 'verifying' : goal.status, nativeGoalId: goal.id || goal.goalId,
      nativeTokensUsed: tokens, tokensUsed: tokens + (this.session.goal.delegatedTokensUsed || 0), timeUsedSeconds: goal.timeUsedSeconds });
    if (this.contextStallRequested) this.session.goal.reason = 'context_no_progress';
    observeRunUsage(this.session, this.options.toolHost?.context?.runId, { nativeGoal: true });
    saveSession(this.session);
    this.ui.event('goal', { status: this.contextStallRequested ? 'paused' : goal.status, tokensUsed: tokens });
  }

  notification(method, params) {
    if (method === 'account/rateLimits/updated' && this.provider.auth === 'subscription') { const quota = codexQuota(params); if (quota) this.ui.event('account.quota', quota); }
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    const identity = { runId: this.options.toolHost?.context?.runId || null, threadRef: digest(this.threadId || params.threadId || ''),
      turnId: params.turnId || params.turn?.id || [...this.activeTurns][0] || null };
    if (method === 'thread/compacted' || (['item/started', 'item/completed'].includes(method) && params.item?.type === 'contextCompaction')) {
      const changed = recordNativeCompaction(this.session, { threadId: this.threadId || params.threadId, turnId: identity.turnId,
        itemId: params.item?.id || params.itemId, phase: method === 'item/started' ? 'started' : 'completed', legacy: method === 'thread/compacted' });
      if (changed && method === 'item/completed' && observeContextPressure(this.session, this.options.contextPressurePolicy)) {
        this.session.nativeContext.pressure.pausePending = true; saveSession(this.session);
      }
      if (method !== 'item/started') pendingNativeRefresh(this.session, this.hostRefreshCapability ? 'native-refresh-builder-unavailable' : 'native-host-refresh-not-advertised');
      if (method !== 'item/started') this.queueContextRefresh();
      if (changed && method !== 'item/started') this.observeLoopProgress({ kind: 'compaction' });
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item, phase = method === 'item/started' ? 'started' : 'completed';
      if (item?.id && ['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall'].includes(item.type)) {
        const toolIdentity = `${identity.turnId || 'unknown-turn'}:${item.id}`;
        if (phase === 'started') this.externalTools.add(toolIdentity);
        else {
          this.externalTools.delete(toolIdentity);
          this.observeLoopProgress({ kind: 'native-work', name: item.tool || item.type, input: { command: item.command },
            failed: item.status === 'failed' || Boolean(item.error) || Number.isInteger(item.exitCode) && item.exitCode !== 0 });
        }
      }
      if (phase === 'started') {
        if (item?.type === 'commandExecution') this.progress.tool(item.id, item.type, { command: item.command });
        else if (item?.type === 'fileChange') this.progress.tool(item.id, item.type, {});
        else if (item?.type === 'webSearch') this.progress.tool(item.id, item.type, { url: item.action?.url });
        else if (item?.type === 'mcpToolCall') this.progress.tool(item.id, item.tool, item.arguments);
      }
      if (item?.type === 'webSearch' && ['openPage', 'open_page'].includes(item.action?.type) && item.action.url) this.traffic.record(item.id, item.action.url, 'Codex web', phase);
      else if (item?.type === 'mcpToolCall') this.traffic.tool(item.id, item.tool, item.arguments, phase, Boolean(item.error));
      if (phase === 'completed' && ['commandExecution', 'fileChange'].includes(item?.type)) {
        try {
          recordWorkObservation(this.session, { ...identity, itemId: item.id,
            kind: item.type === 'commandExecution' ? 'command' : 'file_change', name: item.type,
            command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode,
            status: item.status, durationMs: item.durationMs,
            ...(item.status === 'failed' ? { failed: true } : {}), changes: item.changes });
        } catch { /* Derived learning observations cannot fail model execution. */ }
      }
    }
    if (['item/started', 'item/completed', 'item/commandExecution/outputDelta', 'turn/started', 'turn/completed', 'thread/compacted'].includes(method) && params.item?.type !== 'reasoning') this.ui.event('backend', { method, params });
    if (method === 'thread/tokenUsage/updated') {
      const spending = this.spendingArmed ? observeSessionCost(this.session, { threadId: this.threadId || params.threadId, tokenUsage: params.tokenUsage }) : null;
      this.session.usage = { ...(this.session.usage || {}), tokens: (this.session.engineTokenOffset || 0) + (params.tokenUsage?.total?.totalTokens || 0), available: true, source: 'backend-reported' };
      observeRunUsage(this.session, this.options.toolHost?.context?.runId);
      this.ui.event('usage.updated', { provider: this.session.provider, model: this.session.model, ...this.session.usage, detail: params.tokenUsage?.total || null,
        ...(this.session.provider === 'deepseek' ? this.spendingArmed ? { spendingTracked: true, spendingReceiptId: spending?.id || null } : { spendingBaseline: true } : {}) });
      saveSession(this.session);
      if (this.options.tokenBudget && !this.operation?.goal && this.session.usage.tokens >= this.options.tokenBudget) this.interrupt('token_limit').catch(() => {});
    }
    if (method === 'thread/goal/updated') { this.updateGoal(params.goal); this.settle(); }
    else if (method === 'turn/started') {
      if (this.operation) this.operation.seenTurn = true;
      this.activeTurns.add(params.turn.id);
      this.queueContextRefresh();
      this.startedTurns++;
      if (this.operation?.goal && this.options.maxTurns && this.startedTurns > this.options.maxTurns && !this.limiting) {
        this.limiting = true;
        this.interrupt('turn_limit').catch(error => this.operation?.reject(error));
      }
    } else if (method === 'turn/completed') {
      if (this.operation) this.operation.seenTurn = true;
      this.activeTurns.delete(params.turn.id);
      for (const [key, message] of this.streamedItems) if (message.identity.turnId === params.turn.id) {
        this.finalizeMessage(message.itemId, message.identity, 'turn-completed');
        this.streamedItems.delete(key); this.finalizedItems.delete(key);
      }
      for (const key of this.finalizedItems) if (key.startsWith(`${params.turn.id}:`)) this.finalizedItems.delete(key);
      this.session.turns++;
      if (this.session.goal && this.operation?.goal) this.session.goal.turns++;
      saveSession(this.session);
      this.pauseForContextPressure();
      this.ui.newline();
      if (params.turn.status === 'failed') {
        if (this.session.goal?.status === 'active') { this.session.goal.status = 'blocked'; saveSession(this.session); }
        this.operation?.reject(new Error(params.turn.error?.message || 'Codex turn failed.'));
      } else if (params.turn.status === 'interrupted') {
        if (this.session.goal?.status === 'active') { this.session.goal.status = 'paused'; saveSession(this.session); }
        this.interrupted = true;
        this.settle();
      } else this.settle();
    } else if (method === 'item/agentMessage/delta') {
      this.streamedItems.set(`${identity.turnId}:${params.itemId}`, { itemId: params.itemId, identity });
      this.ui.event('text', { text: params.delta, itemId: params.itemId, ...identity });
    } else if (method === 'item/started') {
      const item = params.item;
      if (item.type === 'commandExecution') this.ui.event('tool', { name: 'shell', detail: item.command });
      else if (item.type === 'fileChange') this.ui.event('tool', { name: 'edit', detail: item.changes?.map(c => c.path).join(', ') });
      else if (item.type === 'mcpToolCall') this.ui.event('tool', { name: `${item.server}/${item.tool}` });
      else if (item.type === 'webSearch') this.ui.event('tool', { name: 'web', detail: item.action?.url || item.query });
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage' && !this.streamedItems.has(`${identity.turnId}:${params.item.id}`)) {
      this.ui.event('text', { text: params.item.text + '\n', itemId: params.item.id, ...identity });
    } else if (method === 'error') {
      const message = params.error?.message || params.message || 'Codex backend error.';
      this.ui.event('error', { message: message + (params.willRetry ? ' Retrying…' : '') });
      if (!params.willRetry) this.operation?.reject(new Error(message));
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage') this.finalizeMessage(params.item.id, identity, 'item-completed');
  }

  finalizeMessage(itemId, identity, boundary) {
    const key = `${identity.turnId}:${itemId}`;
    if (!itemId || this.finalizedItems.has(key)) return;
    this.finalizedItems.add(key);
    this.ui.event('message.finalized', { ...identity, itemId, boundary });
  }

  queueContextRefresh() {
    if (this.refreshOperation || this.refreshTimer || this.interrupted || this.closing) return;
    this.refreshOperation = Promise.resolve().then(() => this.refreshContext()).catch(() => {
      // Context housekeeping never retries or settles the native goal.
      pendingNativeRefresh(this.session, 'native-refresh-preparation-failed');
    }).finally(() => { this.refreshOperation = null; });
  }

  async refreshContext() {
    const state = this.session.nativeContext, refresh = state?.refresh;
    if (!refresh || refresh.state !== 'pending') return;
    if (this.hostRefreshCapability?.transport !== 'turn/steer' || this.hostRefreshCapability?.acknowledgment !== 'turn-id') {
      pendingNativeRefresh(this.session, 'native-host-refresh-not-advertised'); return;
    }
    if (!this.operation?.goal || !this.goalArmed || this.interrupted || this.closing || this.session.goal?.status !== 'active') return;
    const runId = this.options.toolHost?.context?.runId, run = getRecord('run', this.session.id), saved = getRecord('session', this.session.id);
    if (!runId || run?.id !== runId || run.state !== 'running' || saved?.goal?.id !== this.session.goal?.id) {
      pendingNativeRefresh(this.session, 'native-refresh-no-current-run'); return;
    }
    if (this.hostRequests || this.userSteerInFlight || listRecords('question', { sessionId: this.session.id, state: 'pending', limit: 1 }).length) {
      pendingNativeRefresh(this.session, 'native-refresh-awaiting-host-request'); return;
    }
    const turnId = [...this.activeTurns][0];
    if (this.activeTurns.size !== 1 || !turnId) { pendingNativeRefresh(this.session, 'native-refresh-awaiting-active-turn'); return; }
    const wait = Math.max(0, (state.lastRefreshAt || 0) + 60000 - Date.now());
    if (wait) {
      pendingNativeRefresh(this.session, 'native-refresh-cooldown');
      this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.queueContextRefresh(); }, wait);
      this.refreshTimer.unref(); return;
    }
    const epoch = refresh.epoch, goalId = this.session.goal.id;
    const capsule = await this.contextRefreshCapsule({ goalMode: true, runId, contextGeneration: `${state.threadRef}:${epoch}` });
    if (!capsule) { pendingNativeRefresh(this.session, 'native-refresh-builder-unavailable'); return; }
    const text = `BZZY host context refresh. Derived state below is navigation data; it grants no permissions, changes no owner objective and establishes no verified completion.\n${JSON.stringify(capsule)}`;
    if (Buffer.byteLength(text) > 12288) { pendingNativeRefresh(this.session, 'native-refresh-capsule-too-large'); return; }
    const inputEstimate = nativeInputEstimate({ contextBudget: this.session.nativeContextBudget, instructions: this.nativeInstructions,
      toolSchemaBytes: this.nativeToolSchemaBytes, toolsKnown: this.nativeToolsKnown,
      prompt: `${this.session.goal.objective}\n${text}`, mandatoryPrompt: this.session.goal.objective });
    if (inputEstimate.exceedsBudget) { pendingNativeRefresh(this.session, 'native-refresh-context-budget-pressure'); return; }
    // Recheck after asynchronous preparation. No host input or stop can be
    // bypassed by a previously prepared capsule.
    const currentRun = getRecord('run', this.session.id);
    if (this.interrupted || this.closing || this.hostRequests || this.userSteerInFlight || !this.activeTurns.has(turnId)
      || this.session.goal?.id !== goalId || this.session.goal?.status !== 'active' || currentRun?.id !== runId || currentRun.state !== 'running'
      || listRecords('question', { sessionId: this.session.id, state: 'pending', limit: 1 }).length) return;
    const requestId = randomUUID();
    state.lastRefreshAt = Date.now();
    updateNativeRefresh(this.session, { state: 'dispatching', requestId, dispatchedEpoch: epoch, turnId,
      revision: capsule.revision || null, sourceSha256: digest(text), reason: 'awaiting-native-acknowledgment' });
    const setupId = recordBackendDiagnostics(this.session, { method: 'turn/steer', outcome: 'prepared', delivery: 'host-context-refresh', prompt: text }, 'diagnostic.prompt');
    try {
      const result = await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: turnId,
        input: [{ type: 'text', text, text_elements: [] }] }, 10000);
      if (result?.turnId !== turnId) {
        updateNativeRefresh(this.session, { state: 'uncertain', reason: 'native-refresh-acknowledgment-unverified' }); return;
      }
      updateNativeRefresh(this.session, { state: state.refresh.epoch === epoch ? 'acknowledged' : 'pending', acknowledgedEpoch: epoch,
        acknowledgedAt: new Date().toISOString(), reason: state.refresh.epoch === epoch ? 'native-accepted-input-not-attention' : 'newer-compaction-pending' });
      if (state.refresh.epoch === epoch) this.session.sessionMemoryRefresh = false;
      saveSession(this.session);
      recordBackendDiagnostics(this.session, { setupId, method: 'turn/steer', outcome: 'accepted', delivery: 'host-context-refresh', threadId: this.threadId }, 'diagnostic.prompt');
    } catch {
      // A timeout, closed pipe or error response is not proof the input was
      // absent from the native context. Resume never blindly repeats it.
      updateNativeRefresh(this.session, { state: 'uncertain', reason: 'native-refresh-dispatch-outcome-uncertain' });
    }
  }

  async contextRefreshCapsule(context) {
    const { compactTaskState } = await import('../recovery.js');
    return typeof compactTaskState === 'function' ? compactTaskState(this.session, {}, context) : null;
  }

  preparePrompt(source) {
    const estimate = prompt => nativeInputEstimate({ contextBudget: this.session.nativeContextBudget,
      instructions: this.nativeInstructions, toolSchemaBytes: this.nativeToolSchemaBytes, toolsKnown: this.nativeToolsKnown,
      prompt, mandatoryPrompt: source });
    let prompt = conversationPrompt(this.session, source), inputEstimate = estimate(prompt), compactedDerived = false;
    if (inputEstimate.exceedsBudget && !inputEstimate.mandatoryExceedsBudget) {
      prompt = conversationPrompt(this.session, source, { compactDerived: true }); inputEstimate = estimate(prompt); compactedDerived = true;
    }
    recordBackendDiagnostics(this.session, { method: 'context-admission', outcome: inputEstimate.exceedsBudget ? 'rejected' : 'admitted',
      inputEstimate: { ...inputEstimate, compactedDerived } });
    assertNativeInputFits(inputEstimate);
    return prompt;
  }

  prepareInstructions(source) {
    const estimate = instructions => nativeInputEstimate({ contextBudget: this.session.nativeContextBudget,
      instructions, toolSchemaBytes: this.nativeToolSchemaBytes, toolsKnown: this.nativeToolsKnown, prompt: source });
    let instructions = agentInstructions(this.session, this.options), inputEstimate = estimate(instructions);
    const originalInstructionBytes = Buffer.byteLength(instructions); let compactedDerivedInstructions = false;
    if (inputEstimate.exceedsBudget) {
      const compact = agentInstructions(this.session, { ...this.options, compactDerived: true });
      if (Buffer.byteLength(compact) < originalInstructionBytes) {
        instructions = compact; compactedDerivedInstructions = true; inputEstimate = estimate(instructions);
      }
    }
    recordBackendDiagnostics(this.session, { method: 'preprompt-admission', outcome: inputEstimate.exceedsBudget ? 'rejected' : 'admitted',
      inputEstimate: { ...inputEstimate, originalInstructionBytes, compactedDerivedInstructions } });
    assertNativeInputFits(inputEstimate);
    this.nativeInstructions = instructions;
    this.compactedDerivedInstructions = compactedDerivedInstructions;
    return instructions;
  }

  pauseForContextPressure() {
    if (!this.session.nativeContext?.pressure?.pausePending || !this.options.contextPressurePolicy || this.activeTurns.size || this.hostRequests
      || this.interrupted || this.closing || !this.operation?.goal || !this.goalArmed || this.session.goal?.status !== 'active') return;
    if (listRecords('question', { sessionId: this.session.id, state: 'pending', limit: 1 }).length) return;
    this.session.nativeContext.pressure.pausePending = false;
    this.session.nativeContext.pressure.pausedAt = new Date().toISOString(); saveSession(this.session);
    const operation = this.operation; operation.contextPausePending = true;
    this.interrupt('context_pressure').catch(error => operation.reject(error))
      .finally(() => { operation.contextPausePending = false; this.settle(); });
  }

  observeLoopProgress(input) {
    try { this.checkLoopProgress(input); }
    catch { try { recordBackendDiagnostics(this.session, { method: 'native-progress-guard', outcome: 'observation-unavailable' }); } catch { /* Preserve the actual tool result. */ } }
  }

  checkLoopProgress(input) {
    if (!this.operation?.goal || !this.goalArmed || this.options.learningReview || this.options.documentOnly) return;
    const runId = this.options.toolHost?.context?.runId, at = this.progressClock();
    const context = { runId, threadId: this.threadId, at };
    const observation = observeNativeGoalProgress(this.session, { ...context, ...input });
    if (!observation) return;
    const workers = database().prepare(`SELECT a.id,json_extract(a.data,'$.currentRound') AS round,
      json_extract(r.data,'$.state') AS state,json_extract(r.data,'$.reportArtifactId') AS report,
      json_extract(r.data,'$.runner') AS runner,json_extract(r.data,'$.launcher') AS launcher,
      json_extract(r.data,'$.createdAt') AS createdAt
      FROM records a LEFT JOIN records r ON r.kind='round' AND r.id=a.id || ':' || json_extract(a.data,'$.currentRound')
      WHERE a.kind='assignment' AND ${assignmentFilter(this.session, 'a.data')} AND COALESCE(json_extract(a.data,'$.importedUntrusted'),0)!=1
      ORDER BY r.updated_at DESC,a.id LIMIT 128`).all(...assignmentParameters(this.session));
    const fingerprint = digest(workers.map(({ id, round, state, report }) => ({ id, round, state, report })).sort((a, b) => a.id.localeCompare(b.id)));
    observeNativeGoalProgress(this.session, { ...context, kind: 'worker-state', fingerprint });
    const decision = observeNativeGoalProgress(this.session, { ...context, kind: 'check' });
    if (!decision?.shouldPause || this.hostRequests || this.externalTools.size || this.userSteerInFlight || this.session.nativeContext?.refresh?.state === 'dispatching'
      || this.interrupted || this.closing || listRecords('question', { sessionId: this.session.id, state: 'pending', limit: 1 }).length) return;
    // A saved "running" label alone is not evidence of a live worker. Verify
    // the exact current round's owned process, or its short admitted startup.
    if (workers.some(worker => {
      try {
        if (worker.state === 'running') return Boolean(worker.runner && identityAlive(JSON.parse(worker.runner)));
        if (worker.state === 'starting') return worker.launcher ? identityAlive(JSON.parse(worker.launcher))
          : Date.now() - Date.parse(worker.createdAt) < 30000;
      } catch { /* Missing/unverifiable identity cannot assert live work. */ }
      return false;
    })) return;
    if (!recordNativeCompactionStall(this.session, context)) return;
    this.contextStallRequested = true;
    this.session.goal.status = 'paused'; this.session.goal.reason = 'context_no_progress';
    try { saveSession(this.session); } catch { /* Stop even when persistence is unavailable. */ }
    try { this.ui.event('info', { message: 'Goal stalled: repeated coordination reads and context churn produced no new host-observed work. The saved goal, evidence and owner budget limit are preserved. An unacknowledged stop may require usage reconciliation. Review the pending state before explicitly resuming; no work was replayed.' }); } catch { /* Reporting cannot suppress the bounded stop. */ }
    if (typeof this.options.onContextStall === 'function') { this.options.onContextStall(); return; }
    const operation = this.operation; operation.contextPausePending = true;
    // Direct adapter callers receive the same bounded local shutdown as the
    // controller. An unresponsive pause RPC must not leave inference looping.
    const force = setTimeout(() => {
      if (this.activeTurns.size) this.contextStallForcedClose = true;
      void this.close().then(() => {
      this.activeTurns.clear(); operation.contextPausePending = false; operation.resolve();
      }, error => { operation.contextPausePending = false; operation.reject(error); });
    }, 3000); force.unref?.();
    void this.interrupt('context_no_progress').then(() => {
      if (!this.activeTurns.size) clearTimeout(force);
      operation.contextPausePending = false; this.settle();
    }, () => { /* The bounded close above owns ambiguous stop cleanup. */ });
  }

  settle() {
    if (!this.operation || this.operation.pendingStart || this.operation.contextPausePending || this.activeTurns.size) return;
    if ((!this.operation.goal && this.operation.seenTurn) || this.interrupted || (this.operation.goal && this.session.goal?.status !== 'active')) this.operation.resolve();
  }

  async request(method, params) {
    this.hostRequests = (this.hostRequests || 0) + 1;
    try { return await this.handleRequest(method, params); }
    finally { this.hostRequests--; this.pauseForContextPressure(); this.observeLoopProgress({ kind: 'check' }); this.queueContextRefresh(); }
  }

  async handleRequest(method, params) {
    if (this.options.documentOnly || this.options.learningReview) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return { decision: 'decline' };
      throw new Error('Documentation drafting has no tool access.');
    }
    if (method === 'item/tool/call' && this.options.toolHost) {
      try {
        const result = await this.options.toolHost.call(params.tool, params.arguments);
        this.observeLoopProgress({ kind: 'core-tool', name: params.tool, input: params.arguments || {}, result });
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      } catch (error) {
        this.observeLoopProgress({ kind: 'core-tool', name: params.tool, input: params.arguments || {}, failed: true });
        return { success: false, contentItems: [{ type: 'inputText', text: error.message }] };
      }
    }
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
      if (this.options.agentScope || this.options.strictPolicy) return { decision: 'decline' };
      const approved = this.options.yolo || await this.ui.approve(params.command || params.reason || 'Allow file changes?');
      return { decision: approved ? 'accept' : 'decline' };
    }
    if (method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const question of params.questions) {
        const choices = question.options?.map(o => o.label).join(' / ');
        const answer = await this.ui.ask(`${question.question}${choices ? ` (${choices})` : ''}: `);
        answers[question.id] = { answers: answer ? [answer] : [] };
      }
      return { answers };
    }
    throw new Error(`Unsupported backend request ${method}; no permission was granted.`);
  }

  async setGoalStatus(status) {
    await this.open();
    if (this.nativeGoalPresent === false && ['clear', 'paused'].includes(status)) return { goal: null, nativeGoalAbsent: true };
    const result = status === 'clear'
      ? await this.rpc.request('thread/goal/clear', { threadId: this.threadId, origin: 'user' })
      : await this.rpc.request('thread/goal/set', { threadId: this.threadId, status, origin: 'user' });
    if (status === 'clear') this.nativeGoalPresent = false;
    else this.updateGoal(result.goal);
    return result;
  }

  async interrupt(reason = 'interrupted') {
    this.interrupted = true;
    this.metadataAbort?.abort();
    clearTimeout(this.refreshTimer); this.refreshTimer = null;
    this.stopReason = reason;
    if (!this.rpc || !this.threadId) return;
    try {
      if (this.operation?.goal && this.goalArmed) {
        const result = await this.rpc.request('thread/goal/set', { threadId: this.threadId, status: 'paused', origin: 'user' });
        this.updateGoal(result.goal);
        this.session.goal.reason = reason;
        saveSession(this.session);
      }
      for (const turnId of this.activeTurns) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId });
      this.settle();
    } catch (error) {
      // A terminal notification can settle run() before this request's reply.
      // Its normal cleanup then closes the pipe; that is a successful stop.
      if (!(error instanceof BackendClosedError)) throw error;
    }
  }

  async close() {
    // Stop's kill grace and finally cleanup may both close the same native
    // transport. One close owns its TERM/KILL timers and process identity.
    clearTimeout(this.refreshTimer); this.refreshTimer = null;
    this.metadataAbort?.abort();
    this.closing ||= this.rpc?.close() || Promise.resolve();
    await this.closing; this.session.backendProcess = null;
  }

  async steer(text) {
    const turnId = [...this.activeTurns][0];
    if (!turnId) throw new Error('No active turn to steer.');
    this.userSteerInFlight = true;
    try { return await this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] }); }
    finally { this.userSteerInFlight = false; }
  }
}
