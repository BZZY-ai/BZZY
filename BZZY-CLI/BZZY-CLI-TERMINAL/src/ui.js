import { updateCommand } from './update-checker.js';
import { skillsCommand } from './skills-ui.js';
import { createDefinitionCommand } from './definition-creator-ui.js';
import { subagentsCommand } from './subagents-ui.js';
import { openWorkflows, chooseWorkflow, workflowAction } from './workflow-ui.js';
import { openGoals, goalAction } from './saved-goals-ui.js';
import { removeLibraryEntry } from './library-entry-menu.js';
import { libraryCommand } from './library-ui.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { knowledgeCommand } from './knowledge-ui.js';
import readline from 'node:readline';
import { TerminalChat } from './tui.js';
import { validationPhaseLabel, validationSummary, validationResultStatus, validationResultBody } from './debate-ui.js';
import { clean, cellWidth, clip } from './terminal-format.js';
import { AccountStatusMonitor, accountStatusDetails, accountStatusLabels } from './account-status.js';
import { ClientSettings } from './client-settings.js';
import { Pet } from './mascot.js';
import { MESSAGE_FORMAT_LIMITS, parseMessageBody } from '@bzzy/core/message-format';
import { renderMessageContent } from './message-renderer.js';
import { createTerminalTheme, palettes } from './terminal-theme.js';
import { HostMetricsMonitor } from './host-metrics.js';
import { ConnectionStatusMonitor } from './connection-status.js';
import { shareSavedSession, deleteSavedSession } from './session-browser.js';
import { changeTerminalYolo, terminalYolo } from './permission-controls.js';
import { cancelDefinitionBundle } from './definition-bundle-ui.js';
import { sessionProjectLocation, sessionProjectDetails } from './session-project-path.js';
import { recordInvocationEvent, reconcileInvocationEntries } from './invocation-ui.js';
export { clean } from './terminal-format.js';

export class UI {
  constructor({ json = false, pet = true, minimal = false, cwd = process.cwd(), input = process.stdin, output = process.stdout, error = process.stderr, hostMetrics = false, metricsLoader, sessionMetricsLoader, sessionDebugExporter, sessionFullDebugExporter, updateHandoff, yolo, readOnly = false } = {}) {
    this.json = json;
    this.pet = pet;
    this.minimal = minimal;
    this.launchCwd = cwd;
    this.colorPalette = updateHandoff?.colorPalette || 'blue';
    this.input = input;
    this.output = output;
    this.error = error;
    this.interactive = Boolean(input.isTTY && output.isTTY && !json);
    this.hostMetricsEnabled = hostMetrics && this.interactive && !minimal;
    this.metricsLoader = metricsLoader;
    this.sessionMetricsLoader = sessionMetricsLoader;
    this.sessionDebugExporter = sessionDebugExporter;
    this.sessionFullDebugExporter = sessionFullDebugExporter;
    this.connectionStatusEnabled = hostMetrics && this.interactive;
    this.lineOpen = false;
    this.reader = null;
    this.promptQueue = Promise.resolve();
    this.cursors = new Map();
    this.messageStreams = new Map();
    this.launchYolo = yolo; this.readOnlyExecution = readOnly; this.sessionPermissionStates = new Map();
    this.updateHandoff = updateHandoff;
    if (updateHandoff) { this.sessionId = updateHandoff.sessionId; this.activeTab = updateHandoff.activeTab; }
  }

