import fs from 'node:fs';
import path from 'node:path';
import { launch, root, version, assertCodexVersion, backendCommand } from '../process.js';
import { home, privateDir, writeJson, saveSession } from '../store.js';
import { apiKey, providerModelCapabilities } from '../providers.js';
import { Rpc } from '../rpc.js';
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

export { codexHome } from '../auth.js';

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
      session.engineThreadId = null;
      session.conversationHandoff = { pending: true, throughSeq: conversationCursor(session.id) };
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
    override(`projects.${JSON.stringify(session.cwd)}.trust_level`, 'untrusted');
  } else if (options.agentScope) {
    const executable = fs.realpathSync(backendCommand('codex'));
    override('default_permissions', agentPermissionProfile);
    override(`permissions.${agentPermissionProfile}`, { filesystem: { ':root': 'deny', ':minimal': 'read',
      [session.cwd]: 'read', [executable]: 'read', ':tmpdir': 'deny', ':slash_tmp': 'deny' }, network: { enabled: false } });
    for (const feature of ['shell_tool', 'multi_agent', 'multi_agent_v2', 'view_image', 'image_generation', 'apps', 'plugins', 'remote_plugin', 'hooks', 'skill_search', 'skill_mcp_dependency_install']) override(`features.${feature}`, false);
    override('features.skip_host_skill_discovery', true);
    override('shell_environment_policy.inherit', 'none'); override('shell_environment_policy.set', { PATH: '/usr/bin:/bin' });
    override('mcp_servers', {}); override('web_search', 'disabled');
    override(`projects.${JSON.stringify(session.cwd)}.trust_level`, 'untrusted');
  } else {
    override('sandbox_mode', codexSandboxMode(options));
    if (options.policy?.network === 'disabled') override('sandbox_workspace_write.network_access', false);
    else if (options.strictPolicy) override('sandbox_workspace_write.network_access', true);
  }
  const effort = reasoningEffort(session, options);
  if (effort) override('model_reasoning_effort', effort);
  session.reasoningEffort = effort || 'provider default';
  if (options.scopedAutonomy) {
    override('agents.max_threads', 1); override('agents.enabled', false);
    override('features.multi_agent', false); override('features.multi_agent_v2', false);
  }
  if (provider.auth === 'api-key') {
    env.BZZY_PROVIDER_API_KEY = apiKey(provider);
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'model-template.json'), 'utf8'));
    Object.assign(catalog, {
      slug: session.model, display_name: session.model, description: `${provider.name} via bzzy`,
      prefer_websockets: false, context_window: provider.contextWindow, max_context_window: provider.contextWindow,
      default_reasoning_level: provider.reasoningEffort || 'high', default_reasoning_summary: 'none',
      tool_mode: null, shell_type: 'shell_command', model_specialty: null,
      guardian: null, node_repl_auto_review_required: false, requires_sandboxed_review: false,
      auto_review_model_override: null, use_responses_lite: false,
      model_messages: { instructions_template: fs.readFileSync(path.join(root, 'assets', 'agent-instructions.md'), 'utf8') },
    });
    const capabilities = providerModelCapabilities(provider, session.model, session.modelCapabilities);
    if (capabilities?.defaultEffort) catalog.default_reasoning_level = capabilities.defaultEffort;
    const supported = capabilities?.supportedEfforts || provider.supportedEfforts;
    if (supported?.length) {
      catalog.supported_reasoning_levels = supported.map(effort => ({ effort, description: effort }));
      if (!supported.includes(catalog.default_reasoning_level)) catalog.default_reasoning_level = supported[0];
    }
    if (Number.isSafeInteger(capabilities?.contextWindow) && capabilities.contextWindow > 0) catalog.context_window = catalog.max_context_window = capabilities.contextWindow;
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
  return { args, env };
}

export class CodexEngine {
  constructor(provider, session, options, ui) {
    Object.assign(this, { provider, session, options, ui });
    this.activeTurns = new Set();
    this.streamedItems = new Set();
    this.operation = null;
    this.interrupted = false;
    this.startedTurns = 0;
    this.limiting = false;
    this.goalUpdates = 0;
    this.traffic = new BackendTraffic(session, ui);
    this.progress = options.activityReporter || new ActivityReporter(session, ui);
  }

