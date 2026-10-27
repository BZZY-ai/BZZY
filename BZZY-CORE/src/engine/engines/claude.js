import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { launch, root } from '../process.js';
import { home, privateDir, writeJson, saveSession } from '../store.js';
import { continuationPrompt, readReport, reportPath } from '../goals.js';
import { backendIsolation } from '../policy.js';
import { taskTools } from '../tools.js';
import { agentInstructions, reasoningEffort } from '../instructions.js';
import { stopProcess } from '../policy.js';
import { processIdentity } from '../recovery.js';
import { subscriptionEnvironment, subscriptionStatus } from '../auth.js';
import { BackendTraffic } from '../backend-traffic.js';
import { conversationPrompt, completeConversationHandoff } from '../conversation.js';
import { recordClaudeQuota } from '../account-status.js';
import { ActivityReporter } from '../live-activity.js';
import { assertLearningWorkingDirectory } from '../learning-backend.js';
import { recordBackendDiagnostics } from '../session-diagnostics.js';
import { nativeContextBudget, prepareNativeReadiness, acknowledgeNativeReadiness, recordNativeCompaction,
  pendingNativeRefresh, consumeNativeRefresh, nativeInputEstimate } from '../native-context.js';
import { digest } from '../database.js';
import { recordWorkObservation } from '../episode.js';

export function claudeEnvironment(backendHomes) {
  return subscriptionEnvironment('claude', { backendHomes });
}

export function claudeArgs(session, options, mcpConfig, uid = process.getuid?.()) {
  if (options.learningReview) assertLearningWorkingDirectory(session);
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
  if (session.engineThreadId) args.push('--resume', session.engineThreadId);
  else args.push('--session-id', session.engineSessionId || session.id);
  if (session.model) args.push('--model', session.model);
  if (options.documentOnly && !options.learningReview) args.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '');
  if (options.learningReview) {
    if (mcpConfig || options.toolHost) throw new Error('Learning reviews cannot expose MCP tools.');
    args.push('--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--disable-slash-commands', '--setting-sources', '', '--max-turns', '1', '--no-session-persistence', '--system-prompt-snapshot', 'off',
      '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }));
  }
  if (options.agentScope) args.push('--restricted', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }));
  if (session.subagentDefinition) args.push('--disallowedTools', 'Agent', 'Task');
  const effort = reasoningEffort(session, options);
  if (effort) args.push('--effort', effort);
  session.reasoningEffort = effort || 'provider default';
  // Claude Code refuses --dangerously-skip-permissions under root. bzzy still
  // handles its stdio permission requests below and, for bounded workers,
  // enforces the task policy with bubblewrap.
  if (!options.agentScope && (options.yolo || options.scopedAutonomy) && uid !== 0) args.push('--dangerously-skip-permissions');
  if (mcpConfig) args.push('--mcp-config', mcpConfig, '--allowedTools', ...taskTools(session, { goalMode: options.goalMode }).map(t => `mcp__bzzy_goal__${t.name}`));
  args.push('--append-system-prompt', agentInstructions(session, options));
  return args;
}

export class ClaudeEngine {
  constructor(provider, session, options, ui) { Object.assign(this, { provider, session, options, ui }); this.interrupted = false; this.traffic = new BackendTraffic(session, ui); this.progress = options.activityReporter || new ActivityReporter(session, ui); }