  openTerminal() {
    if (!this.interactive) return;
    this.tui ||= new TerminalChat(this);
    if (this.connectionStatusEnabled && !this.connectionMonitor && !this.closed) {
      this.connectionMonitor = new ConnectionStatusMonitor(sample => { this.connectionStatus = sample; this.tui?.schedule(); }).start();
    }
    if (this.updateHandoff) {
      this.tui.drafts = new Map(this.updateHandoff.drafts);
      Object.assign(this.tui, this.tui.drafts.get(this.activeTab || this.sessionId) || { value: '', cursor: 0 });
      this.updateHandoff = null;
    }
    if (this.hostMetricsEnabled && !this.hostMetricsMonitor && !this.closed) {
      this.hostMetricsMonitor = new HostMetricsMonitor(sample => { this.hostMetrics = sample; this.tui?.schedule(); },
        this.metricsLoader ? { load: this.metricsLoader } : {}).start();
    }
  }
  executionIndicator(enabled = true) { return new Pet(this, enabled); }
  yoloEnabled(id = this.sessionId) {
    if (this.launchYolo === true && !this.yoloLaunchInitialized?.has(id)) return true;
    return this.sessionPermissionStates.get(id) ?? false;
  }
  executionOptions(options, session) {
    this.launchYolo ??= Boolean(options.yolo);
    return { ...options, yolo: terminalYolo(session.id) ?? this.yoloEnabled(session.id) };
  }
  async toggleYolo() {
    const tui = this.tui, id = this.sessionId;
    if (!this.interactive || !id || !tui || tui.selection || tui.renderingPicker || tui.hidden || tui.promptDraft || this.privateView) return false;
    if (this.sessionMode === 'VIEW' && !this.permissionConnection?.acquire || this.readOnlyExecution || tui.executionPolicy?.mode === 'read-only') { tui.notice('YOLO is unavailable in read-only mode.', true); return false; }
    if (this.coreLifecycleInterrupted || this.permissionSubmitting) return false;
    this.permissionSubmitting = true; tui.schedule();
    try {
      const result = await changeTerminalYolo(this, !this.yoloEnabled(id));
      (this.yoloLaunchInitialized ||= new Set()).add(id);
      this.sessionPermissionStates.set(id, result.yolo);
      if (result.approvedQuestionId === tui.pendingApproval?.id) tui.pendingApproval = null;
      tui.notice(result.yolo ? result.approvedQuestionId ? 'YOLO on · pending action approved.' : 'YOLO on · native approvals bypassed for the next run.' : 'YOLO off · normal approvals for the next run.');
      return true;
    } catch (error) { tui.notice(error.message, true); return false; }
    finally { this.permissionSubmitting = false; tui.schedule(); }
  }
  canSubmitInput() {
    return this.sessionMode !== 'VIEW' || Boolean(this.permissionConnection?.acquire);
  }
  canAnswerApproval() {
    return Boolean(this.onAnswerApproval && this.canSubmitInput());
  }
  async answerApproval(answer) {
    const question = this.tui?.pendingApproval;
    if (!question || question.kind !== 'approval' || !['yes', 'no'].includes(answer) || !this.canAnswerApproval() || this.tui.approvalSubmitting) return;
    this.tui.approvalSubmitting = true; this.tui.schedule();
    try { await this.onAnswerApproval(question, answer); }
    catch (error) { this.tui.notice(error.message, true); }
    finally { this.tui.approvalSubmitting = false; this.tui.schedule(); }
  }