  async open() {
    if (this.rpc && !this.rpc.closed) return;
    this.closing = null;
    if (this.options.toolHost && this.session.coreSkillsProtocol !== 4) {
      if (this.session.engineThreadId) {
        this.session.engineThreadId = null;
        this.session.conversationHandoff = { pending: true, throughSeq: conversationCursor(this.session.id) };
      }
      this.session.coreSkillsProtocol = 4;
    }
    const installed = version('codex');
    assertCodexVersion(installed);
    const launchConfig = codexLaunch(this.provider, this.session, this.options);
    if (this.provider.auth === 'subscription' && !subscriptionStatus(this.provider, { directory: launchConfig.env.CODEX_HOME }).available) throw new Error(`Codex / ChatGPT subscription authentication is unavailable in ${launchConfig.env.CODEX_HOME}. Run bzzy auth codex with the same BZZY_CODEX_HOME to sign in.`);
    this.rpc = new Rpc(launch('codex', launchConfig.args, { env: launchConfig.env, cwd: this.session.cwd, stdio: ['pipe', 'pipe', 'pipe'],
      canonicalExecutable: Boolean(this.options.agentScope || this.options.learningReview),
      isolation: !this.options.agentScope && this.options.strictPolicy ? backendIsolation('codex', launchConfig.env, this.session.cwd, this.options.policy) : null }), (method, params) => this.request(method, params));
    this.session.backendProcess = processIdentity(this.rpc.child.pid); saveSession(this.session);
    this.rpc.on('notification', (method, params) => this.notification(method, params));
    this.rpc.on('failure', error => this.operation?.reject(error));
    await this.rpc.request('initialize', { clientInfo: { name: 'bzzy', title: 'bzzy', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    this.rpc.notify('initialized');
    if (this.options.agentScope || this.options.learningReview) {
      const profileId = this.options.learningReview ? learningPermissionProfile : agentPermissionProfile;
      const profiles = await this.rpc.request('permissionProfile/list', {});
      if (!profiles.data?.some(profile => profile.id === profileId && profile.allowed === true)) throw new Error('This Codex backend cannot enforce the required isolated permission profile. No unrestricted fallback was started.');
    }
    const policy = this.options.learningReview ? { approvalPolicy: 'never', permissions: learningPermissionProfile }
      : this.options.agentScope ? { approvalPolicy: 'never', permissions: agentPermissionProfile }
      : { approvalPolicy: this.options.yolo || this.options.scopedAutonomy ? 'never' : 'on-request', sandbox: codexSandboxMode(this.options) };
    const params = { cwd: this.session.cwd, ...policy,
      developerInstructions: agentInstructions(this.session, this.options) };
    if (this.options.learningReview) { params.dynamicTools = []; params.ephemeral = true; }
    const effort = reasoningEffort(this.session, this.options);
    if (effort) params.config = { model_reasoning_effort: effort };
    if (this.session.model) params.model = this.session.model;
    if (this.provider.auth === 'api-key') params.modelProvider = 'bzzy_api';
    if (this.session.engineThreadId) {
      this.threadId = this.session.engineThreadId;
      const snapshot = await this.rpc.request('thread/goal/get', { threadId: this.threadId });
      if (snapshot.goal?.status === 'active') {
        await this.rpc.request('thread/goal/set', { threadId: this.threadId, status: 'paused', origin: 'automatic' });
      }
      const result = await this.rpc.request('thread/resume', { threadId: this.threadId, ...params });
      this.assertAgentPermissions(result);
      this.session.resolvedModel = result.model || this.session.model;
      if (result.reasoningEffort) this.session.reasoningEffort = result.reasoningEffort;
      saveSession(this.session);
    } else {
      // Native threads retain their initial tool schemas on resume. Reserve the
      // delegation tools even when the first turn is chat; ToolHost still denies
      // using them until an explicit goal execution authorizes them.
      if (this.options.toolHost) params.dynamicTools = taskTools(this.session, { goalMode: this.session.mode === 'delegate' ? true : this.options.goalMode }).filter(t => !['get_goal', 'update_goal'].includes(t.name)).map(t => ({ type: 'function', name: t.name, description: t.name === 'delegate' ? t.description + ' Available only during an explicit /goal; ordinary chat cannot launch assignments.' : t.description, inputSchema: t.inputSchema }));
      const result = await this.rpc.request('thread/start', params);
      this.assertAgentPermissions(result);
      this.threadId = result.thread.id;
      this.session.engineThreadId = this.threadId;
      this.session.resolvedModel = result.model || this.session.model;
      if (result.reasoningEffort) this.session.reasoningEffort = result.reasoningEffort;
      saveSession(this.session);
    }
  }

  assertAgentPermissions(result) {
    if (this.options.learningReview && (result.activePermissionProfile?.id !== learningPermissionProfile || result.activePermissionProfile.extends != null)) throw new Error('Codex did not activate the isolated learning permission profile. No review was started.');
    if (this.options.agentScope && (result.activePermissionProfile?.id !== agentPermissionProfile || result.activePermissionProfile.extends != null)) throw new Error('Codex did not activate the isolated Agent permission profile. No turn was started.');
  }

  async run(prompt, { goal = false, resumeGoal = false } = {}) {
    if (this.options.learningReview && (goal || resumeGoal || this.options.toolHost)) throw new Error('Learning reviews cannot execute goals or expose tools.');
    this.options.goalMode = goal;
    this.progress.setPrompt(goal ? this.session.goal.objective : prompt);
    await this.open();
    if (this.interrupted) return;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    this.operation = { promise, resolve, reject, goal, pendingStart: true };
    try {
      if (goal) {
        if (!resumeGoal) await this.rpc.request('thread/goal/clear', { threadId: this.threadId, origin: 'user' });
        if (this.interrupted) return;
        const params = { threadId: this.threadId, status: 'active', origin: 'user' };
        const nativeBudget = this.session.goal.tokenBudget == null ? undefined : Math.max(0, this.session.goal.tokenBudget - (this.session.goal.nativeTokenOffset || 0));
        if (resumeGoal && this.options.tokenBudget) params.tokenBudget = nativeBudget;
        if (!resumeGoal || this.session.conversationHandoff?.pending) {
          let objective = conversationPrompt(this.session, this.session.goal.objective);
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
        if (this.goalUpdates === version) this.updateGoal(result.goal);
      } else {
        const effort = reasoningEffort(this.session, this.options);
        await this.rpc.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: conversationPrompt(this.session, prompt), text_elements: [] }], ...(effort ? { effort } : {}) });
      }
      this.operation.pendingStart = false;
      this.settle();
      await promise;
      if (!this.interrupted) completeConversationHandoff(this.session);
    } finally { this.operation = null; this.goalArmed = false; }
  }