  async run(prompt, { goal = false } = {}) {
    if (this.options.learningReview && (goal || this.options.toolHost)) throw new Error('Learning reviews cannot execute goals or expose tools.');
    this.options.goalMode = goal;
    this.progress.setPrompt(goal ? this.session.goal.objective : prompt);
    const env = { ...claudeEnvironment(this.session.backendHomes), ...this.options.networkEnv };
    if (this.provider.auth === 'subscription' && !subscriptionStatus(this.provider, { backendHomes: this.session.backendHomes }).available) throw new Error('Claude subscription authentication is unavailable. Run bzzy auth claude to sign in through official Claude Code.');
    const nonce = this.options.toolHost?.nonce || randomUUID();
    let configFile;
    if (goal || this.options.toolHost) {
      configFile = path.join(home(), 'runtime', `${this.session.id}-mcp.json`);
      writeJson(configFile, { mcpServers: { bzzy_goal: { type: 'stdio', command: process.execPath,
        args: this.options.toolHost ? [path.join(root, 'bin', 'bzzy-engine.js'), 'internal-tools', this.options.toolHost.socket, this.options.toolHost.token] : [path.join(root, 'bin', 'bzzy-engine.js'), 'internal-mcp', this.session.id, nonce], env: { BZZY_HOME: home() } } } });
    }
    let activity = false, text = '', result, stderr = '', tokens = 0;
    const priorTokens = this.session.usage?.tokens || 0;
    const messageUsage = new Map();
    const args = claudeArgs(this.session, this.options, configFile);
    const promptIndex = args.indexOf('--append-system-prompt');
    const nativeInstructions = args[promptIndex + 1];
    const contextBudget = nativeContextBudget(this.provider, this.session);
    this.session.nativeContextBudget = contextBudget;
    const setupId = recordBackendDiagnostics(this.session, { method: 'claude-launch', outcome: 'prepared', transport: 'claude-stdio',
      toolsSource: configFile ? 'configured-mcp-allowlist' : 'no-core-mcp', tools: configFile ? taskTools(this.session, { goalMode: goal }) : [],
      instructions: args[promptIndex + 1], model: this.session.model, delivery: Buffer.byteLength(args[promptIndex + 1]) > 32768 ? 'system-prompt-file' : 'system-prompt-argument', contextBudget,
      readiness: prepareNativeReadiness(this.session, { backend: 'claude', threadId: this.session.engineThreadId,
        tools: configFile ? taskTools(this.session, { goalMode: goal }) : [], instructions: args[promptIndex + 1], contextBudget }) });
    let promptFile;
    const cleanup = () => { for (const file of [configFile, promptFile]) if (file) fs.rmSync(file, { force: true }); };
    try {
      if (Buffer.byteLength(args[promptIndex + 1], 'utf8') > 32 * 1024) {
        promptFile = path.join(home(), 'runtime', `${this.session.id}-${nonce}-instructions.txt`);
        privateDir(path.dirname(promptFile));
        fs.writeFileSync(promptFile, args[promptIndex + 1], { mode: 0o600, flag: 'wx' });
        args.splice(promptIndex, 2, '--append-system-prompt-file', promptFile);
      }
      this.child = launch('claude', args, {
        env, cwd: this.session.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        isolation: !this.options.agentScope && this.options.strictPolicy ? backendIsolation('claude', env, this.session.cwd, this.options.policy) : null,
      });
    } catch (error) { cleanup(); throw error; }
    const child = this.child;
    this.session.backendProcess = processIdentity(child.pid); saveSession(this.session);
    const send = value => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
    const lines = readline.createInterface({ input: child.stdout });
    let failure, exitTimer, forceTimer, resultClosedByHost = false;
    const terminate = error => {
      failure ||= error;
      stopProcess(child, 'SIGTERM');
      clearTimeout(forceTimer); forceTimer = setTimeout(() => stopProcess(child, 'SIGKILL'), 1000);
    };
    const refreshEpoch = this.session.nativeContext?.refresh?.epoch;
    const userMessage = { type: 'user', message: { role: 'user', content: conversationPrompt(this.session, goal ? continuationPrompt(this.session.goal) : prompt) }, parent_tool_use_id: null, session_id: this.session.engineThreadId || this.session.engineSessionId || this.session.id };
    recordBackendDiagnostics(this.session, { method: 'context-admission', outcome: 'native-window-unreported',
      inputEstimate: nativeInputEstimate({ contextBudget, instructions: nativeInstructions,
        toolSchemaBytes: this.session.nativeBackendReadiness?.tools?.bytes || 0, prompt: userMessage.message.content,
        mandatoryPrompt: goal ? continuationPrompt(this.session.goal) : prompt }) });
    const sealed = new Set(), streamedMessages = new Map();
    let currentMessageId = `${nonce}:message`, compactBoundary = 0, messageCounter = 0;
    const messageIdentity = itemId => ({ itemId, runId: this.options.toolHost?.context?.runId || null,
      threadRef: digest(this.session.engineThreadId || userMessage.session_id), turnId: nonce });
    const seal = (itemId, boundary) => {
      if (sealed.has(itemId)) return;
      sealed.add(itemId); this.ui.event('message.finalized', { ...(streamedMessages.get(itemId) || messageIdentity(itemId)), boundary });
      streamedMessages.delete(itemId);
      if (sealed.size > 64) sealed.delete(sealed.values().next().value);
    };
    const promptSetupId = recordBackendDiagnostics(this.session, { method: 'claude-message', outcome: 'prepared', delivery: 'stdio-message', prompt: userMessage.message.content }, 'diagnostic.prompt');
    const initializeId = `bzzy-init-${nonce}`;
    const initializeTimeout = setTimeout(() => {
      terminate(new Error('Claude control initialization timed out.'));
    }, 30000);
    child.stdin.on('error', error => terminate(error));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    const observedTools = new Map();
    lines.on('line', line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'control_response' && event.response?.request_id === initializeId) {
          clearTimeout(initializeTimeout);
          if (event.response.subtype === 'success') {
            send(userMessage);
            recordBackendDiagnostics(this.session, { setupId, method: 'claude-launch', outcome: 'control-initialized', transport: 'claude-stdio', contextBudget,
              readiness: acknowledgeNativeReadiness(this.session, { phase: 'control-initialized' }) });
            recordBackendDiagnostics(this.session, { setupId: promptSetupId, method: 'claude-message', outcome: 'written-to-stdio', delivery: 'stdio-message' }, 'diagnostic.prompt');
          }
          else terminate(new Error(event.response.error || 'Claude control initialization failed.'));
        } else if (event.type === 'rate_limit_event') {
          recordClaudeQuota(this.session, event, this.ui);
        } else if (event.type === 'control_request') {
          this.handleControl(event).then(response => send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response } }))
            .catch(error => { failure = error; send({ type: 'control_response', response: { subtype: 'error', request_id: event.request_id, error: error.message } }); });
        } else if (event.type === 'stream_event' && !event.parent_tool_use_id && event.event?.type === 'message_start') {
          currentMessageId = event.event.message?.id || `${nonce}:message:${++messageCounter}`;
        } else if (event.type === 'stream_event' && !event.parent_tool_use_id && event.event?.delta?.type === 'text_delta') {
          const delta = event.event.delta.text;
          text += delta;
          streamedMessages.set(currentMessageId, messageIdentity(currentMessageId));
          this.ui.event('text', { text: delta, ...messageIdentity(currentMessageId) });
        } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
          recordNativeCompaction(this.session, { threadId: event.session_id || this.session.engineThreadId || userMessage.session_id,
            turnId: nonce, itemId: event.uuid || `${nonce}:compact:${++compactBoundary}`, phase: 'completed', legacy: true });
          pendingNativeRefresh(this.session, 'claude-awaiting-next-safe-prompt');
        } else if (event.type === 'assistant') {
          if (event.session_id) this.session.engineThreadId = event.session_id;
          if (event.message?.model && event.message.model !== '<synthetic>') this.session.resolvedModel = event.message.model;
          for (const block of event.message?.content || []) {
            if (block.type === 'tool_use') {
              if (!block.name.startsWith('mcp__bzzy_goal__')) {
                if (observedTools.size >= 128) observedTools.delete(observedTools.keys().next().value);
                observedTools.set(block.id, { name: block.name, input: block.input, startedAt: Date.now() });
              }
              this.progress.tool(block.id, block.name, block.input);
              this.traffic.tool(block.id, block.name, block.input);
              this.ui.event('backend', { method: 'tool.started', params: { id: block.id, name: block.name, input: block.input } });
              if (!block.name.startsWith('mcp__bzzy_goal__')) activity = true;
              this.ui.event('tool', { name: block.name, detail: block.input?.command || block.input?.file_path || block.input?.url });
            } else if (block.type === 'text' && !streamedMessages.has(event.message?.id || currentMessageId)
              && !sealed.has(event.message?.id || currentMessageId) && !event.parent_tool_use_id) {
              text += block.text;
              this.ui.event('text', { text: block.text, ...messageIdentity(event.message?.id || currentMessageId) });
            }
          }
          if (!event.parent_tool_use_id) seal(event.message?.id || currentMessageId, 'assistant-message-completed');
          if (event.message?.id) {
            const usage = event.message.usage || {};
            const current = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.output_tokens || 0);
            const previous = messageUsage.get(event.message.id) || 0;
            tokens += Math.max(0, current - previous);
            messageUsage.set(event.message.id, Math.max(previous, current));
            this.session.usage = { ...(this.session.usage || {}), tokens: priorTokens + tokens, available: true, source: 'backend-reported' };
            saveSession(this.session);
            this.ui.event('usage.updated', { provider: this.session.provider, model: this.session.model, tokens: priorTokens + tokens, available: true, source: 'backend-reported',
              detail: usage });
            if (!goal && this.options.tokenBudget != null && priorTokens + tokens >= this.options.tokenBudget) this.interrupt('token_limit').catch(() => {});
          }
        } else if (event.type === 'user') {
          for (const block of event.message?.content || []) if (block.type === 'tool_result') {
            this.traffic.complete(block.tool_use_id, Boolean(block.is_error));
            const startedTool = observedTools.get(block.tool_use_id);
            observedTools.delete(block.tool_use_id);
            if (startedTool) try {
              // Pass the complete text to the privacy boundary before it is excerpted.
              const output = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
                ? block.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : '';
              const input = startedTool.input || {};
              recordWorkObservation(this.session, { runId: this.options.toolHost?.context?.runId,
                threadRef: digest(this.session.engineThreadId || userMessage.session_id), turnId: nonce, itemId: block.tool_use_id,
                name: startedTool.name, kind: input.command ? 'command' : /^(?:Edit|Write|MultiEdit)$/.test(startedTool.name) ? 'file_change' : 'tool',
                command: input.command || (input.file_path ? `${startedTool.name} ${input.file_path}` : ''), output,
                failed: Boolean(block.is_error), durationMs: Date.now() - startedTool.startedAt,
                changes: input.file_path && /^(?:Edit|Write|MultiEdit)$/.test(startedTool.name) ? [{ path: input.file_path }] : [] });
            } catch { /* Optional observations cannot change the tool's outcome. */ }
            this.ui.event('backend', { method: 'tool.completed', params: { id: block.tool_use_id, failed: Boolean(block.is_error) } });
          }
        } else if (event.type === 'system' && event.subtype === 'init') {
          const reportedTools = Array.isArray(event.tools) ? event.tools.filter(tool => typeof tool === 'string') : undefined;
          recordBackendDiagnostics(this.session, { setupId, method: 'claude-init', outcome: 'backend-reported', reportedTools, model: event.model, threadId: event.session_id,
            contextBudget, readiness: acknowledgeNativeReadiness(this.session, { threadId: event.session_id, reportedTools, phase: 'backend-init-reported' }) });
          consumeNativeRefresh(this.session, refreshEpoch, 'claude-backend-init-reported');
          this.session.engineThreadId = event.session_id;
          if (event.model) this.session.resolvedModel = event.model;
          saveSession(this.session);
          this.ui.event('model.resolved', { provider: this.provider.id, model: this.session.resolvedModel || this.session.model || 'provider default' });
        } else if (event.type === 'system' && event.subtype === 'api_retry') {
          this.ui.event('info', { message: `Claude is retrying the model request${event.attempt ? ` (attempt ${event.attempt})` : ''}. Use /pause to stop it.` });
        } else if (event.type === 'result') {
          result = event;
          if (event.session_id) this.session.engineThreadId = event.session_id;
          for (const itemId of streamedMessages.keys()) seal(itemId, 'result-completed');
          consumeNativeRefresh(this.session, refreshEpoch, 'claude-result-received');
          child.stdin.end();
          exitTimer = setTimeout(() => { resultClosedByHost = true; terminate(); }, 1500);
        }
      } catch (error) { terminate(new Error(`Invalid Claude message: ${error.message}`)); }
    });
    send({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize', hooks: {} } });
    let code;
    try { code = await done; }
    finally { clearTimeout(initializeTimeout); clearTimeout(exitTimer); clearTimeout(forceTimer); lines.close(); this.child = null; this.session.backendProcess = null; cleanup(); }
    this.ui.newline();
    this.session.turns++;
    const reportedTokens = tokens || (result?.usage?.input_tokens || 0) + (result?.usage?.cache_creation_input_tokens || 0) + (result?.usage?.cache_read_input_tokens || 0) + (result?.usage?.output_tokens || 0);
    this.session.usage = { tokens: priorTokens + reportedTokens, available: Boolean(result?.usage || tokens), source: 'backend-reported',
      estimatedConversationCostUsd: result?.total_cost_usd ?? null, modelUsage: result?.modelUsage || null };
    saveSession(this.session);
    if (!goal && this.options.tokenBudget != null && this.session.usage.tokens >= this.options.tokenBudget) await this.interrupt('token_limit');
    if (this.interrupted) { fs.rmSync(reportPath(this.session.id, nonce), { force: true }); return { interrupted: true, activity, tokens }; }
    if (failure) throw failure;
    if (code !== 0 && !resultClosedByHost || !result || result.is_error || (result.subtype && result.subtype !== 'success')) {
      fs.rmSync(reportPath(this.session.id, nonce), { force: true });
      throw new Error(result?.errors?.join('\n') || result?.result || stderr.trim() || `Claude exited (${code}) without a successful result.`);
    }
    if (!text && result.result) {
      this.ui.event('text', { text: result.result + '\n', ...messageIdentity(`${nonce}:result`) });
      seal(`${nonce}:result`, 'result-completed');
    }
    if (!tokens) tokens = (result.usage?.input_tokens || 0) + (result.usage?.cache_creation_input_tokens || 0) + (result.usage?.cache_read_input_tokens || 0) + (result.usage?.output_tokens || 0);
    completeConversationHandoff(this.session);
    return { activity, tokens, report: goal ? readReport(this.session.id, nonce) : null };
  }

  async handleControl(event) {
    if (this.options.documentOnly || this.options.learningReview) return { behavior: 'deny', message: 'Documentation drafting has no tool access.' };
    const request = event.request;
    if (request.subtype !== 'can_use_tool') throw new Error(`Unsupported Claude control request: ${request.subtype}`);
    if (this.options.agentScope) {
      const allowed = taskTools(this.session, { goalMode: this.options.goalMode }).some(tool => request.tool_name === `mcp__bzzy_goal__${tool.name}`);
      return allowed ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'This tool is outside persistent Agent permissions.' };
    }
    if (request.tool_name === 'AskUserQuestion') {
      if (!this.ui.interactive) return { behavior: 'deny', message: 'User input is required, but no interactive terminal is available.' };
      const answers = {};
      for (const question of request.input.questions || []) {
        const choices = question.options?.map(option => option.label).join(' / ');
        const answer = await this.ui.ask(`${question.question}${choices ? ` (${choices})` : ''}: `);
        if (!answer) return { behavior: 'deny', message: 'The user did not supply an answer.' };
        answers[question.question] = answer;
      }
      return { behavior: 'allow', updatedInput: { ...request.input, answers } };
    }
    const approved = this.options.yolo || this.options.scopedAutonomy || await this.ui.approve(`${request.tool_name}: ${JSON.stringify(request.input)}`);
    return approved ? { behavior: 'allow', updatedInput: request.input } : { behavior: 'deny', message: 'The user did not approve this action.' };
  }

  async interrupt(reason = 'interrupted') {
    this.interrupted = true;
    this.stopReason = reason;
    if (!this.child || this.child.exitCode != null) return;
    stopProcess(this.child, 'SIGINT');
    this.killTimer = setTimeout(() => stopProcess(this.child, 'SIGKILL'), 3000);
    this.killTimer.unref();
  }

  async close() { clearTimeout(this.killTimer); if (this.child) { this.child.stdin.end(); stopProcess(this.child, 'SIGKILL'); } }
}