  setSession(id, mode = 'CONTROL') {
    if (this.sessionId !== id) {
      this.invocationEntries = [];
      this.tabs = null; this.activeTab = null; this.tui?.clear();
      this.skillPreview = null; this.skillHistoryState = null; this.skillPromotionDraft = null; this.skillSyncDetails = false;
      cancelDefinitionBundle(this);
      this.subagentPreview = null; this.subagentOffset = 0; this.subagentAdminContext = null;
      this.subagentView = 'library'; this.subagentRunId = null; this.subagentRunOffset = 0;
      this.knowledgeView = null; this.knowledgeState = null; this.knowledgeHits = null; this.knowledgeContextKey = null;
    }
    this.sessionId = id; this.sessionMode = mode;
    this.refreshSessionProjectLocation();
    if (this.interactive) { this.openTerminal(); this.renderFooter(); }
    else this.event('session', { sessionId: id, message: `Session: ${id} · ${mode}` });
  }
  setTabs(groupId, children, selectedId = groupId) {
    this.tui?.selectTab(this.activeTab || this.sessionId, selectedId);
    this.sessionId = groupId; this.tabs = [{ id: groupId, agent: 'Overview' }, ...children]; this.activeTab = selectedId;
    this.refreshSessionProjectLocation();
    this.renderFooter();
  }
  clearHistory() { this.tui?.clear(); this.invocationEntries = []; this.lineOpen = false; }
  beginHistoryRestore() { return this.tui?.beginHistoryRestore(); }
  executionConnection(connected) { this.tui?.executionFeedback.connection(connected); this.tui?.schedule(); }
  redrawPrompt() { if (this.tui) this.tui.schedule(); else if (this.reader && !this.lineOpen) this.reader.prompt(true); }
  updateSession(snapshot) {
    this.refreshSessionProjectLocation();
    if (snapshot.permissions) this.sessionPermissionStates.set(this.sessionId || snapshot.session?.id, snapshot.permissions.yolo === true);
    this.tui?.update(snapshot);
    if (!this.tui && !this.json) for (const entry of reconcileInvocationEntries(this.invocationEntries || [], snapshot,
      { sessionId: this.activeTab || this.sessionId })) this.writeInvocation(entry);
    if (this.accountStatusEnabled) {
      this.accountMonitor ||= new AccountStatusMonitor(status => { this.accountStatus = status; this.tui?.schedule(); });
      this.accountMonitor.update(snapshot.session || snapshot);
    }
  }
  refreshSessionProjectLocation() {
    this.sessionProjectLocation = sessionProjectLocation(this.activeTab || this.sessionId);
    return this.sessionProjectLocation;
  }
  showSessionProjectLocation() {
    this.event('info', { message: sessionProjectDetails(this.refreshSessionProjectLocation()) });
  }
  showAccountStatus() { this.event('info', { message: accountStatusDetails(this.accountStatus) }); }
  async showProviderBalance(providerId = this.tui?.provider) {
    if (providerId !== 'deepseek' || this.closed) return;
    await this.accountMonitor?.refresh();
    const status = accountStatusLabels(this.accountStatus).find(item => item.label === 'DeepSeek');
    const record = this.accountStatus?.deepseek;
    const message = [`DeepSeek balance: ${status?.value || '—'}`,
      record?.checkedAt ? `Checked ${new Date(record.checkedAt).toLocaleString()}` : '',
      status?.reason || '', 'Balance lookup uses the configured DeepSeek API key and makes no inference request.']
      .filter(Boolean).join('\n');
    this.event('info', { message });
  }
  openSettings() { this.openTerminal(); this.settings ||= new ClientSettings(this); this.tui?.setPanel('settings'); }
  async settingsCommand(input) {
    if (input.trim() === '/session-folder') { this.showSessionProjectLocation(); return true; }
    if (await createDefinitionCommand(input, this)) return true;
    if (/^\/color(?:\s|$)/.test(input.trim())) {
      const name = input.trim().slice(6).trim().toLowerCase();
      if (!Object.hasOwn(palettes, name)) this.event('error', { message: 'Choose /color blue, /color black or /color white.' });
      else {
        this.colorPalette = name;
        this.messageTheme = createTerminalTheme(this.output, process.env, name);
        this.tui?.setColorPalette(name);
      }
      return true;
    }
    if (input.trim() === '/yolo') { await this.toggleYolo(); return true; }
    if (input.trim() === '/metrics') { this.openTerminal(); this.tui?.setPanel('metrics'); return true; }
    if (input.trim() === '/debug' || input.trim() === '/full_debug_export') {
      this.openTerminal(); this.tui?.setPanel('metrics');
      await this.sessionMetrics?.activate(input.trim() === '/full_debug_export' ? 'full-export' : 'export'); return true;
    }
    if (/^\/session-action(?:\s|$)/.test(input)) {
      const match = /^\/session-action (share|delete) ([a-f0-9-]{36})$/.exec(input.trim());
      try {
        if (!match) throw new Error('Choose an action from a terminal’s menu.');
        if (match[1] === 'delete') await deleteSavedSession(this, match[2]);
        else await shareSavedSession(this, match[2]);
      } catch (error) { this.event('error', { message: error.message }); }
      return true;
    }
    if (input.trim() === '/update') { await updateCommand(this); return true; }
    if (/^\/library(?:\s|$)/.test(input.trim())) {
      try {
        const removal = /^\/library remove-entry ([a-f0-9-]{36})$/.exec(input.trim());
        if (removal) await removeLibraryEntry(this, removal[1]);
        else await libraryCommand(input.trim().slice(8).trim(), (this.sessionId && loadSession(this.sessionId)?.cwd) || this.tui?.cwd || process.cwd(), this);
      }
      catch (error) { this.event('error', { message: error.message }); }
      return true;
    }
    const goals = /^\/saved-goals(?:\s|$)/.exec(input.trim());
    if (goals) {
      const action = input.trim().slice(goals[0].length).trim();
      if (!action) openGoals(this);
      else if (this.tui?.panel === 'goals') await goalAction(action, this);
      return true;
    }
    const workflow = /^\/workflow(?:\s|$)/.exec(input.trim());
    if (workflow) {
      const action = input.trim().slice(workflow[0].length).trim();
      if (!action) {
        try { await chooseWorkflow(this); }
        catch (error) { this.event('error', { message: error.message }); }
      }
      else if (action === 'library') openWorkflows(this, { origin: 'chat' });
      else {
        // Keep displayed row/context pins intact until the action validates
        // them. Reopening first would replace those pins with the new session.
        if (this.tui?.panel !== 'workflows') {
          if (!['create', 'load', 'import', 'export'].includes(action)) {
            this.event('error', { message: 'Reopen /workflow before choosing an action.' }); return true;
          }
          if (!openWorkflows(this)) return true;
        }
        await workflowAction(action, this);
      }
      return true;
    }
    if (await knowledgeCommand(input, this)) return true;
    if (await skillsCommand(input, this)) return true;
    if (await subagentsCommand(input, this)) return true;
    if (!/^\/settings(?:\s|$)/.test(input)) return false;
    this.openSettings();
    const action = input.slice(9).trim();
    if (action) await this.settings.run(action);
    return true;
  }
  async chooseMany(title, choices, options = {}) {
    if (this.tui) return this.tui.chooseMany(title, choices, options);
    return choices.filter(choice => choice.selected).map(choice => choice.value);
  }
  async chooseOne(title, choices, options = {}) {
    if (this.tui) return this.tui.chooseOne(title, choices, options);
    return null;
  }