  updateGoal(goal) {
    // Native thread goals survive ordinary turns. Their notifications are not
    // evidence that the current BZZY execution is pursuing a goal.
    if (!this.operation?.goal || !this.goalArmed || !this.session.goal || !goal) return;
    this.goalUpdates++;
    const tokens = (this.session.goal.nativeTokenOffset || 0) + goal.tokensUsed;
    Object.assign(this.session.goal, { nativeStatus: goal.status, status: goal.status === 'complete' ? 'verifying' : goal.status, nativeGoalId: goal.id || goal.goalId,
      nativeTokensUsed: tokens, tokensUsed: tokens + (this.session.goal.delegatedTokensUsed || 0), timeUsedSeconds: goal.timeUsedSeconds });
    saveSession(this.session);
    this.ui.event('goal', { status: goal.status, tokensUsed: tokens });
  }

  notification(method, params) {
    if (method === 'account/rateLimits/updated' && this.provider.auth === 'subscription') { const quota = codexQuota(params); if (quota) this.ui.event('account.quota', quota); }
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item, phase = method === 'item/started' ? 'started' : 'completed';
      if (phase === 'started') {
        if (item?.type === 'commandExecution') this.progress.tool(item.id, item.type, { command: item.command });
        else if (item?.type === 'fileChange') this.progress.tool(item.id, item.type, {});
        else if (item?.type === 'webSearch') this.progress.tool(item.id, item.type, { url: item.action?.url });
        else if (item?.type === 'mcpToolCall') this.progress.tool(item.id, item.tool, item.arguments);
      }
      if (item?.type === 'webSearch' && ['openPage', 'open_page'].includes(item.action?.type) && item.action.url) this.traffic.record(item.id, item.action.url, 'Codex web', phase);
      else if (item?.type === 'mcpToolCall') this.traffic.tool(item.id, item.tool, item.arguments, phase, Boolean(item.error));
    }
    if (['item/started', 'item/completed', 'item/commandExecution/outputDelta', 'turn/started', 'turn/completed', 'thread/compacted'].includes(method) && params.item?.type !== 'reasoning') this.ui.event('backend', { method, params });
    if (method === 'thread/tokenUsage/updated') {
      this.session.usage = { ...(this.session.usage || {}), tokens: (this.session.engineTokenOffset || 0) + (params.tokenUsage?.total?.totalTokens || 0), available: true, source: 'backend-reported' };
      this.ui.event('usage.updated', { provider: this.session.provider, model: this.session.model, ...this.session.usage, detail: params.tokenUsage?.total || null });
      saveSession(this.session);
      if (this.options.tokenBudget && !this.operation?.goal && this.session.usage.tokens >= this.options.tokenBudget) this.interrupt('token_limit').catch(() => {});
    }
    if (method === 'thread/goal/updated') { this.updateGoal(params.goal); this.settle(); }
    else if (method === 'turn/started') {
      if (this.operation) this.operation.seenTurn = true;
      this.activeTurns.add(params.turn.id);
      this.startedTurns++;
      if (this.operation?.goal && this.options.maxTurns && this.startedTurns > this.options.maxTurns && !this.limiting) {
        this.limiting = true;
        this.interrupt('turn_limit').catch(error => this.operation?.reject(error));
      }
    } else if (method === 'turn/completed') {
      if (this.operation) this.operation.seenTurn = true;
      this.activeTurns.delete(params.turn.id);
      this.session.turns++;
      if (this.session.goal && this.operation?.goal) this.session.goal.turns++;
      saveSession(this.session);
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
      this.streamedItems.add(params.itemId);
      this.ui.event('text', { text: params.delta, itemId: params.itemId });
    } else if (method === 'item/started') {
      const item = params.item;
      if (item.type === 'commandExecution') this.ui.event('tool', { name: 'shell', detail: item.command });
      else if (item.type === 'fileChange') this.ui.event('tool', { name: 'edit', detail: item.changes?.map(c => c.path).join(', ') });
      else if (item.type === 'mcpToolCall') this.ui.event('tool', { name: `${item.server}/${item.tool}` });
      else if (item.type === 'webSearch') this.ui.event('tool', { name: 'web', detail: item.action?.url || item.query });
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage' && !this.streamedItems.has(params.item.id)) {
      this.ui.event('text', { text: params.item.text + '\n', itemId: params.item.id });
    } else if (method === 'error') {
      const message = params.error?.message || params.message || 'Codex backend error.';
      this.ui.event('error', { message: message + (params.willRetry ? ' Retrying…' : '') });
      if (!params.willRetry) this.operation?.reject(new Error(message));
    }
  }

  settle() {
    if (!this.operation || this.operation.pendingStart || this.activeTurns.size) return;
    if ((!this.operation.goal && this.operation.seenTurn) || this.interrupted || (this.operation.goal && this.session.goal?.status !== 'active')) this.operation.resolve();
  }

  async request(method, params) {
    if (this.options.documentOnly || this.options.learningReview) {
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return { decision: 'decline' };
      throw new Error('Documentation drafting has no tool access.');
    }
    if (method === 'item/tool/call' && this.options.toolHost) {
      try { return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(await this.options.toolHost.call(params.tool, params.arguments)) }] }; }
      catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error.message }] }; }
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
    const result = status === 'clear'
      ? await this.rpc.request('thread/goal/clear', { threadId: this.threadId, origin: 'user' })
      : await this.rpc.request('thread/goal/set', { threadId: this.threadId, status, origin: 'user' });
    if (status !== 'clear') this.updateGoal(result.goal);
    return result;
  }

  async interrupt(reason = 'interrupted') {
    this.interrupted = true;
    this.stopReason = reason;
    if (!this.rpc || !this.threadId) return;
    if (this.operation?.goal && this.goalArmed) {
      const result = await this.rpc.request('thread/goal/set', { threadId: this.threadId, status: 'paused', origin: 'user' });
      this.updateGoal(result.goal);
      this.session.goal.reason = reason;
      saveSession(this.session);
    }
    for (const turnId of this.activeTurns) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId });
    this.settle();
  }

  async close() {
    // Stop's kill grace and finally cleanup may both close the same native
    // transport. One close owns its TERM/KILL timers and process identity.
    this.closing ||= this.rpc?.close() || Promise.resolve();
    await this.closing; this.session.backendProcess = null;
  }

  async steer(text) {
    const turnId = [...this.activeTurns][0];
    if (!turnId) throw new Error('No active turn to steer.');
    return this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] });
  }
}