  renderFooter() {
    this.tui?.schedule();
  }

  event(type, data = {}) {
    this.beforeOutput?.();
    if (type === 'account.quota') this.accountMonitor?.accept(data);
    if (this.tui) { this.tui.event(type, data); return; }
    if (this.json) { this.output.write(`${JSON.stringify({ type, ...data })}\n`); return; }
    const invocation = recordInvocationEvent(this.invocationEntries ||= [], type, data, { sessionId: this.activeTab || this.sessionId });
    if (this.invocationEntries.length > 5000) this.invocationEntries.splice(0, 500);
    if (invocation.handled) {
      if (invocation.changed && invocation.entry) this.writeInvocation(invocation.entry);
      return;
    }
    if (type === 'text' || type === 'peer.text') { this.assistantText(type, data); return; }
    if (type === 'message.user') { this.newline(); this.output.write(`\nYou${data.kind === 'goal' ? ' /goal' : ''} › ${clean(data.text)}\n\n`); return; }
    if (type === 'question') { this.newline(); this.output.write(`\nAgent asks › ${clean(data.question)}\n`); return; }
    if (type === 'question.answered') { this.newline(); this.output.write(`You › ${clean(data.answer)}\n\n`); return; }
    if (type === 'activity') { this.activity = data.summary; this.renderFooter(); }
    // Invisible transport/usage events can interleave with a rich body. They
    // must not flush an incomplete root between its streamed chunks.
    if (['tool', 'goal', 'error', 'worker.progress', 'activity', 'network.response', 'summary', 'execution.finished'].includes(type)
      || type === 'backend' && /^(?:turn|item)\/completed$/.test(data.method || '') || data.message) this.newline();
    if (type === 'tool') this.output.write(`  · ${clean(data.name)}${data.detail ? `  ${clean(data.detail).slice(0, 240)}` : ''}\n`);
    else if (type === 'goal') this.output.write(`  goal ${data.status}${data.tokensUsed != null ? ` · ${data.tokensUsed} tokens` : ''}\n`);
    else if (type === 'error') this.error.write(`${clean(data.message)}\n`);
    else if (type === 'worker.progress') this.output.write(`  [${clean(data.agent || data.workerSessionId?.slice(0, 8) || 'worker')}] ${clean(data.name || data.message || data.status || data.type)}\n`);
    else if (type === 'activity') this.output.write(`  ◉ ${clean(data.message || data.summary)}\n`);
    else if (type === 'network.response') this.output.write(`  ↔ ${clean(data.method)} ${clean(data.url)} → ${data.status} · ${data.durationMs}ms\n`);
    else if (type === 'debate.message') {
      this.newline();
      const slot = Number.isSafeInteger(data.participantIndex) ? `Agent ${data.participantIndex + 1}` : clean(data.participant || 'Agent');
      this.output.write(`\n${slot} · ${validationPhaseLabel(data.phase || data.role)}\n${clean(validationSummary(data.summary || data.text))}\n`);
    }
    else if (type === 'debate.result') {
      this.output.write(`\nCONSENSUS · ${validationResultStatus(data).label}\n${clean(validationResultBody(data))}\n`);
    }
    else if (data.message) this.output.write(`${clean(data.message)}\n`);
    if (type === 'execution.finished') this.messageStreams.clear();
  }

  writeAssistantText(text, stream) {
    this.emitAssistantText(clean(text), stream);
  }

  writeInvocation(entry) {
    // Metadata must not flush an unfinished structured assistant body.
    if (this.lineOpen) this.output.write('\n');
    this.output.write('  · ' + entry.text + '\n'); this.lineOpen = false;
  }

  assistantPrefix(stream) {
    if (!stream.peer) return '';
    const width = Math.max(4, Math.min(1000, this.output.columns || 80));
    return `[${clip(stream.agent, Math.max(1, width - 4))}] `;
  }

  // Call only with sanitized ordinary text or locally rendered, validated SGR.
  emitAssistantText(text, stream) {
    if (!text) return;
    if (stream.peer) {
      if (this.lineOpen) this.output.write('\n');
      this.output.write(this.assistantPrefix(stream));
    }
    this.output.write(text); this.lineOpen = !clean(text).endsWith('\n');
  }

  assistantText(type, data) {
    const key = JSON.stringify([type, data.childSessionId || data.sessionId || this.activeTab || this.sessionId || '', data.agent || '', data.itemId || '', data.turnId || '']);
    let stream = this.messageStreams.get(key);
    if (!stream) {
      // Bound client bookkeeping while retaining recent interleaved peer replies.
      if (this.messageStreams.size >= 128) {
        const oldest = this.messageStreams.keys().next().value;
        this.flushAssistantText(this.messageStreams.get(oldest)); this.messageStreams.delete(oldest);
      }
      stream = { mode: 'probe', buffer: '', peer: type === 'peer.text', agent: data.agent || data.childSessionId || data.sessionId || 'Agent' };
      this.messageStreams.set(key, stream);
    }
    const text = String(data.text ?? '');
    if (stream.mode === 'truncated') return;
    if (stream.mode === 'plain') { this.writeAssistantText(text, stream); return; }
    stream.buffer += text;
    const candidate = stream.buffer.trimStart();
    if (Buffer.byteLength(stream.buffer) > MESSAGE_FORMAT_LIMITS.bytes) {
      this.writeAssistantText(parseMessageBody(stream.buffer).plainText, stream);
      stream.buffer = ''; stream.mode = 'truncated'; return;
    }
    if (candidate && !'<message'.startsWith(candidate) && !/^<message[\t\r\n />]/.test(candidate)) {
      this.writeAssistantText(stream.buffer, stream);
      stream.buffer = ''; stream.mode = 'plain'; return;
    }
    const complete = candidate.trimEnd();
    if (/<\/message[\t\r\n ]*>$/.test(complete) || /^<message[\t\r\n ][^<>]*\/>$/.test(complete)) this.flushAssistantText(stream);
  }

  flushAssistantText(stream) {
    const streams = stream ? [stream] : this.messageStreams.values();
    for (const current of streams) {
      if (!current.buffer) continue;
      const parsed = parseMessageBody(current.buffer);
      if (parsed.isFormatted) {
        this.messageTheme ||= createTerminalTheme(this.output, process.env, this.colorPalette);
        const width = (this.output.columns || 80) - cellWidth(this.assistantPrefix(current));
        const rendered = renderMessageContent(parsed, { width, theme: this.messageTheme });
        this.emitAssistantText(rendered.lines.join('\n'), current);
      } else this.writeAssistantText(parsed.plainText, current);
      current.buffer = ''; current.mode = 'plain';
    }
  }

  newline() {
    if (this.tui || this.json) return;
    this.flushAssistantText();
    this.messageStreams.clear();
    if (this.lineOpen) { this.output.write('\n'); this.lineOpen = false; }
  }

  ask(question, options = {}) {
    this.beforeOutput?.();
    if (!this.interactive) return Promise.resolve('');
    const operation = this.promptQueue.then(() => {
      if (this.closed) return null;
      if (this.tui) return this.tui.ask(question, options);
      return new Promise(resolve => {
      this.newline();
      this.reader = readline.createInterface({ input: this.input, output: this.output, escapeCodeTimeout: 50 });
      let answered = false;
      this.reader.once('close', () => { if (!answered) resolve(null); this.reader = null; });
      this.reader.once('SIGINT', () => { if (process.listenerCount('SIGINT')) process.emit('SIGINT'); this.reader?.close(); });
      this.reader.question(question, answer => {
        answered = true;
        this.reader.close();
        resolve(answer);
      });
      });
    });
    this.promptQueue = operation.catch(() => {});
    return operation;
  }

  async approve(label) {
    if (!this.interactive) {
      this.event('error', { message: `Approval required: ${label}. Run interactively to approve it, or explicitly select --yolo.` });
      return false;
    }
    if (this.tui) {
      const entry = this.tui.add('approval', clean(label), { questionId: 'local-approval', expanded: true });
      const selected = await this.chooseOne('Permission requested', { description: clean(label), choices: [
        { value: 'deny', label: '✕ Deny', selected: true, tone: 'danger' },
        { value: 'approve', label: '✔ Approve once', tone: 'goalSuccess' },
      ] }, { kind: 'approval', presentation: 'dropdown' });
      entry.decision = selected === 'approve' ? 'approved' : 'denied'; this.tui.entryLayouts.delete(entry); this.tui.contentRevision++; this.tui.schedule();
      return selected === 'approve';
    }
    return /^y(es)?$/i.test((await this.ask(`${clean(label)}\nAllow once? [y/N] `)) || '');
  }

  async secret(question) {
    if (!this.interactive || !this.input.setRawMode) throw new Error('Run authentication in a terminal, or set the provider API-key environment variable.');
    if (this.tui) return this.tui.ask(question, { hidden: true });
    this.output.write(question);
    const wasRaw = this.input.isRaw;
    this.input.setRawMode(true);
    this.input.resume();
    return new Promise((resolve, reject) => {
      let value = '';
      const done = error => {
        this.input.removeListener('data', onData);
        this.input.setRawMode(wasRaw);
        this.input.pause();
        this.output.write('\n');
        error ? reject(error) : resolve(value);
      };
      const onData = chunk => {
        for (const char of chunk.toString()) {
          if (char === '\u0003') { done(new Error('Authentication cancelled.')); return; }
          if (char === '\r' || char === '\n') { done(); return; }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else if (char >= ' ') value += char;
        }
      };
      this.input.on('data', onData);
    });
  }

  close({ preserveScreen = false } = {}) {
    this.connectionMonitor?.close();
    if (this.closed) return;
    cancelDefinitionBundle(this);
    this.hostMetricsMonitor?.close();
    void this.settings?.close();
    this.accountMonitor?.close();
    this.closed = true; this.reader?.close(); this.newline();
    if (this.tui) { this.tui.close({ preserveScreen }); if (this.sessionId && !preserveScreen) this.output.write(`Session: ${this.sessionId}\nAttach: bzzy --attach ${this.sessionId}\n`); }
  }
}
