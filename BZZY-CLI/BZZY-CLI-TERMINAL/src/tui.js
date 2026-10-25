import { skillRows, returnToSkillLibrary } from './skills-ui.js';
import { subagentRows } from './subagents-ui.js';
import { workflowRows, workflowAction, workflowChatLabel } from './workflow-ui.js';
import { namedTerminalSessions } from './session-browser.js';
import { clean, cellWidth, clip, wrap, wrapProse, duration } from './terminal-format.js';
import { mascotCells, mascotLine } from './mascot.js';
import { commandSuggestions, privateChatCommand } from './terminal-commands.js';
import { backendVisit } from './backend-traffic.js';
import { accountStatusLabels } from './account-status.js';
import { copyText, readClipboard } from './clipboard.js';
import { palette, createTerminalTheme } from './terminal-theme.js';
import { connectionStatusLabel } from './connection-status.js';
import { messageBodyToPlainText, parseMessageBody } from '@bzzy/core/message-format';
import { renderMessageContent } from './message-renderer.js';
import { hostMetricsCompact, hostMetricsLabel } from './host-metrics.js';
import { choicePopup, visibleChoices } from './choice-popup.js';
import { fillSurface, replaceCells, sliceCells } from './terminal-surface.js';
import { settingsLayout, settingsActions, navigateSettings } from './settings-layout.js';
import { goalIndicator, goalValidationIndicator } from './goal-indicator.js';
import { escapeInputKind, TerminalKeyInput } from './terminal-keys.js';
import { recordDebateEvent, debateEntryLayout } from './debate-ui.js';
import { goalValidationFor } from '@bzzy/core/engine/goal-validation.js';
import { SessionMetricsPanel, sessionMetricsLayout } from './session-metrics-ui.js';
import { returnFromDefinitionBundle, cancelDefinitionBundle } from './definition-bundle-ui.js';
import { recordInvocationEvent, reconcileInvocationEntries, invocationEntryLayout } from './invocation-ui.js';

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const animationInterval = 1000 / 60;
const mouseOn = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h', mouseOff = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
const targetKey = hit => hit?.type === 'settings' ? `settings:${hit.action}` : hit && [hit.type, hit.command || hit.action || hit.panel || hit.id || hit.index || '', hit.row, hit.left, hit.right].join(':');

export class TerminalChat {
  constructor(ui) {
    this.ui = ui; this.input = ui.input; this.output = ui.output;
    this.theme = createTerminalTheme(this.output, process.env, ui.colorPalette);
    this.entries = []; this.activities = []; this.traffic = []; this.sharedRoom = []; this.panel = 'chat'; this.scroll = 0;
    this.assignments = new Map();
    this.value = ''; this.cursor = 0; this.history = []; this.historyIndex = 0; this.drafts = new Map();
    this.entryLayouts = new WeakMap(); this.inputQueue = [];
    this.state = 'ready'; this.model = 'default'; this.provider = ''; this.frame = 0; this.lastFrame = [];
    this.animationTime = 0; this.animationStarted = performance.now();
    this.wasRaw = Boolean(this.input.isRaw);
    this.output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h' + mouseOn);
    this.input.setRawMode?.(true);
    this.normalizedKeys = new WeakSet();
    this.onKey = (text, key) => {
      // A closed setup readline can leave its decoder on stdin. Only our
      // normalized events may act; otherwise one byte can reach both decoders.
      if (!key || !this.normalizedKeys.has(key)) { if (key) key.bzzyHandled = true; return; }
      if (!key.bzzyHandled) this.key(text, key);
    };
    this.input.prependListener('keypress', this.onKey);
    const publish = (text, key) => { this.normalizedKeys.add(key); this.input.emit('keypress', text, key); };
    this.keyInput = new TerminalKeyInput(publish, (text, key) => { this.key(text, key); publish(text, key); });
    this.onRawData = chunk => this.keyInput.write(chunk);
    this.input.on('data', this.onRawData); this.input.resume();
    this.onResize = () => { this.textSelection = null; if (this.copyMode) this.setCopyMode(false); if (this.panel === 'metrics') this.metricsTopRequested = true; this.lastFrame = []; this.paintedFrame = null; this.render(); };
    this.output.on?.('resize', this.onResize);
    this.onDrain = () => { this.outputBlocked = false; this.lastFrame = []; this.schedule(); };
    this.output.on?.('drain', this.onDrain);
    this.onExit = () => this.restore(); process.once('exit', this.onExit);
    this.render();
    this.startAnimation();
  }

  setColorPalette(name) {
    this.theme = createTerminalTheme(this.output, process.env, name);
    this.entryLayouts = new WeakMap(); this.bodyCache = null;
    this.lastFrame = []; this.lastBackgrounds = []; this.paintedFrame = null;
    this.textSelection = null;
    this.render();
  }

  startAnimation() {
    let deadline = performance.now() + animationInterval;
    const tick = () => {
      if (this.closed) return;
      const instant = performance.now(), previous = this.frame;
      this.animationTime = (instant - this.animationStarted) / 1000; this.frame = Math.floor(this.animationTime * 10);
      if (!this.copyMode && !this.outputBlocked) {
        if (previous !== this.frame && (this.busy || this.selection?.loading || goalIndicator(this.goal, this.frame)?.animated || goalValidationIndicator(this.goal, this.goalValidation, this.frame)?.animated)) this.schedule();
        if (!this.renderTimer && this.ui.pet !== false) this.paintEyes();
      }
      const interval = this.ui.pet === false ? 100 : animationInterval;
      deadline += interval;
      if (deadline <= instant) deadline = instant + interval;
      this.timer = setTimeout(tick, Math.max(1, deadline - performance.now())); this.timer.unref();
    };
    this.timer = setTimeout(tick, animationInterval); this.timer.unref();
  }
  writeFrame(frame) { if (frame && !this.output.write(frame)) this.outputBlocked = true; }
  paintEyes() {
    const region = this.eyeRegion;
    if (!region || this.selection || this.copyMode || this.textSelection || this.outputBlocked || this.closed) return;
    const next = mascotCells(this.animationTime, { columns: region.columns, rows: region.rows, compact: region.compact ?? true });
    let output = '';
    for (let row = 0; row < next.length; row++) {
      const changed = column => next[row][column].text !== this.eyeCells[row][column].text || next[row][column].tone !== this.eyeCells[row][column].tone;
      for (let column = 0; column < region.columns;) {
        if (!changed(column)) { column++; continue; }
        const start = column++;
        while (column < region.columns && changed(column)) column++;
        output += `\x1b[${region.top + row};${region.left + start}H` + mascotLine(next[row].slice(start, column), this.theme);
      }
      if (!this.privateFrame) {
        const index = region.top + row - 1;
        this.lastFrame[index] = replaceCells(this.lastFrame[index] || '', region.left - 1, mascotLine(next[row], this.theme), (this.output.columns || 80) - 1, this.theme, palette.background);
        if (this.paintedFrame) this.paintedFrame[index] = this.lastFrame[index];
      }
    }
    this.eyeCells = next;
    if (output) this.writeFrame('\x1b7' + this.theme.background(palette.background) + output + '\x1b[0m\x1b8');
  }
  setCopyMode(active) {
    if (active === Boolean(this.copyMode) || active && (this.hidden || this.selection)) return;
    this.textSelection = null; this.copyMode = active;
    clearTimeout(this.renderTimer); this.renderTimer = null;
    if (active) { this.render({ force: true }); this.output.write(mouseOff); }
    else { this.output.write(mouseOn); this.lastFrame = []; this.schedule(); }
  }

  update(snapshot) {
    const session = snapshot.session || snapshot;
    this.provider = session.provider || this.provider;
    this.modelCapabilities = session.modelCapabilities;
    this.modelSelectionRequired = Boolean(session.modelSelectionRequired);
    this.model = this.modelSelectionRequired ? 'Select model' : session.resolvedModel || session.model || 'Provider default';
    this.effort = session.selectedEffort === 'default' ? 'effort default' : session.selectedEffort || session.reasoningEffort || '';
    this.cwd = session.projectRoot || session.cwd || this.cwd;
    this.alias = session.alias || '';
    this.retiredGoalIds ||= new Set();
    if (!session.goal?.id || !this.retiredGoalIds.has(session.goal.id)) {
      if (this.snapshotGoalId && session.goal?.id !== this.snapshotGoalId) this.retiredGoalIds.add(this.snapshotGoalId);
      this.snapshotGoalId = session.goal?.id || null; this.goal = session.goal;
      if (!session.goalValidation || session.goalValidation.state === 'none') this.goalValidation = null;
      else this.acceptGoalValidation(session.goalValidation, { snapshot: true });
    }
    this.executionPolicy = session.contract?.policy || session.policy;
    if (snapshot.questions) {
      this.pendingApproval = snapshot.questions.find(question => question.kind === 'approval' && (!question.state || question.state === 'pending'));
      if (this.pendingApproval && !this.entries.some(entry => entry.kind === 'approval' && entry.questionId === this.pendingApproval.id))
        this.add('approval', this.pendingApproval.question, { questionId: this.pendingApproval.id });
    }
    this.mode = session.mode; this.executor = session.executor;
    this.bestiesGroupId = session.bestiesSessionId || (session.mode === 'besties' ? session.id || this.ui.sessionId : null);
    this.peers = session.peers || [];
    if (!this.bestiesGroupId && !this.sharedRoom.length && this.panel === 'room') this.panel = 'chat';
    if (session.delegationUsage) this.delegationUsage = session.delegationUsage;
    const job = snapshot.execution;
    this.busy = job ? ['queued', 'launching', 'running'].includes(job.state) : ['running', 'waiting_for_input', 'verifying'].includes(session.executionState);
    const reported = session.usage?.available ? session.usage.tokens : undefined;
    this.tokens = this.busy ? reported == null ? this.tokens : Math.max(this.tokens ?? 0, reported) : session.summary?.usage?.totalTokens ?? reported;
    if (['besties', 'parallel'].includes(this.mode)) {
      if (!this.busy && session.summary?.usage) this.acceptGroupUsage(session.summary.usage);
      else if (this.groupUsage) this.acceptGroupUsage(this.groupUsage);
    } else this.groupUsage = null;
    this.startedAt = job?.startedAt || job?.createdAt || snapshot.run?.startedAt || this.startedAt;
    this.finishedAt = job?.finishedAt || snapshot.run?.finishedAt || null;
    this.state = session.executionState === 'waiting_for_input' ? 'needs your input' : this.busy
      ? job?.stopAction ? 'stopping' : job?.state === 'queued' ? 'queued' : job?.state === 'launching' ? 'starting' : this.streaming ? 'responding' : 'working'
      : session.failure && session.executionState === 'failed' ? 'failed' : 'ready';
    if (!this.busy) { this.streaming = false; this.currentTool = ''; }
    const invocations = reconcileInvocationEntries(this.entries, snapshot, { sessionId: this.ui.activeTab || this.ui.sessionId });
    if (invocations.length) this.contentRevision = (this.contentRevision || 0) + 1;
    for (const entry of invocations) this.entryLayouts.delete(entry);
    if (!this.pinned && session.goal?.objective) this.pinned = session.goal.objective;
    this.schedule();
  }

  add(kind, text, extra = {}) {
    this.contentRevision = (this.contentRevision || 0) + 1;
    const entry = { kind, text: kind === 'assistant' ? String(text ?? '') : clean(text), ...extra }; this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.splice(0, 500);
    return entry;
  }
  acceptGoalValidation(value, { snapshot = false } = {}) {
    if (!value || !this.goal?.id || value.sourceGoalId !== this.goal.id || value.sourceSessionId && value.sourceSessionId !== (this.ui.activeTab || this.ui.sessionId)
      || !Number.isSafeInteger(value.revision) || value.revision < 1) return;
    if (value.state === 'validated' && !snapshot) {
      // Replayed events can predate source/evidence changes without a newer
      // stored revision. Only Core's current projection can restore green.
      try { value = goalValidationFor({ id: value.sourceSessionId || this.ui.activeTab || this.ui.sessionId, goal: this.goal }); }
      catch { this.goalValidation = null; return; }
      if (value.state === 'none' || value.sourceGoalId !== this.goal.id) { this.goalValidation = null; return; }
    }
    this.goalValidationVersions ||= new Map();
    const previous = this.goalValidationVersions.get(value.sourceGoalId);
    if (previous && (previous.revision > value.revision || previous.revision === value.revision && previous.state !== 'validated' && value.state === 'validated')) return;
    if (previous && previous.revision === value.revision && previous.reviewSessionId !== value.reviewSessionId) return;
    this.goalValidation = { ...value }; this.goalValidationVersions.set(value.sourceGoalId, this.goalValidation);
  }
  event(type, data) {
    this.contentRevision = (this.contentRevision || 0) + 1;
    const invocation = recordInvocationEvent(this.entries, type, data, { sessionId: this.ui.activeTab || this.ui.sessionId });
    if (invocation.changed && invocation.entry) this.entryLayouts.delete(invocation.entry);
    if (this.entries.length > 5000) this.entries.splice(0, 500);
    if (type === 'text' || type === 'peer.text') {
      const peerSessionId = type === 'peer.text' ? data.childSessionId || data.sessionId || data.agent : null;
      const label = type === 'peer.text' ? data.agent || peerSessionId || 'Agent' : 'bzzy';
      // Peer chunks can interleave. Stable response IDs keep one complete entry
      // per reply so its copy button includes chunks received between peers.
      const previous = peerSessionId && data.itemId ? this.entries.findLast(entry => entry.kind === 'assistant' && entry.peerSessionId === peerSessionId && entry.itemId === data.itemId && entry.turnId === data.turnId)
        : this.entries.findLast(entry => entry.kind !== 'invocation');
      if (previous?.kind === 'assistant' && previous.label === label && previous.peerSessionId === peerSessionId && previous.itemId === data.itemId && previous.turnId === data.turnId) previous.text += String(data.text ?? '');
      else this.add('assistant', data.text, { label, peerSessionId, itemId: data.itemId, turnId: data.turnId });
      this.streaming = true;
    } else if (type === 'message.user') {
      if (data.kind === 'goal') { this.goal = { status: 'active', objective: clean(data.text) }; this.goalValidation = null; }
      this.pinned = (data.kind === 'goal' ? '/goal ' : '') + clean(data.text); this.add('user', data.text, { goal: data.kind === 'goal', channel: data.channel }); this.streaming = false; this.scroll = 0;
      if (this.mode === 'delegate') this.delegationPhase = 'Supervisor planning';
    } else if (['peer.message', 'peer.sent', 'peer.review'].includes(type)) {
      this.recordRoomEvent(type, data);
    } else if (type === 'question') {
      if (data.kind === 'approval') {
        this.pendingApproval = data;
        if (!this.entries.some(entry => entry.kind === 'approval' && entry.questionId === data.id)) this.add('approval', data.question, { questionId: data.id });
      }
      else this.add('question', data.question);
    }
    else if (type === 'question.answered') {
      const approval = this.entries.findLast(entry => entry.kind === 'approval' && entry.questionId === data.id);
      if (approval) { approval.decision = /^y(es)?$/i.test(data.answer) ? 'approved' : 'denied'; this.entryLayouts.delete(approval); }
      else this.add('user', data.answer);
      if (this.pendingApproval?.id === data.id) this.pendingApproval = null;
    }
    else if (type === 'question.expired') { if (this.pendingApproval?.id === data.id) this.pendingApproval = null; }
    else if (type === 'tool') {
      this.currentTool = `${data.name}${data.detail ? ' · ' + clean(data.detail).slice(0, 250) : ''}`;
      this.add('tool', this.currentTool); this.streaming = false;
    } else if (type === 'activity') {
      const worker = this.mode === 'delegate' && data.sessionId && data.sessionId !== (this.ui.activeTab || this.ui.sessionId);
      this.currentActivity = data.closedAt ? '' : (worker ? 'Hands · ' : '') + data.summary;
      if (worker && !data.closedAt && data.status === 'running') this.delegationPhase = 'Executor running';
      const index = this.activities.findIndex(item => item.id && item.id === data.id);
      if (index >= 0) this.activities[index] = data; else this.activities.push(data);
    } else if (type.startsWith('assignment.')) {
      const id = data.assignmentId || data.id, previous = this.assignments.get(id);
      if (data.subagentDefinition || previous?.specialist) this.subagentEvent(type, data);
      else if (this.mode === 'delegate') this.assignmentEvent(type, data);
    } else if (type === 'delegation.usage') {
      this.delegationUsage = data;
    } else if (type === 'besties.usage' || type === 'parallel.usage') {
      this.acceptGroupUsage(data);
    } else if (type.startsWith('network.') && data.url) {
      const index = data.id ? this.traffic.findIndex(item => item.id === data.id || data.backendCallId && item.backendCallId === data.backendCallId && item.url === data.url) : -1;
      if (index >= 0) this.traffic[index] = { ...this.traffic[index], ...data, type }; else this.traffic.push({ ...data, type });
    }
    else if (type === 'usage.updated') this.tokens = data.tokens;
    else if (type === 'model.resolved' && data.model) this.model = clean(data.model);
    else if (type === 'backend') {
      if (data.method === 'turn/started') this.streaming = false;
      const visit = backendVisit(data);
      if (visit) {
        const previous = this.traffic.find(item => item.backendCallId === visit.callId && item.url === visit.url);
        if (!previous) this.traffic.push({ id: 'history-' + (visit.callId || data.seq || visit.url), backendCallId: visit.callId, tool: visit.tool, url: visit.url, provenance: 'backend-reported', localRequestObserved: false, status: null, backendState: visit.completed ? 'completed' : 'reported' });
        else if (visit.completed) previous.backendState = 'completed';
      }
    }
    else if (type === 'summary') {
      if (this.goal && data.status && (!data.debateId || data.debateId === this.goal.id)) this.goal = { ...this.goal, status: data.status, reason: data.reason || null };
      this.add(data.status === 'complete' ? 'success' : 'notice', data.message); this.busy = false; if (['besties', 'parallel'].includes(this.mode) && data.usage) this.acceptGroupUsage(data.usage);
    }
    else if (type === 'error' || type === 'control.failed') { this.add('error', data.message); this.notice(data.message, true); }
    else if (type === 'worker.progress') {
      if (data.type === 'error') this.add('error', `${this.mode === 'delegate' ? 'Hands' : 'Agent'} · ${data.agent || data.workerSessionId?.slice(0, 8) || 'worker'}: ${data.message}`);
      if (data.type === 'tool' && this.mode === 'delegate') this.delegationPhase = 'Executor running';
    }
    else if (['debate.started', 'debate.phase', 'debate.message', 'debate.result'].includes(type)) {
      const { entry } = recordDebateEvent(this.entries, type, data);
      this.entryLayouts.delete(entry); this.streaming = false;
    }
    else if (type === 'goal.validation') this.acceptGoalValidation(data);
    else if (type === 'info' && data.message) { this.add('notice', data.message, { welcome: Boolean(data.welcome) }); if (!data.welcome) this.notice(data.message); }
    else if (type === 'execution.finished') { this.busy = false; this.streaming = false; }
    else if (type === 'goal' && data.status) this.goalStatus = data.status;
    if (this.activities.length > 1000) this.activities.shift();
    if (this.traffic.length > 1000) this.traffic.shift();
    this.schedule();
  }

  acceptGroupUsage(usage) {
    this.groupUsage = usage;
    const known = usage.complete === true || usage.agents?.some(agent => agent.available || Number.isFinite(agent.tokens) && agent.tokens > 0);
    this.tokens = known && Number.isFinite(usage.totalTokens) ? usage.totalTokens : undefined;
  }

  recordRoomEvent(type, data) {
    if (!data.id) return;
    const kind = type === 'peer.review' ? 'review' : 'message', index = this.sharedRoom.findIndex(item => item.kind === kind && item.id === data.id);
    const previous = index < 0 ? {} : this.sharedRoom[index];
    const seq = Math.min(previous.seq ?? Infinity, data.seq ?? Infinity);
    const item = { ...previous, ...data, kind, ...(Number.isFinite(seq) ? { seq } : {}),
      copyEntry: { text: clean(kind === 'review' ? `${data.assessment || 'Review'}: ${data.rationale || ''}` : data.text || '') } };
    if (index < 0) this.sharedRoom.push(item); else this.sharedRoom[index] = item;
    this.sharedRoom.sort((a, b) => String(a.createdAt || a.occurredAt || '').localeCompare(String(b.createdAt || b.occurredAt || '')) || (a.seq || 0) - (b.seq || 0));
    if (this.sharedRoom.length > 2000) this.sharedRoom.splice(0, this.sharedRoom.length - 2000);
    this.bestiesGroupId ||= data.groupId;
  }

  peerLabel(id) {
    const peer = this.peers.find(item => (item.sessionId || item.id) === id), tab = this.ui.tabs?.find(item => item.id === id);
    return agentLabel(peer?.namespace || peer?.agent || tab?.agent || id?.slice(0, 8) || 'Peer');
  }

  subagentEvent(type, data) {
    const id = data.assignmentId || data.id;
    if (!id) return;
    const previous = this.assignments.get(id) || {}, specialist = data.subagentDefinition?.name || previous.specialist;
    const objective = clean(data.contract?.objective || previous.objective || '').slice(0, 180);
    const state = type === 'assignment.finished' ? data.state : type === 'assignment.failed' ? 'failed'
      : type === 'assignment.reviewed' ? data.outcome : type === 'assignment.needs_context' ? 'needs_context'
      : ['assignment.created', 'assignment.started', 'assignment.followup'].includes(type) ? 'running' : previous.state;
    this.assignments.set(id, { ...previous, specialist, objective, state, round: data.round || data.currentRound || previous.round || 1 });
  }

  assignmentEvent(type, data) {
    const id = data.assignmentId || data.id;
    if (!id) return;
    const previous = this.assignments.get(id) || {};
    const label = clean(data.contract?.objective || previous.objective || `assignment ${id.slice(0, 8)}`).slice(0, 180);
    const selection = data.selection || previous.selection;
    const worker = selection ? `${selection.provider} · ${selection.model || 'provider default'}` : this.executor?.provider || 'executor';
    const round = data.round || data.currentRound || previous.round || 1;
    let message;
    if (['assignment.created', 'assignment.started', 'assignment.followup'].includes(type)) {
      this.assignments.set(id, { ...previous, objective: label, selection, round, state: 'running' });
      this.delegationPhase = 'Executor running';
      message = `Brain → hands · ${worker}${round > 1 ? ` · round ${round}` : ''}\n${label}`;
    } else if (type === 'assignment.finished') {
      this.assignments.set(id, { ...previous, state: 'awaiting_review', round });
      this.delegationPhase = 'Supervisor reviewing';
      const state = data.state === 'awaiting_review' ? 'Evidence is ready for review' : `Worker stopped: ${clean(data.state || 'unknown')}`;
      message = `Hands → brain · ${state}\n${label}. The supervisor will inspect the evidence before accepting it.`;
    } else if (type === 'assignment.reviewed') {
      this.assignments.set(id, { ...previous, state: data.outcome });
      this.delegationPhase = 'Supervisor planning';
      message = `Brain review · ${clean(data.outcome || 'recorded')}\n${label}`;
    } else if (type === 'assignment.failed') {
      this.assignments.set(id, { ...previous, state: 'failed' }); this.delegationPhase = 'Supervisor reviewing';
      message = `Hands → brain · assignment failed\n${label}. The parent goal remains unresolved.`;
    } else if (type === 'assignment.applied') message = `Accepted worker change applied · ${clean(data.path || label)}`;
    if (message) this.add('notice', message);
  }

  clear() { this.entries = []; this.activities = []; this.traffic = []; this.sharedRoom = []; this.assignments.clear(); this.delegationPhase = null; this.delegationUsage = null; this.groupUsage = null; this.debateFocus = null; this.textSelection = null; this.pinned = ''; this.scroll = 0; this.streaming = false; this.currentActivity = ''; this.currentTool = ''; this.tokens = undefined; this.startedAt = null; this.finishedAt = null; this.bodyCache = null; this.pendingApproval = null; this.goal = null; this.goalValidation = null; this.goalValidationVersions = new Map(); this.retiredGoalIds = new Set(); this.snapshotGoalId = null; this.schedule(); }
  selectTab(previous, next) {
    if (previous === next) return;
    this.textSelection = null;
    if (previous) this.drafts.set(previous, { value: this.value, cursor: this.cursor });
    const draft = this.drafts.get(next) || { value: '', cursor: 0 };
    Object.assign(this, draft); this.schedule();
  }
  ask(question, { hidden = false, initialValue = '' } = {}) {
    const queued = !hidden && /^bzzy\b/.test(question) ? this.inputQueue.findIndex(item => item.sessionId === (this.ui.activeTab || this.ui.sessionId)) : -1;
    if (queued >= 0) return Promise.resolve(this.inputQueue.splice(queued, 1)[0].text);
    return new Promise(resolve => {
      this.question = clean(question); this.hidden = hidden; this.resolveInput = resolve;
      if (hidden || !/^bzzy\b/.test(this.question)) { this.promptDraft = { value: this.value, cursor: this.cursor }; this.value = hidden ? '' : clean(initialValue); this.cursor = [...this.value].length; }
      this.ui.reader = { close: () => this.finish(null), setPrompt: text => { this.question = clean(text); }, prompt: () => this.schedule() };
      this.schedule();
    });
  }
  chooseMany(title, choices, options = {}) {
    this.textSelection = null;
    return new Promise(resolve => {
      this.selection = { title, choices, selected: new Set(choices.filter(choice => choice.selected).map(choice => choice.value)), focus: 0, resolve, ...options };
      this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule();
    });
  }
  chooseOne(title, choices, options = {}) {
    this.textSelection = null;
    return new Promise(resolve => {
      const picker = { title, loadingLabel: /updates/i.test(title) ? 'Checking GitHub…' : /model/i.test(title) ? 'Loading available models…' : 'Loading choices…', choices: [], focus: 0, resolve, single: true, loading: true, query: '', ...options };
      this.selection = picker; this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule();
      Promise.resolve(choices).then(result => {
        if (this.selection !== picker) return;
        picker.choices = Array.isArray(result) ? result : result.choices;
        picker.description = result.description || '';
        picker.descriptionRows = Math.min(16, result.descriptionRows || 2);
        picker.selectEffort = Boolean(result.selectEffort);
        picker.shortcuts = result.shortcuts;
        picker.hint = result.hint;
        picker.efforts = new Map(picker.choices.map(choice => [choice.value, choice.effort || 'default']));
        picker.warning = result.warning || '';
        picker.focus = Math.max(0, picker.choices.findIndex(choice => choice.selected)); picker.loading = false; this.schedule();
      }, () => {
        if (this.selection !== picker) return;
        picker.loading = false; picker.error = 'Unable to load choices. Press Esc to return.'; this.schedule();
      });
    });
  }
  finishSelection(value, force = false) { const selection = this.selection; if (!selection || selection.locked && selection.loading && !force) return; this.selection = null; this.hoverTarget = null; this.ui.reader = null; selection.resolve(value); this.schedule(); }
  openSessionMenu(id, x, y) {
    const parent = this.selection;
    if (this.hidden || this.promptDraft || this.ui.privateView || this.ui.coreLifecycleInterrupted || this.aliasEdit
      || parent && parent.scope !== 'sessions' || !parent && (this.ui.settings?.busy || this.resolveInput && !/^bzzy\b/.test(this.question || ''))) return false;
    const session = namedTerminalSessions().find(item => item.id === id);
    if (!session) return false;
    const reader = this.ui.reader, backgroundFrame = this.lastFrame.slice();
    this.textSelection = null;
    this.selection = { title: session.alias, presentation: 'context', scope: 'session-menu', anchor: { left: x, row: y },
      backgroundFrame, single: true, loading: false, focus: 0, query: '', choices: [
        { value: 'open', label: 'Open terminal', description: 'Open the saved chat in its original project.' },
        { value: 'share', label: 'Share full context', description: this.ui.sessionMode === 'VIEW' ? 'Attach with control to share.' : 'Full project and saved chats · QR / expiring code · recipient approval', disabled: this.ui.sessionMode === 'VIEW' },
        { value: 'delete', label: 'Delete chat', description: 'Remove this saved chat from BZZY. Project files are kept.', disabled: /VIEW/.test(this.ui.sessionMode || '') && !this.ui.permissionConnection?.acquire },
        { value: 'cancel', label: 'Cancel' },
      ], resolve: action => {
        this.selection = parent; this.ui.reader = reader;
        if (!['open', 'share', 'delete'].includes(action)) return;
        if (parent) this.finishSelection(action === 'open' ? id : { value: id, action });
        else this.localCommand(action === 'open' ? '/open-session ' + id : '/session-action ' + action + ' ' + id);
      } };
    this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule(); return true;
  }
  openResponseMenu(entry, x, y) {
    if (!entry || !['chat', 'room'].includes(this.panel) || this.selection || this.hidden || this.promptDraft || this.ui.privateView || this.aliasEdit) return false;
    const reader = this.ui.reader;
    this.textSelection = null;
    this.selection = { title: 'Agent response', presentation: 'context', scope: 'response-menu', anchor: { left: x, row: y },
      backgroundFrame: this.lastFrame.slice(), single: true, loading: false, focus: 0, query: '', choices: [
        { value: 'copy', label: 'Copy response', description: 'Copy the complete reply as readable text.' },
        { value: 'cancel', label: 'Cancel' },
      ], resolve: action => {
        this.ui.reader = reader;
        if (action === 'copy') this.clipboardTask = this.copySelection(clean(messageBodyToPlainText(entry.text)));
      } };
    this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule(); return true;
  }
  finish(answer) {
    const resolve = this.resolveInput; if (!resolve) return;
    this.resolveInput = null; this.ui.reader = null;
    if (answer != null && !this.hidden && !this.promptDraft && answer.trim() && !privateChatCommand(answer)) { this.history.push(answer); this.historyIndex = this.history.length; }
    if (this.promptDraft) { Object.assign(this, this.promptDraft); this.promptDraft = null; }
    else if (answer != null) { this.value = ''; this.cursor = 0; }
    this.hidden = false; resolve(answer); this.schedule();
  }
  canCompose() {
    if (this.selection || this.renderingPicker) return false;
    if (!this.promptDraft && (this.panel === 'settings' || this.panel === 'metrics' || this.panel === 'agents' || this.panel === 'workflows'
      || this.panel === 'skills' && this.ui.skillView !== 'import')) return false;
    return Boolean(this.resolveInput || this.ui.sessionId && !this.hidden && !this.promptDraft);
  }
  submitMessage() {
    if (this.resolveInput) { this.finish(this.value); return; }
    if (!this.value.trim()) return;
    this.inputQueue.push({ sessionId: this.ui.activeTab || this.ui.sessionId, text: this.value });
    if (!privateChatCommand(this.value)) this.history.push(this.value);
    this.historyIndex = this.history.length;
    this.value = ''; this.cursor = 0; this.schedule();
  }
  completions() {
    if (['settings', 'skills', 'agents', 'workflows', 'metrics'].includes(this.panel)) return [];
    if (!this.resolveInput || this.hidden || this.selection || this.renderingPicker || this.pasting || !/^bzzy\b/.test(this.question || '')) return [];
    if (this.completionQuery !== this.value) { this.completionQuery = this.value; this.completionFocus = 0; this.completionDismissed = false; }
    return this.completionDismissed ? [] : commandSuggestions(this.value);
  }
  completeCommand(choice) { this.value = choice.command + ' '; this.cursor = [...this.value].length; this.schedule(); }
  panels() { return this.mode === 'besties' || this.bestiesGroupId || this.sharedRoom.length ? ['chat', 'room', 'activity', 'http', 'sessions', 'skills', 'agents', 'workflows', 'metrics', 'settings'] : ['chat', 'activity', 'http', 'sessions', 'skills', 'agents', 'workflows', 'metrics', 'settings']; }
  setPanel(panel) {
    if (this.ui.coreLifecycleInterrupted && !['settings', 'metrics', 'chat'].includes(panel)) return;
    if (this.promptDraft || this.selection) return;
    if (panel === 'room' && !this.panels().includes('room')) { this.ui.event('info', { message: 'The shared room is available in a besties conversation. Start with bzzy --besties.' }); return; }
    if (panel === 'settings' && !this.ui.settings) { this.ui.openSettings(); return; }
    if (panel === 'sessions' && this.ui.onSessions?.() === false) return;
    if (panel !== this.panel) cancelDefinitionBundle(this.ui, this.panel);
    if (this.skillPanelDraft && panel !== 'skills') {
      if (this.panel === 'skills' && this.ui.skillView === 'import') this.ui.skillImportDraft = this.value;
      Object.assign(this, this.skillPanelDraft);
      this.skillPanelDraft = null;
    }
    if (panel === 'skills' && this.panel !== 'skills') {
      this.skillPanelDraft = { value: this.value, cursor: this.cursor };
      if (this.ui.skillView === 'import') {
        this.value = this.ui.skillImportDraft || this.ui.skillImportDirectory || '';
        this.cursor = [...this.value].length;
      }
    }
    if (this.settingsDraft && panel !== 'settings' && !this.promptDraft) { Object.assign(this, this.settingsDraft); this.settingsDraft = null; }
    if (panel === 'settings' && this.panel !== 'settings') { this.settingsDraft = { value: this.value, cursor: this.cursor }; this.value = ''; this.cursor = 0; }
    this.settingsEnsureFocus = panel === 'settings';
    if (panel === 'skills') this.skillTopRequested = true;
    if (panel === 'agents') this.agentTopRequested = true;
    if (panel === 'workflows') this.workflowTopRequested = true;
    if (panel === 'metrics') {
      this.ui.sessionMetrics ||= new SessionMetricsPanel(this.ui, { load: this.ui.sessionMetricsLoader });
      this.ui.sessionMetrics.open(this.ui.activeTab || this.ui.sessionId);
      this.metricsTopRequested = true;
    } else this.ui.sessionMetrics?.stop();
    this.textSelection = null; this.panel = panel; this.scroll = 0; this.schedule();
  }
  leaveSettings() {
    if (this.ui.settings) this.ui.settings.qrView = false;
    if (this.ui.settingsOnly) this.finish(null);
    else this.setPanel('chat');
  }
  localCommand(command) {
    if (this.selection || this.promptDraft || this.hidden || this.aliasEdit || this.ui.privateView || this.ui.coreLifecycleInterrupted || this.resolveInput && !/^bzzy\b/.test(this.question || '')) return;
    if (this.resolveInput) { const draft = { value: this.value, cursor: this.cursor }; this.finish(command); Object.assign(this, draft); }
    else this.inputQueue.push({ sessionId: this.ui.activeTab || this.ui.sessionId, text: command });
  }
  settingsAction(action) {
    if (!this.resolveInput || this.ui.settings?.busy || this.promptDraft || this.selection) return;
    this.ui.settings.focusAction(action);
    // Dispatch through the normal client loop, never a model conversation.
    this.finish(`/settings ${action}`);
  }
  notice(message, warning = false) {
    if (!message || this.closed) return;
    this.actionNotice = { message: clean(message).split('\n')[0], warning };
    clearTimeout(this.noticeTimer); this.noticeTimer = setTimeout(() => { this.actionNotice = null; this.schedule(); }, 4000); this.noticeTimer.unref(); this.schedule();
  }
  feedback(hit) {
    this.pressedTarget = targetKey(hit); this.pressedUntil = Date.now() + 180;
    clearTimeout(this.feedbackTimer); this.feedbackTimer = setTimeout(() => { this.pressedTarget = null; this.schedule(); }, 180); this.feedbackTimer.unref();
    this.schedule();
  }
  chooseFocused() {
    const picker = this.selection, choice = picker?.choices[picker.focus];
    if (!picker || picker.loading || !choice || !visibleChoices(picker).some(item => item.index === picker.focus)) return;
    if (choice.disabled) { picker.error = choice.description || 'This option is unavailable.'; this.schedule(); return; }
    if (picker.single) this.finishSelection(picker.selectEffort ? { value: choice.value, effort: picker.efforts.get(choice.value) } : choice.value);
    else if (picker.selected.size) this.finishSelection([...picker.selected]);
    else { picker.error = 'Select at least one option.'; this.schedule(); }
  }
  selectedText() {
    const selected = this.textSelection;
    if (!selected?.moved) return '';
    const [start, end] = screenRange(selected.anchor, selected.focus), lines = [];
    for (let row = start.y; row <= end.y; row++) {
      const left = row === start.y ? start.x - 1 : selected.region.left - 1;
      const right = row === end.y ? end.x : selected.region.right;
      lines.push(screenSegments(selected.lines[row - 1] || '', left, right).selected.replace(/ +$/, ''));
    }
    return lines.join('\n');
  }
  clipboardNotice(message) {
    if (this.closed) return;
    this.notice(message);
    clearTimeout(this.clipboardNoticeTimer); this.clipboardStatus = message; this.clipboardStatusUntil = Date.now() + 4500; this.schedule();
    this.clipboardNoticeTimer = setTimeout(() => { this.clipboardStatus = null; this.schedule(); }, 4500); this.clipboardNoticeTimer.unref();
  }
  renderTextSelection() {
    const selected = this.textSelection, lines = selected.frame.slice();
    if (selected.moved) {
      const [start, end] = screenRange(selected.anchor, selected.focus);
      for (let row = start.y; row <= end.y; row++) {
        const left = row === start.y ? start.x - 1 : selected.region.left - 1;
        const right = row === end.y ? end.x : selected.region.right;
        const parts = screenSegments(selected.lines[row - 1] || '', left, right);
        lines[row - 1] = this.theme.foreground(palette.text) + parts.before + (this.theme.level ? this.theme.background(palette.accent) + this.theme.foreground(palette.background) : '\x1b[7m') + parts.selected + '\x1b[27m' + this.theme.background(palette.background) + this.theme.foreground(palette.text) + parts.after + '\x1b[0m';
      }
    }
    let frame = '\x1b7\x1b[?25l';
    for (let row = 0; row < lines.length; row++) if (this.lastFrame[row] !== lines[row]) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}\x1b[2K${lines[row]}\x1b[0m`;
    this.lastFrame = lines; this.writeFrame(frame + '\x1b8');
  }
  async copySelection(text = this.selectedText()) {
    if (!text) return;
    this.lastCopiedText = text;
    try {
      const result = await (this.ui.clipboard?.copyText || copyText)(text, this.output);
      this.textSelection = null;
      this.clipboardNotice(result.copied ? result.method === 'osc52' ? 'Copy request sent · terminal clipboard support required' : 'Copied to clipboard' : result.reason || 'Unable to copy to the clipboard');
    } catch { this.textSelection = null; this.clipboardNotice('Unable to copy to the clipboard'); }
  }
  async pasteClipboard() {
    if (!this.canCompose() || this.selection || this.pastePending) return;
    const prompt = this.resolveInput; this.pastePending = true;
    try {
      const result = await (this.ui.clipboard?.readClipboard || readClipboard)();
      if (this.closed || this.resolveInput !== prompt) return;
      const cached = result.text == null && typeof this.lastCopiedText === 'string';
      const value = result.text ?? (cached ? this.lastCopiedText : null);
      if (value == null) { this.clipboardNotice(result.reason || 'Use your terminal’s Paste shortcut; clipboard reading is unavailable'); return; }
      if (Buffer.byteLength(value, 'utf8') > 512 * 1024) { this.clipboardNotice('Clipboard text exceeds the 512 KiB paste limit'); return; }
      const pasted = clean(value).replace(/\r\n?/g, '\n'), chars = [...this.value];
      this.textSelection = null; this.value = chars.slice(0, this.cursor).join('') + pasted + chars.slice(this.cursor).join(''); this.cursor += [...pasted].length;
      this.clipboardNotice(cached ? 'Pasted the last bzzy copy · system clipboard unavailable' : 'Pasted from clipboard');
    } catch { this.clipboardNotice('Use your terminal’s Paste shortcut; clipboard reading is unavailable'); }
    finally { this.pastePending = false; }
  }
  mouse(button, x, y, released = false) {
    if (this.copyMode) return;
    const originalFrame = this.textSelection?.frame;
    if (released) {
      this.scrollDrag = null;
      if (this.textSelection?.dragging) {
        const selected = this.textSelection;
        selected.focus = screenPoint(x, y, selected.region); selected.moved ||= selected.focus.x !== selected.anchor.x || selected.focus.y !== selected.anchor.y; selected.dragging = false;
        if (!selected.moved) this.textSelection = null;
        this.schedule();
      }
      return;
    }
    const wheel = button & 64, motion = button & 32;
    if (wheel) {
      this.textSelection = null;
      const delta = button & 1 ? 3 : -3;
      if (this.selection) {
        const choices = visibleChoices(this.selection), at = choices.findIndex(item => item.index === this.selection.focus);
        if (!this.selection.loading && choices.length) this.selection.focus = choices[Math.max(0, Math.min(choices.length - 1, at + delta))].index;
      } else if (this.panel === 'settings' && !this.promptDraft) {
        this.settingsOffset = Math.max(0, Math.min(this.settingsMaximum || 0, (this.settingsOffset || 0) + delta)); this.settingsEnsureFocus = false;
      } else this.scroll = Math.max(0, Math.min(this.scrollbar?.maximum || 0, this.scroll - delta));
      this.schedule(); return;
    }
    if (motion && this.scrollDrag != null && this.scrollbar) {
      const bar = this.scrollbar, fraction = Math.max(0, Math.min(1, (y - bar.top - this.scrollDrag) / Math.max(1, bar.height - bar.thumbHeight)));
      this.scroll = Math.round((1 - fraction) * bar.maximum); this.schedule(); return;
    }
    if (motion && this.textSelection?.dragging) {
      const selected = this.textSelection;
      selected.focus = screenPoint(x, y, selected.region); selected.moved ||= selected.focus.x !== selected.anchor.x || selected.focus.y !== selected.anchor.y; this.schedule(); return;
    }
    if (motion) {
      const hit = this.hitTargets?.findLast(target => y === target.row && x >= target.left && x <= target.right);
      const hover = targetKey(hit);
      if (hover !== this.hoverTarget) { this.hoverTarget = hover; this.schedule(); }
      return;
    }
    if ((button & 3) === 2) {
      const target = this.hitTargets?.findLast(hit => hit.row === y && x >= hit.left && x <= hit.right);
      if (target?.type === 'response') { if (this.openResponseMenu(target.entry, x, y)) this.feedback(target); return; }
      const id = target?.type === 'saved-session' ? target.id : target?.type === 'alias' ? this.ui.sessionId
        : target?.type === 'choice' && this.selection?.scope === 'sessions' ? this.selection.choices[target.index]?.value : null;
      if (id && this.openSessionMenu(id, x, y)) this.feedback(target);
      return;
    }
    if ((button & 3) !== 0) return;
    this.textSelection = null;
    const bar = this.scrollbar;
    if (bar?.maximum && x === bar.column && y >= bar.top && y < bar.top + bar.height) {
      this.scrollDrag = y >= bar.thumbTop && y < bar.thumbTop + bar.thumbHeight ? y - bar.thumbTop : Math.floor(bar.thumbHeight / 2);
      const fraction = Math.max(0, Math.min(1, (y - bar.top - this.scrollDrag) / Math.max(1, bar.height - bar.thumbHeight)));
      this.scroll = Math.round((1 - fraction) * bar.maximum); this.schedule(); return;
    }
    const hit = this.hitTargets?.findLast(target => y === target.row && x >= target.left && x <= target.right);
    if (this.selection && !hit) { if (['dropdown', 'context'].includes(this.selection.presentation) && !(this.popupRegion && x >= this.popupRegion.left && x <= this.popupRegion.right && y >= this.popupRegion.top && y <= this.popupRegion.bottom)) this.finishSelection(null); return; }
    if (hit) this.feedback(hit);
    if (hit?.type === 'top-sessions') {
      this.topSessionAnchor = { left: hit.left, row: hit.row };
      if (this.ui.onSessions?.() === false) this.topSessionAnchor = null;
      else if (!this.ui.onSessions) this.localCommand('/sessions');
      return;
    }
    if (hit?.type === 'session-new') { this.localCommand('/new'); return; }
    if (hit?.type === 'top-skills') { this.localCommand('/skills'); return; }
    if (hit?.type === 'top-agents') { this.localCommand('/agents'); return; }
    if (hit?.type === 'workflow-open') { this.localCommand('/workflows'); return; }
    if (hit?.type === 'top-metrics') { this.setPanel('metrics'); return; }
    if (hit?.type === 'metrics-action') { if (!hit.disabled) this.metricsAction(hit.action); return; }
    if (hit?.type === 'usage-balance') { this.balanceTask = this.ui.showProviderBalance?.(); return; }
    if (hit?.type === 'top-settings') { this.localCommand('/settings'); return; }
    if (hit?.type === 'settings-exit') { this.leaveSettings(); return; }
    if (hit?.type === 'back') { this.goBack(); return; }
    if (hit?.type === 'yolo') { this.permissionTask = this.ui.toggleYolo(); return; }
    if (hit?.type === 'approval') { this.approvalTask = this.ui.answerApproval(hit.answer); return; }
    if (hit?.type === 'approval-details') {
      const entry = this.entries.find(item => item.kind === 'approval' && item.questionId === hit.id);
      if (entry) { entry.expanded = !entry.expanded; this.entryLayouts.delete(entry); this.contentRevision++; this.schedule(); }
      return;
    }
    if (hit?.type === 'debate-toggle') { this.toggleDebate(hit.entry); return; }
    if (hit?.type === 'alias-save') { const value = this.aliasEdit?.value.trim(); this.aliasEdit = null; if (value) this.localCommand('/alias ' + value); this.schedule(); return; }
    if (hit?.type === 'alias-cancel') { this.aliasEdit = null; this.schedule(); return; }
    if (this.aliasEdit && hit?.type !== 'alias') { this.aliasEdit = null; this.schedule(); }
    if (hit?.type === 'panel') this.setPanel(hit.panel);
    else if (hit?.type === 'model-control') {
      if (hit.disabled) this.notice(this.ui.sessionMode === 'VIEW' ? 'This terminal is read-only.' : this.busy ? 'Pause the current response before changing its model.' : 'Select a model first.', true);
      else if (hit.command === '/settings core') { this.ui.openSettings(); this.settingsAction('core'); }
      else this.localCommand(hit.command);
    }
    else if (hit?.type === 'skill-action') this.localCommand('/skills ' + hit.action);
    else if (hit?.type === 'agent-action') this.localCommand('/agents ' + hit.action);
    else if (hit?.type === 'workflow-action') this.localCommand('/workflows ' + hit.action);
    else if (hit?.type === 'saved-session') this.localCommand('/open-session ' + hit.id);
    else if (hit?.type === 'alias') {
      const time = Date.now();
      if (time - (this.aliasClickedAt || 0) < 450 && !this.selection && !this.promptDraft && this.resolveInput && /^bzzy\b/.test(this.question || '') && this.ui.sessionMode !== 'VIEW') this.aliasEdit = { value: this.alias || '', cursor: [...(this.alias || '')].length };
      this.aliasClickedAt = time; this.schedule();
    }
    else if (hit?.type === 'settings') this.settingsAction(hit.action);
    else if (hit?.type === 'settings-back') { if (!this.ui.settings.busy) { if (!this.ui.settings.back()) { if (this.ui.settingsOnly) this.finish(null); else this.setPanel('chat'); } } }
    else if (hit?.type === 'qr-back') { this.ui.settings.qrView = false; this.lastFrame = []; this.schedule(); }
    else if (hit?.type === 'private-cancel') { if (this.resolveInput) this.finish(null); else this.ui.privateView?.onCancel?.(); }
    else if (hit?.type === 'tab') this.ui.onSelectTab?.(hit.id);
    else if (hit?.type === 'command') this.completeCommand(hit.choice);
    else if (hit?.type === 'choice' && this.selection && !this.selection.loading) {
      this.selection.focus = hit.index;
      if (['dropdown', 'context'].includes(this.selection.presentation)) this.chooseFocused();
      else if (!this.selection.single) {
        const value = this.selection.choices[hit.index].value;
        if (this.selection.selected.has(value)) this.selection.selected.delete(value); else this.selection.selected.add(value);
      }
      this.schedule();
    } else if (hit?.type === 'effort' && this.selection) { this.selection.focus = hit.index; this.key('', { name: hit.direction }); }
    else if (hit?.type === 'paste') { this.clipboardTask = this.pasteClipboard(); }
    else if (hit?.type === 'latest') { this.scroll = 0; this.schedule(); }
    else if (hit?.type === 'tools') { this.showTools = !this.showTools; this.schedule(); }
    else if (hit?.type === 'commands') { if (this.canCompose()) { this.value = '/'; this.cursor = 1; this.schedule(); } }
    else if (hit?.type === 'confirm') this.key('', { name: 'return' });
    else if (hit?.type === 'cancel') { if (hit.back) this.goBack(); else this.key('', { name: 'escape' }); }
    else if (this.resolveInput && !this.selection && y === this.composerRow) {
      const cells = Math.max(0, x - (this.composerTextLeft || 3) - (this.composerLeft || 0)) + (this.composerOffset || 0), chars = [...this.value];
      let used = 0, index = 0;
      for (; index < chars.length; index++) { const size = this.hidden ? 1 : chars[index] === '\n' ? 3 : cellWidth(chars[index]); if (used + size > cells) break; used += size; }
      this.cursor = index; this.schedule();
    } else if (!this.selection && this.textRegion && x >= this.textRegion.left && x <= this.textRegion.right && y >= this.textRegion.top && y <= this.textRegion.bottom) {
      const point = screenPoint(x, y, this.textRegion);
      const frame = originalFrame || this.lastFrame;
      this.textSelection = { anchor: point, focus: point, region: { ...this.textRegion }, lines: frame.map(clean), frame: frame.slice(), dragging: true, moved: false };
      this.schedule();
    }
  }
  toggleDebate(entry) {
    if (!entry || entry.kind !== 'debate') return;
    const cached = this.entryLayouts.get(entry);
    entry.expanded = !entry.expanded; this.debateFocus = entry.expanded ? entry : null;
    this.entryLayouts.delete(entry); this.contentRevision++; this.bodyCache = null;
    if (cached) this.scroll = Math.max(0, this.scroll + this.entryLayout(entry, cached.width).lines.length - cached.lines.length);
    this.schedule();
  }
  goBack() {
    if (this.selection) { this.finishSelection(null); return; }
    if (this.promptDraft) { this.finish(null); return; }
    if (this.ui.privateView) { if (this.resolveInput) this.finish(null); else this.ui.privateView.onCancel?.(); return; }
    if (this.aliasEdit) { this.aliasEdit = null; this.schedule(); return; }
    if (this.ui.cancelDefinitionAuthoring) { this.ui.cancelDefinitionAuthoring(); this.schedule(); return; }
    if (this.panel === 'settings') {
      if (this.ui.settings.busy) return;
      if (this.ui.settings.qrView) this.ui.settings.qrView = false;
      else if (!this.ui.settings.back()) this.leaveSettings();
      this.lastFrame = []; this.schedule(); return;
    }
    if (this.panel === 'skills' && returnToSkillLibrary(this.ui)) return;
    if (this.panel === 'workflows') { workflowAction('back', this.ui); return; }
    if (this.panel === 'agents' && returnFromDefinitionBundle(this.ui, 'agents')) return;
    if (this.panel === 'agents') {
      if (this.ui.subagentView === 'run') { this.ui.subagentView = 'runs'; this.ui.subagentRunId = null; }
      else if (this.ui.subagentCreatorDraft || this.ui.subagentPreview || this.ui.subagentView && this.ui.subagentView !== 'library') {
        this.ui.subagentCreatorDraft = null; this.ui.subagentPreview = null; this.ui.subagentView = 'library'; this.ui.subagentRunId = null;
      } else { this.setPanel('chat'); return; }
      this.bodyCache = null; this.scroll = 0; this.agentTopRequested = true; this.schedule(); return;
    }
    if (this.panel !== 'chat') this.setPanel('chat');
  }
  metricsAction(action) {
    if (!this.ui.sessionMetrics) return;
    this.metricsFocus = Math.max(0, this.ui.sessionMetrics.actions().findIndex(item => item.action === action));
    this.metricsTask = this.ui.sessionMetrics.activate(action);
    this.metricsTopRequested = true; this.bodyCache = null; this.schedule();
  }
  escapeMenu() {
    if (this.ui.cancelDefinitionAuthoring) { this.ui.cancelDefinitionAuthoring(); this.schedule(); return true; }
    if (this.ui.privateView && !this.resolveInput) { this.ui.privateView.onCancel?.(); return true; }
    if (this.aliasEdit) { this.aliasEdit = null; this.schedule(); return true; }
    if (this.copyMode) { this.setCopyMode(false); return true; }
    if (this.textSelection) { this.textSelection = null; this.lastFrame = []; this.schedule(); return true; }
    if (this.selection) { this.finishSelection(null); return true; }
    if (this.promptDraft) { this.finish(null); return true; }
    if (this.completions().length) { this.completionDismissed = true; this.schedule(); return true; }
    if (this.panel === 'chat' && this.debateFocus?.expanded) { this.toggleDebate(this.debateFocus); return true; }
    if (this.panel === 'settings') { this.leaveSettings(); return true; }
    if (this.panel === 'skills' && returnToSkillLibrary(this.ui)) return true;
    if (this.panel === 'workflows') { workflowAction('back', this.ui); return true; }
    if (this.panel === 'agents' && returnFromDefinitionBundle(this.ui, 'agents')) return true;
    if (this.panel === 'agents' && this.ui.subagentCreatorDraft) {
      this.ui.subagentCreatorDraft = null; this.ui.subagentPreview = null; this.ui.subagentView = 'library';
      this.bodyCache = null; this.scroll = 0; this.agentTopRequested = true; this.schedule(); return true;
    }
    if (this.panel !== 'chat') { this.setPanel('chat'); return true; }
    return false;
  }
  key(text, key) {
    const escape = escapeInputKind(text, key);
    if (escape) {
      key.bzzyHandled = true;
      if (escape === 'ignore') return;
      // A partial mouse packet must never swallow a later Escape key.
      this.mouseReport = null;
      key = { ...key, name: 'escape', meta: false, ctrl: false };
      if (this.escapeMenu()) return;
    }
    if (key.meta && ['y', 'n'].includes(key.name) && this.pendingApproval && !this.hidden && !this.promptDraft && !this.selection) {
      key.bzzyHandled = true; this.approvalTask = this.ui.answerApproval(key.name === 'y' ? 'yes' : 'no'); return;
    }
    // readline emits an SGR mouse report as a CSI prefix followed by ordinary characters.
    // Consume the entire report before any character can enter the message or secret input.
    if (key.sequence === '\x1b[<') { this.mouseReport = ''; key.bzzyHandled = true; return; }
    if (this.mouseReport != null) {
      key.bzzyHandled = true; this.mouseReport += text || key.sequence || '';
      if (/[Mm]$/.test(this.mouseReport)) {
        const report = /^(\d+);(\d+);(\d+)([Mm])$/.exec(this.mouseReport); this.mouseReport = null;
        if (report) this.mouse(Number(report[1]), Number(report[2]), Number(report[3]), report[4] === 'm');
      } else if (this.mouseReport.length > 64 || /[^\d;]/.test(this.mouseReport)) this.mouseReport = null;
      return;
    }
    if (this.ui.privateView && !this.resolveInput) {
      key.bzzyHandled = true;
      if (key.name === 'escape' || key.ctrl && key.name === 'c') this.ui.privateView.onCancel?.();
      return;
    }
    if (this.aliasEdit) {
      key.bzzyHandled = true;
      const edit = this.aliasEdit, chars = [...edit.value];
      if (key.name === 'escape' || key.ctrl && key.name === 'c') this.aliasEdit = null;
      else if (key.name === 'return') { this.aliasEdit = null; if (edit.value.trim()) this.localCommand('/alias ' + edit.value.trim()); }
      else if (key.name === 'left') edit.cursor = Math.max(0, edit.cursor - 1);
      else if (key.name === 'right') edit.cursor = Math.min(chars.length, edit.cursor + 1);
      else if (key.name === 'backspace' && edit.cursor) { chars.splice(--edit.cursor, 1); edit.value = chars.join(''); }
      else if (key.name === 'delete') { chars.splice(edit.cursor, 1); edit.value = chars.join(''); }
      else if (key.ctrl && key.name === 'a') edit.cursor = 0;
      else if (key.ctrl && key.name === 'e') edit.cursor = chars.length;
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) { chars.splice(edit.cursor, 0, ...text); edit.cursor += [...text].length; edit.value = chars.join('').slice(0, 80); }
      this.schedule(); return;
    }
    if (this.copyMode) { if (key.name === 'escape' || key.ctrl && key.name === 's') this.setCopyMode(false); return; }
    if (key.name === 'f10') {
      key.bzzyHandled = true;
      const response = !this.selection && this.hitTargets?.find(hit => hit.type === 'response' && targetKey(hit) === this.hoverTarget);
      if (response) { this.openResponseMenu(response.entry, response.left, response.row); return; }
      const target = this.selection?.scope === 'sessions' ? this.hitTargets?.find(hit => hit.type === 'choice' && hit.index === this.selection.focus)
        : this.hitTargets?.find(hit => hit.type === 'alias');
      const id = this.selection?.scope === 'sessions' ? this.selection.choices[this.selection.focus]?.value : this.ui.sessionId;
      if (id) this.openSessionMenu(id, target?.left || 3, target?.row || Math.max(1, this.sceneHeaderLength || 2));
      return;
    }
    if (this.panel === 'settings' && this.ui.settings?.qrView && !this.promptDraft) {
      key.bzzyHandled = true;
      if (key.name === 'escape') this.leaveSettings();
      else if (key.name === 'return') { this.ui.settings.qrView = false; this.lastFrame = []; this.schedule(); }
      else if (key.name === 'o') this.settingsAction('open-qr');
      else if (key.name === 'c' && !key.ctrl) this.settingsAction('copy-code');
      return;
    }
    if (key.ctrl && key.name === 'c' && this.selectedText()) { key.bzzyHandled = true; this.clipboardTask = this.copySelection(); return; }
    if (this.textSelection) { this.textSelection = null; this.lastFrame = []; if (key.name === 'escape') { key.bzzyHandled = true; this.schedule(); return; } }
    if (key.ctrl && key.name === 'v' && !this.selection && (this.panel !== 'settings' || this.promptDraft)) { key.bzzyHandled = true; this.clipboardTask = this.pasteClipboard(); return; }
    if (key.ctrl && key.name === 's' && !this.hidden && !this.selection) { this.setCopyMode(true); return; }
    if (this.selection) {
      key.bzzyHandled = true;
      const picker = this.selection;
      if (key.name === 'escape' || key.ctrl && key.name === 'c') this.finishSelection(null);
      else if (picker.loading || !picker.choices.length) return;
      else if (!key.ctrl && !key.meta && picker.shortcuts?.[key.name]) {
        const choice = picker.choices[picker.focus];
        if (!choice.disabled) this.finishSelection({ value: choice.value, action: picker.shortcuts[key.name] });
      }
      else if (['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
        const choices = visibleChoices(picker), at = choices.findIndex(item => item.index === picker.focus), step = key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'pageup' ? -6 : 6;
        if (choices.length) picker.focus = choices[key.name === 'home' ? 0 : key.name === 'end' ? choices.length - 1 : (Math.max(0, at) + step % choices.length + choices.length) % choices.length].index;
      }
      else if (picker.selectEffort && (key.name === 'left' || key.name === 'right')) {
        const choice = picker.choices[picker.focus];
        if (choice.efforts?.length) {
          const efforts = ['default', ...choice.efforts], index = Math.max(0, efforts.indexOf(picker.efforts.get(choice.value)));
          picker.efforts.set(choice.value, efforts[(index + (key.name === 'left' ? efforts.length - 1 : 1)) % efforts.length]);
        }
      }
      else if (key.name === 'space' && !picker.single) { const value = picker.choices[picker.focus].value; if (picker.selected.has(value)) picker.selected.delete(value); else picker.selected.add(value); }
      else if (key.name === 'return') this.chooseFocused();
      else if (picker.kind === 'model' && key.name === 'backspace') { picker.query = [...(picker.query || '')].slice(0, -1).join(''); picker.error = ''; }
      else if (picker.kind === 'model' && key.ctrl && key.name === 'u') { picker.query = ''; picker.error = ''; }
      else if (picker.kind === 'model' && text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) { picker.query = ((picker.query || '') + text).slice(0, 120); picker.error = ''; }
      this.schedule(); return;
    }
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; return; }
    if (key.ctrl && key.name === 'b' && this.panel === 'chat' && !this.promptDraft && !this.hidden && !this.pasting) {
      key.bzzyHandled = true; this.toggleDebate(this.entries.findLast(entry => entry.kind === 'debate')); return;
    }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      if (this.panel === 'settings' && !this.promptDraft) { this.settingsOffset = Math.max(0, Math.min(this.settingsMaximum || 0, (this.settingsOffset || 0) + (key.name === 'pageup' ? -8 : 8))); this.settingsEnsureFocus = false; }
      else this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? 8 : -8));
      this.schedule(); return;
    }
    if (key.ctrl && key.name === 'g') { const panels = this.panels(); this.setPanel(panels[(panels.indexOf(this.panel) + 1) % panels.length]); return; }
    if (key.ctrl && key.name === 'o') { this.showTools = !this.showTools; this.schedule(); return; }
    if (key.ctrl && key.name === 'l') { this.lastFrame = []; this.paintedFrame = null; this.schedule(); return; }
    if (key.ctrl && key.name === 'c') {
      if (!this.promptDraft && process.listenerCount('SIGINT')) process.emit('SIGINT'); else this.finish(null);
      return;
    }
    if (key.name === 'escape' && this.promptDraft) { this.finish(null); return; }
    if (this.panel === 'settings' && !this.promptDraft) {
      key.bzzyHandled = true;
      if (key.name === 'escape') { this.leaveSettings(); return; }
      if (key.name === 'home' || key.name === 'end') { this.settingsOffset = key.name === 'home' ? 0 : this.settingsMaximum || 0; this.settingsEnsureFocus = false; this.schedule(); return; }
      const rows = this.ui.settings.rows(), actions = settingsActions(rows);
      if (['up', 'down', 'left', 'right', 'tab'].includes(key.name)) {
        const next = navigateSettings(rows, this.ui.settings.focus, key.name, { shift: key.shift, column: this.settingsColumn || 0 });
        this.ui.settings.focus = next.focus; this.settingsColumn = next.column; this.settingsEnsureFocus = true; this.schedule();
      } else if (key.name === 'return') this.settingsAction(actions[this.ui.settings.focus]?.action);
      return;
    }
    if (this.panel === 'metrics' && !this.promptDraft) {
      key.bzzyHandled = true;
      const actions = this.ui.sessionMetrics?.actions() || [];
      if (['left', 'right', 'tab'].includes(key.name) && actions.length) {
        const backwards = key.name === 'left' || key.name === 'tab' && key.shift;
        this.metricsFocus = ((this.metricsFocus || 0) + (backwards ? actions.length - 1 : 1)) % actions.length;
        this.metricsTopRequested = true; this.bodyCache = null;
      } else if (key.name === 'return' && !actions[this.metricsFocus || 0]?.disabled) this.metricsAction(actions[this.metricsFocus || 0]?.action);
      else if (key.name === 'r' && !key.ctrl && !key.meta) this.metricsAction('refresh');
      else if (key.name === 'g' && !key.ctrl && !key.meta) this.metricsAction('history');
      else if (key.name === 'up' || key.name === 'down') this.scroll = Math.max(0, this.scroll + (key.name === 'up' ? 1 : -1));
      else if (key.name === 'home') this.scroll = this.scrollbar?.maximum || 0;
      else if (key.name === 'end') this.scroll = 0;
      this.schedule(); return;
    }
    if (this.panel === 'workflows' && !this.promptDraft) {
      key.bzzyHandled = true;
      const actions = libraryActionList(workflowRows(this.ui));
      if (['up', 'down', 'left', 'right', 'tab'].includes(key.name) && actions.length) {
        const backwards = ['up', 'left'].includes(key.name) || key.name === 'tab' && key.shift;
        this.workflowFocus = ((this.workflowFocus || 0) + (backwards ? actions.length - 1 : 1)) % actions.length;
        this.workflowEnsureFocus = true;
      } else if (key.name === 'return' && actions[this.workflowFocus || 0]) this.localCommand('/workflows ' + actions[this.workflowFocus || 0]);
      else if (key.name === 'home') this.scroll = this.scrollbar?.maximum || 0;
      else if (key.name === 'end') this.scroll = 0;
      this.schedule(); return;
    }
    if (this.panel === 'agents' && !this.promptDraft) {
      key.bzzyHandled = true;
      if (key.name === 'escape') { this.setPanel('chat'); return; }
      const rows = subagentRows(this.ui), actions = libraryActionList(rows);
      if (['up', 'down', 'left', 'right', 'tab'].includes(key.name) && actions.length) {
        const backwards = ['up', 'left'].includes(key.name) || key.name === 'tab' && key.shift;
        this.agentFocus = ((this.agentFocus || 0) + (backwards ? actions.length - 1 : 1)) % actions.length;
        this.agentEnsureFocus = true; this.schedule(); return;
      }
      const focused = actions[this.agentFocus || 0];
      if (key.name === 'space') {
        const toggle = libraryRowToggle(rows, focused);
        if (toggle) this.localCommand('/agents ' + toggle);
      } else if (key.name === 'return' && focused) this.localCommand('/agents ' + focused);
      return;
    }
    if (this.panel === 'skills' && !this.promptDraft) {
      if (key.name === 'escape') {
        if (returnToSkillLibrary(this.ui)) return;
        this.setPanel('chat'); return;
      }
      const rows = skillRows(this.ui), actions = libraryActionList(rows);
      if (['up', 'down', 'left', 'right', 'tab'].includes(key.name) && actions.length && !(this.ui.skillView === 'import' && ['left', 'right'].includes(key.name))) {
        const backwards = ['up', 'left'].includes(key.name) || key.name === 'tab' && key.shift;
        this.skillFocus = ((this.skillFocus || 0) + (backwards ? actions.length - 1 : 1)) % actions.length;
        this.skillEnsureFocus = true; this.schedule(); return;
      }
      if (key.name === 'space' && this.ui.skillView === 'library') {
        const toggle = libraryRowToggle(rows, actions[this.skillFocus || 0]);
        if (toggle) { this.localCommand('/skills ' + toggle); return; }
      }
      if (key.name === 'return' && this.ui.skillView === 'import' && this.value.trim()) {
        this.localCommand('/skills save-directory'); return;
      }
      if (key.name === 'return' && actions[this.skillFocus || 0]) { this.localCommand('/skills ' + actions[this.skillFocus || 0]); return; }
    }
    if (!this.canCompose()) return;

    const completions = this.completions();
    if (completions.length) {
      if (['up', 'down', 'tab', 'escape', 'return'].includes(key.name) && !key.ctrl && !key.meta && !(key.name === 'return' && key.shift) && !this.pasting) {
        key.bzzyHandled = true;
        if (key.name === 'up' || key.name === 'down') this.completionFocus = (this.completionFocus + (key.name === 'up' ? completions.length - 1 : 1)) % completions.length;
        else if (key.name === 'escape') this.completionDismissed = true;
        else {
          const choice = completions[this.completionFocus];
          if (key.name === 'tab' || choice.argument && this.value !== choice.command) { this.completeCommand(choice); return; }
          this.value = choice.command; this.cursor = [...this.value].length;
          // Enter confirms a command; the normal submit path handles local views below.
        }
        if (key.name !== 'return') { this.schedule(); return; }
      }
    }
    if (key.name === 'tab') return;
    if (key.ctrl && key.name === 'd' && !this.value) { this.finish(null); return; }
    const chars = [...this.value];
    if (key.name === 'return' && !key.meta && !key.shift && !this.pasting) {
      if (this.panel === 'skills' && this.ui.skillView === 'import') {
        this.localCommand('/skills save-directory');
        return;
      }
      if (!this.hidden && /^bzzy\b/.test(this.question || '') && this.value.trim() === '/usage') { this.value = ''; this.cursor = 0; this.ui.showAccountStatus(); return; }
      if (!this.hidden && /^bzzy\b/.test(this.question || '') && this.value.trim() === '/copy') { this.value = ''; this.cursor = 0; this.setCopyMode(true); return; }
      const panel = /^bzzy\b/.test(this.question || '') && !this.hidden && /^\/(chat|room|activity|http|sessions|settings|metrics)$/.exec(this.value.trim())?.[1];
      if (panel) { this.value = ''; this.cursor = 0; this.setPanel(panel); return; }
      this.submitMessage(); return;
    }
    if ((key.name === 'return' && (key.meta || key.shift)) || key.ctrl && key.name === 'j') { chars.splice(this.cursor++, 0, '\n'); }
    else if (key.meta && key.name === 'backspace' || key.ctrl && key.name === 'w') { const start = wordBoundary(chars, this.cursor, -1); chars.splice(start, this.cursor - start); this.cursor = start; }
    else if ((key.meta || key.ctrl) && key.name === 'delete') chars.splice(this.cursor, wordBoundary(chars, this.cursor, 1) - this.cursor);
    else if (key.name === 'backspace') { if (this.cursor) chars.splice(--this.cursor, 1); }
    else if (key.name === 'delete') chars.splice(this.cursor, 1);
    else if ((key.meta || key.ctrl) && key.name === 'left') this.cursor = wordBoundary(chars, this.cursor, -1);
    else if ((key.meta || key.ctrl) && key.name === 'right') this.cursor = wordBoundary(chars, this.cursor, 1);
    else if (key.name === 'left') this.cursor = Math.max(0, this.cursor - 1);
    else if (key.name === 'right') this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (key.name === 'home' || key.ctrl && key.name === 'a') this.cursor = 0;
    else if (key.name === 'end' || key.ctrl && key.name === 'e') this.cursor = chars.length;
    else if (key.ctrl && key.name === 'u') { chars.length = 0; this.cursor = 0; }
    else if (key.name === 'up' || key.name === 'down') {
      this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + (key.name === 'up' ? -1 : 1)));
      this.value = this.history[this.historyIndex] || ''; this.cursor = [...this.value].length; this.schedule(); return;
    } else if (text && !key.ctrl && !key.meta && key.name !== 'escape') { const inserted = [...text].filter(char => char >= ' ' || this.pasting && /[\n\r]/.test(char)); chars.splice(this.cursor, 0, ...inserted); this.cursor += inserted.length; }
    this.value = chars.join(''); this.schedule();
  }

  content(width) {
    const { color } = this.theme;
    const lines = [], put = (text, tone = palette.text, bold = false) => lines.push(color(text, tone, bold));
    this.contentHits = [];
    if (this.selection) {
      const picker = this.selection, compact = (this.selectionHeight || 16) < 12;
      if (!compact) put('');
      put('  ' + picker.title + (picker.choices.length ? ` · ${picker.focus + 1}/${picker.choices.length}` : ''), palette.accent, true);
      put(picker.hint ? '  ' + picker.hint : picker.single ? picker.selectEffort ? '  ↑/↓ model · ←/→ effort · Enter confirms · Esc cancels' : '  ↑/↓ chooses · Enter confirms · Esc cancels' : '  Space selects · ↑/↓ moves · Enter starts · Esc cancels', palette.muted);
      if (picker.loading) put('  ' + spinner[this.frame % spinner.length] + ' ' + (picker.loadingLabel || 'Loading choices…'), palette.accent);
      const warning = picker.warning ? wrap(picker.warning, width - 5).slice(0, compact ? 1 : 2) : [];
      for (const line of warning) put('  ' + line, palette.warning);
      const focused = picker.choices[picker.focus];
      const effortDetail = picker.selectEffort ? focused?.efforts?.length ? `Effort: ${picker.efforts.get(focused.value)}${focused.defaultEffort ? ` · provider default: ${focused.defaultEffort}` : ''}. ` : focused?.supportsEffort === false ? 'This model has no effort setting. ' : '' : '';
      const details = picker.single ? effortDetail + (focused?.description || picker.description || '') : picker.description || 'Every participant reviews the same fixed reply independently.';
      const detailLines = details ? wrap(details, width - 5, compact ? 1 : picker.descriptionRows || 2) : [];
      const available = Math.max(1, (this.selectionHeight || 16) - lines.length - detailLines.length - 1 - (compact ? 0 : 1) - (picker.error ? 1 : 0));
      const offset = Math.max(0, Math.min(picker.focus - Math.floor(available / 2), picker.choices.length - available));
      for (let index = offset; index < Math.min(picker.choices.length, offset + available); index++) {
        const choice = picker.choices[index], mark = picker.single ? choice.selected ? '●' : '○' : `[${picker.selected.has(choice.value) ? 'x' : ' '}]`;
        const effort = picker.selectEffort && choice.efforts?.length ? `  ‹ ${picker.efforts.get(choice.value)} ›` : '';
        const label = `  ${index === picker.focus ? '›' : ' '} ${mark} ${clip(choice.label, width - 10 - cellWidth(effort))}`;
        this.contentHits.push({ type: 'choice', index, row: lines.length, left: 3, right: width });
        if (effort) {
          this.contentHits.push({ type: 'effort', index, direction: 'left', row: lines.length, left: cellWidth(label) + 3, right: cellWidth(label) + 4 });
          this.contentHits.push({ type: 'effort', index, direction: 'right', row: lines.length, left: cellWidth(label + effort) - 1, right: cellWidth(label + effort) });
        }
        put(label + effort, choice.disabled ? palette.muted : index === picker.focus ? palette.accent : palette.text, index === picker.focus && !choice.disabled);
      }
      if (picker.error) put('  ' + picker.error, palette.warning);
      if (!compact) put('');
      for (const line of detailLines) put('  ' + line, palette.muted);
      if (!picker.locked || !picker.loading) {
        this.contentHits.push({ type: 'confirm', row: lines.length, left: 3, right: 13 }, { type: 'cancel', row: lines.length, left: 17, right: 26 });
        put('  [ Confirm ]   [ Cancel ]', palette.accent);
      }
    } else if (this.panel === 'settings') {
      const tightMain = this.ui.settings.page === 'main' && (this.output.rows || 24) <= 24 && this.ui.settings.rows().filter(row => row.card).length > 4;
      const layout = settingsLayout(this.ui.settings, width, this.theme, { spaced: (this.output.rows || 24) >= 18 && !tightMain });
      this.settingsFocusRow = layout.focusRow; this.settingsFocusedAction = layout.focusAction; this.contentHits.push(...layout.hits); lines.push(...layout.lines);
    } else if (this.panel === 'skills') {
      let actionIndex = 0;
      for (const row of skillRows(this.ui)) {
        if (row.segments) {
          let column = 0, rendered = '';
          for (const segment of row.segments) {
            const selected = segment.action && actionIndex++ === (this.skillFocus || 0);
            const size = cellWidth(segment.text);
            if (selected) this.skillFocusRow = lines.length;
            if (segment.action) this.contentHits.push({ type: 'skill-action', action: segment.action,
              row: lines.length, left: column + 1, right: column + size });
            rendered += selected
              ? fillSurface(segment.text, size, this.theme, palette.selection, palette.accent, true)
              : color(segment.text, palette[segment.tone] || palette.text, segment.tone === 'accent');
            column += size;
          }
          lines.push(rendered);
          continue;
        }
        const rowIndex = row.action ? actionIndex++ : -1, rowFocused = rowIndex === (this.skillFocus || 0);
        if (rowFocused) this.skillFocusRow = lines.length;
        const wrapped = wrap((rowFocused ? '› ' : '  ') + row.text, width - 4);
        if (row.action) for (let offset = 0; offset < wrapped.length; offset++)
          this.contentHits.push({ type: 'skill-action', action: row.action, row: lines.length + offset, left: 2, right: width });
        for (const line of wrapped) put('  ' + line, row.tone === 'muted' ? palette.muted : palette.accent, rowFocused);
      }
    } else if (this.panel === 'agents') {
      let actionIndex = 0;
      for (const row of subagentRows(this.ui)) {
        if (row.segments) {
          let column = 0, rendered = '';
          for (const segment of row.segments) {
            const selected = segment.action && actionIndex++ === (this.agentFocus || 0), size = cellWidth(segment.text);
            if (selected) this.agentFocusRow = lines.length;
            if (segment.action) this.contentHits.push({ type: 'agent-action', action: segment.action,
              row: lines.length, left: column + 1, right: column + size });
            rendered += selected
              ? fillSurface(segment.text, size, this.theme, palette.selection, palette.accent, true)
              : color(segment.text, palette[segment.tone] || palette.text, segment.tone === 'accent');
            column += size;
          }
          lines.push(rendered); continue;
        }
        const selected = row.action && actionIndex++ === (this.agentFocus || 0);
        if (selected) this.agentFocusRow = lines.length;
        const wrapped = wrap((selected ? '› ' : '  ') + row.text, width - 4);
        if (row.action) for (let offset = 0; offset < wrapped.length; offset++)
          this.contentHits.push({ type: 'agent-action', action: row.action, row: lines.length + offset, left: 2, right: width });
        for (const line of wrapped) put('  ' + line, palette[row.tone] || palette.text, Boolean(selected));
      }
    } else if (this.panel === 'workflows') {
      let actionIndex = 0;
      for (const row of workflowRows(this.ui)) {
        const selected = row.action && actionIndex++ === (this.workflowFocus || 0);
        if (selected) this.workflowFocusRow = lines.length;
        const wrapped = wrap((selected ? '› ' : '  ') + row.text, width - 4);
        if (row.action) for (let offset = 0; offset < wrapped.length; offset++)
          this.contentHits.push({ type: 'workflow-action', action: row.action, row: lines.length + offset, left: 2, right: width });
        for (const line of wrapped) put('  ' + line, palette[row.tone] || palette.text, Boolean(selected));
      }
    } else if (this.panel === 'metrics') {
      const layout = sessionMetricsLayout(this.ui.sessionMetrics, width, { currentGoal: this.goal, alias: this.alias, focus: this.metricsFocus || 0 });
      for (const row of layout.lines) put(row.text, palette[row.tone] || palette.text, row.bold);
      this.contentHits.push(...layout.hits);
    } else if (this.panel === 'room') {
      for (const item of this.sharedRoom) {
        const review = item.kind === 'review';
        const sender = this.peerLabel(review ? item.reviewer : item.from), recipient = this.peerLabel(review ? item.peerSessionId : item.to);
        const caption = review ? `${sender} · review: ${clean(item.assessment || 'recorded')}` : `${sender} → ${recipient}`;
        const label = clip(caption, width - 4), firstRow = lines.length;
        put(`  ${label}`, review && item.assessment === 'disputed' ? palette.warning : palette.agent, true);
        const time = String(item.createdAt || item.occurredAt || '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
        const refs = (Array.isArray(item.evidence) ? item.evidence : []).map(id => clean(id).slice(0, 8)).join(', ');
        if (time) put('  ' + time, palette.muted);
        for (const line of wrap(review ? item.rationale || '' : item.text || '', width - 5)) put('  ' + line);
        if (review) for (const line of wrap(`Reviewing ${recipient} · message ${clean(item.messageId || '').slice(0, 8)} · peer judgment`, width - 5)) put('  ' + line, palette.muted);
        if (refs) for (const line of wrap(`Evidence: ${refs}`, width - 5)) put('  ' + line, palette.accent);
        for (let row = firstRow; row < lines.length; row++) this.contentHits.push({ type: 'response', entry: item.copyEntry, row, left: 3, right: width - 2 });
        put('');
      }
    } else if (this.panel === 'activity') {
      for (const item of this.activities) {
        const worker = this.mode === 'delegate' && item.sessionId && item.sessionId !== (this.ui.activeTab || this.ui.sessionId);
        const attribution = worker ? `Hands · ${item.agent || this.executor?.provider || 'executor'} · ` : '';
        put(`  ${item.closedAt ? '✓' : '›'} ${clip(attribution + item.summary, width - 4)}`, item.tool ? palette.muted : palette.accent, !item.tool);
        if (!item.tool) for (const line of wrap(item.details || '', width - 5)) put('    ' + line, palette.muted);
        if (item.inference) for (const line of wrap('Inference: ' + item.inference, width - 5)) put('    ' + line, palette.muted);
        put('');
      }
    } else if (this.panel === 'http') {
      for (const item of this.traffic) {
        const reported = item.provenance === 'backend-reported';
        put(reported ? `  WEB · ${item.tool || item.provider} · ${item.backendState || 'reported'}` : `  ${item.method || ''}  ${item.status || (item.type === 'network.error' ? 'error' : 'pending')}  ${item.durationMs != null ? item.durationMs + 'ms' : ''}`, palette.accent, true);
        for (const line of wrap(item.url, width - 5)) put('    ' + line);
        if (reported) put('    Backend-reported visit · HTTP status not exposed', palette.muted);
        put('');
      }
    } else {
      for (const entry of this.entries) {
        if (entry.kind === 'tool' && !this.showTools) continue;
        const layout = this.entryLayout(entry, width);
        if (entry.kind === 'assistant') for (let offset = 0; offset < layout.lines.length - 1; offset++)
          this.contentHits.push({ type: 'response', entry, row: lines.length + offset, left: 3, right: width - 2 });
        if (entry.kind === 'approval') this.contentHits.push({ type: 'approval-details', id: entry.questionId, row: lines.length, left: 3, right: width - 2 });
        if (entry.kind === 'debate') for (const hit of layout.hits) this.contentHits.push({ ...hit, row: lines.length + hit.row });
        for (const line of layout.lines) lines.push(line);
      }
    }
    return lines;
  }

  entryLayout(entry, width) {
    const cached = this.entryLayouts.get(entry);
    if (cached?.width === width && cached.text === entry.text) return cached;
    if (entry.kind === 'debate') {
      const layout = { ...debateEntryLayout(entry, width, this.theme), width, text: entry.text };
      this.entryLayouts.set(entry, layout); return layout;
    }
    if (entry.kind === 'invocation') {
      const layout = { ...invocationEntryLayout(entry, width, this.theme), width, text: entry.text };
      this.entryLayouts.set(entry, layout); return layout;
    }
    const { color } = this.theme;
    const lines = [], put = (text, tone = palette.text, bold = false) => lines.push(color(text, tone, bold));
    const replyLine = line => color('  ▎ ', palette.agent) + fillSurface(line, width - 6, this.theme, palette.agentSurface, palette.text);
    if (entry.kind === 'approval') {
      const tone = entry.decision === 'approved' ? palette.goalSuccess : entry.decision === 'denied' ? palette.danger : palette.warning;
      put('  ' + (entry.decision === 'approved' ? '✔ Approved once' : entry.decision === 'denied' ? '✕ Denied' : '◇ Permission requested') + '  ' + (entry.expanded ? '▴ Hide details' : '▾ Show details'), tone, true);
      const command = clean(entry.text).replace(/\s*Allow once\? \[y\/N\]\s*$/, '');
      const rows = entry.expanded ? wrap(command, width - 8) : wrapProse(clip(command, Math.max(20, (width - 8) * 2)), width - 8);
      for (const line of rows) lines.push(color('  │ ', tone) + fillSurface(line, width - 6, this.theme, palette.surface, palette.text));
      put('');
    }
    else if (entry.kind === 'user') {
      const label = 'YOU' + (entry.goal ? ' · GOAL' : ''), text = clean(entry.text);
      put('  ' + label, palette.user, true);
      for (const line of wrapProse(text, width - 7)) {
        lines.push(color('  ▎ ', palette.user)
          + fillSurface(line, width - 6, this.theme, palette.userSurface, palette.userText));
      }
      put('');
    }
    else if (entry.kind === 'notice') { for (const line of wrap(entry.text, width - 5)) put('  · ' + line, palette.muted); put(''); }
    else if (entry.kind === 'tool') put('  › ' + clip(entry.text, width - 5), palette.muted);
    else {
      // Keep the original body for replay and copying; derive presentation only
      // after a complete valid root is available. Incomplete markup stays text.
      const projection = entry.kind === 'assistant' ? parseMessageBody(entry.text) : null;
      const displayText = clean(projection ? projection.plainText : entry.text);
      const isFormatted = Boolean(projection?.isFormatted);
      const tone = ['error', 'question'].includes(entry.kind) ? palette.warning : palette.agent;
      const label = entry.kind === 'assistant' ? 'AGENT · ' + (entry.label || 'BZZY') : entry.kind === 'question' ? 'YOUR INPUT IS NEEDED' : entry.kind.toUpperCase();
      const displayLabel = entry.kind === 'assistant' ? clip(label, width - 4) : label;
      if (isFormatted) {
        put(`  ${displayLabel}`, tone, true);
        const rendered = renderMessageContent(projection, { width: width - 7, theme: this.theme, background: palette.agentSurface });
        for (const line of rendered.lines) lines.push(replyLine(line));
        put('');
        const layout = { width, text: entry.text, lines, displayText, isFormatted };
        this.entryLayouts.set(entry, layout); return layout;
      }
      const append = entry.kind === 'assistant' && cached?.width === width && cached.rawLines && isFormatted === cached.isFormatted && displayText.startsWith(cached.displayText);
      // Only the final wrapped line can change when a response receives a delta.
      // Keep older Unicode/Markdown lines as well as completed replies cached.
      const tail = wrapProse(append ? cached.rawLines.at(-1) + displayText.slice(cached.displayText.length) : displayText, width - (entry.kind === 'assistant' ? 7 : 5));
      const rawLines = append ? [...cached.rawLines.slice(0, -1), ...tail] : tail;
      if (append) for (const line of cached.lines.slice(0, -2)) lines.push(line);
      else put(`  ${displayLabel}`, tone, true);
      for (const line of tail) {
        const text = isFormatted ? line : line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/^#{1,6}\s+/, '');
        if (entry.kind === 'assistant') lines.push(replyLine(text));
        else put('  ' + text, entry.kind === 'error' ? palette.warning : palette.text, !isFormatted && /^#{1,6}\s/.test(line));
      }
      put('');
      const layout = { width, text: entry.text, lines, rawLines, displayText, isFormatted };
      this.entryLayouts.set(entry, layout); return layout;
    }
    const layout = { width, text: entry.text, lines };
    this.entryLayouts.set(entry, layout); return layout;
  }

  schedule() { if (!this.renderTimer && !this.closed && !this.copyMode && !this.outputBlocked) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, animationInterval); }
  tokenLabel() {
    const partial = ['besties', 'parallel'].includes(this.mode) && this.groupUsage && !this.groupUsage.complete;
    return this.tokens != null ? (partial ? '≥' : '') + this.tokens.toLocaleString() + ' tokens' : 'tokens —';
  }
  counters() {
    const status = this.clipboardStatus && Date.now() < this.clipboardStatusUntil ? this.clipboardStatus : this.copyMode ? 'COPY MODE · live updates held'
      : this.busy ? spinner[this.frame % spinner.length] + ' ' + this.state : '● ' + this.state;
    const elapsed = this.startedAt ? duration(Math.max(0, ((this.finishedAt ? Date.parse(this.finishedAt) : Date.now()) - Date.parse(this.startedAt)) / 1000)) : '';
    return [status, this.goal ? 'goal ' + this.goal.status : '', elapsed, this.tokenLabel(), this.effort].filter(Boolean).join('  ·  ');
  }
  modelHeader(width) {
    const color = this.theme.color, lines = [];
    const effort = ' Effort: ' + (this.effort || 'default').replace(/^effort /, '') + ' ▾ ';
    const model = ' ' + clip(this.model, Math.max(1, width - cellWidth(effort) - 17)) + ' ▾ ';
    let column = 3;
    const controls = [[model, '/providers'], [effort, '/effort'], [' Save ', '/default']];
    let line = '  ';
    for (const [label, command] of controls) {
      if (column + cellWidth(label) > width) break;
      const disabled = this.busy || this.ui.sessionMode === 'VIEW' || command !== '/providers' && this.modelSelectionRequired;
      this.hitTargets.push({ type: 'model-control', command, disabled, row: 0, left: column, right: column + cellWidth(label) - 1 });
      column += cellWidth(label) + 1; line += fillSurface(label, cellWidth(label), this.theme, command === '/default' && !disabled ? palette.selection : palette.surface, disabled ? palette.muted : palette.accent, !disabled) + ' ';
    }
    lines.push(line); return lines;
  }
  goalBadgeLayout(width, { reserved = 0, surface = palette.background, showEmpty = false } = {}) {
    const primary = goalIndicator(this.goal, this.frame, { validating: this.mode === 'debate' && this.busy }), validation = goalValidationIndicator(this.goal, this.goalValidation, this.frame);
    if (!primary && !showEmpty) return { line: '', extra: [] };
    const badge = (indicator, maximum) => {
      const text = ' ' + clip(indicator.label, Math.max(1, maximum - 2)) + ' ';
      return fillSurface(text, cellWidth(text), this.theme, indicator.tone, indicator.empty ? palette.muted : palette.background, true, surface);
    };
    const available = Math.max(3, width - reserved - 2), extra = [];
    let line = '  ' + badge(primary || { label: 'Goal · none', tone: palette.elevated, empty: true }, available);
    if (validation) {
      const rendered = badge(validation, Math.max(3, width - 4));
      if (cellWidth(line) + cellWidth(rendered) + 1 <= width - reserved) line += ' ' + rendered;
      else extra.push('  ' + rendered);
      if (validation.reason) extra.push(this.theme.color(clip('  ' + validation.reason, width), validation.tone));
    }
    return { line, extra };
  }
  simpleChatLayout() {
    return !this.ui.minimal && ['chat', 'room', 'skills', 'agents', 'workflows', 'metrics'].includes(this.panel);
  }
  elapsedClock() {
    const durationSeconds = () => {
      if (!this.startedAt) return 0;
      const start = Date.parse(this.startedAt);
      if (!Number.isFinite(start)) return 0;
      const end = this.finishedAt ? Date.parse(this.finishedAt) : this.busy ? Date.now() : start;
      return Math.max(0, (Number.isFinite(end) ? end : start) - start) / 1000;
    };
    const goalSeconds = Number(this.goal?.runtimeUsedSeconds ?? this.goal?.timeUsedSeconds);
    const total = Number.isFinite(goalSeconds) && goalSeconds >= 0
      ? goalSeconds + (this.busy ? durationSeconds() : 0)
      : durationSeconds();
    const seconds = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
    const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
    const mm = String(Math.floor(seconds % 3600 / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  simpleTopBar(width) {
    const { color } = this.theme, surface = palette.surface;
    if (this.aliasEdit) {
      const value = [...this.aliasEdit.value].slice(0, this.aliasEdit.cursor).join('') + '▏'
        + [...this.aliasEdit.value].slice(this.aliasEdit.cursor).join('');
      const save = ' Save name ', cancel = ' Cancel ';
      const right = fillSurface(save, cellWidth(save), this.theme, palette.selection, palette.accent, true, surface)
        + ' ' + fillSurface(cancel, cellWidth(cancel), this.theme, palette.elevated, palette.text, false, surface);
      const left = color(clip('  ' + value, Math.max(1, width - cellWidth(right) - 1)), palette.text, true);
      const leftWidth = cellWidth(left), rightWidth = cellWidth(right);
      const saveLeft = width - rightWidth + 1;
      this.hitTargets.push(
        { type: 'alias-save', row: 1, left: saveLeft + 1, right: saveLeft + cellWidth(save) },
        { type: 'alias-cancel', row: 1, left: saveLeft + cellWidth(save) + 2, right: width },
      );
      return left + ' '.repeat(Math.max(0, width - leftWidth - rightWidth)) + right;
    }
    const leftVariants = [
      { sessions: '  Open Sessions ▾', create: '   + New Session', alias: true },
      { sessions: 'Sessions ▾', create: '+ New', alias: true },
      { sessions: 'Sessions', create: '+ New', alias: true },
      { sessions: '  Open Sessions ▾', create: '   + New Session', alias: false },
      { sessions: ' Open Sessions ▾', create: '  + New Session', alias: false },
      { sessions: '  Open Sessions ▾', create: '   + New', alias: false },
      { sessions: 'Open Sessions ▾', create: '+ New', alias: false },
      { sessions: '  Open Sessions', create: '   + New', alias: false },
      { sessions: 'Sessions', create: '+ New', alias: false },
    ];
    const alias = this.alias ? clip(this.alias, Math.max(1, Math.floor(width / 4))) : '';
    const relayOnline = this.ui.connectionStatus?.core === true && this.ui.connectionStatus?.relay === true;
    const relayTone = relayOnline ? palette.goalSuccess : palette.danger;
    const relayFull = color('●', relayTone, true) + color(' BZZY Relay', palette.muted);
    const relayDot = color('●', relayTone, true);
    const deepseekBalance = this.provider === 'deepseek' ? accountStatusLabels(this.ui.accountStatus)[2].value : null;
    const balance = deepseekBalance != null ? {
      text: ` ${deepseekBalance} `, tone: deepseekBalance.startsWith('$') ? palette.goalSuccess : palette.muted,
      bold: true, type: 'usage-balance', surface: true,
    } : null;
    const metric = hostMetricsCompact(this.ui.hostMetrics).replace(/\sGB$/, 'G');
    const tinyMetric = metric.replace('CPU ', 'CPU').replace(' · RAM ', ' ');
    const selectedRelay = width >= 112 ? relayFull : relayDot;
    const selectedMetric = width >= 112 ? metric : tinyMetric;
    const actionsFull = [
      { text: ' Skills ', tone: palette.accent, bold: true, type: 'top-skills', surface: true },
      { text: ' Agents ', tone: palette.accent, bold: true, type: 'top-agents', surface: true },
      { text: ' Metrics ', tone: palette.accent, bold: true, type: 'top-metrics', surface: true },
      { text: ' ⚙ Settings ', tone: palette.accent, bold: true, type: 'top-settings', surface: true },
    ];
    const actionsCompact = [
      { text: 'Skills', tone: palette.accent, bold: true, type: 'top-skills' },
      { text: 'Agents', tone: palette.accent, bold: true, type: 'top-agents' },
      { text: 'Metrics', tone: palette.accent, bold: true, type: 'top-metrics' },
      { text: '⚙ Settings', tone: palette.accent, bold: true, type: 'top-settings' },
    ];
    const actionOptions = [actionsFull, actionsCompact];
    const withBalance = tokens => balance ? [tokens[0], balance, ...tokens.slice(1)] : tokens;
    const rightVariants = [
      withBalance([{ text: selectedRelay }, { text: selectedMetric }, ...actionsFull]),
      withBalance([{ text: selectedRelay }, { text: selectedMetric }, ...actionsCompact]),
      withBalance([{ text: relayDot }, ...actionsFull]),
      withBalance([{ text: relayDot }, ...actionsCompact]),
      [{ text: relayDot }, { text: selectedMetric }, ...actionsFull],
      [{ text: relayDot }, ...actionsCompact],
      ...actionOptions,
    ];
    let selected;
    for (const preserveAlias of alias && width >= 100 ? [true, false] : [false]) {
      for (const rightTokens of rightVariants) {
        const rightWidth = rightTokens.reduce((sum, token) => sum + cellWidth(token.text), 0) + Math.max(0, rightTokens.length - 1) * 2;
        for (const variant of leftVariants) {
          if (preserveAlias && !variant.alias) continue;
          let left = variant.sessions + '  │ ' + variant.create;
          if (variant.alias && alias) left += '  │ ' + alias;
          if (cellWidth(left) + rightWidth + 1 <= width) {
            selected = { ...variant, alias: variant.alias && alias, rightTokens, rightWidth, left };
            break;
          }
        }
        if (selected) break;
      }
      if (selected) break;
    }
    if (!selected) {
      selected = { sessions: 'S', create: '', alias: false,
        rightTokens: [{ text: '⚙', tone: palette.accent, bold: true, type: 'top-settings' }], rightWidth: 1, left: 'S' };
    }
    const tokens = [
      { text: selected.sessions, tone: palette.accent, bold: true, type: 'top-sessions' },
      { text: '  │ ', tone: palette.muted },
      { text: selected.create, tone: palette.accent, bold: true, type: 'session-new' },
      ...(selected.alias ? [{ text: '  │ ', tone: palette.muted }, { text: alias, tone: palette.text, type: 'alias' }] : []),
    ];
    let left = '', column = 0;
    for (const token of tokens) {
      const size = cellWidth(token.text);
      if (token.type) this.hitTargets.push({ type: token.type, row: 1, left: column + 1, right: column + size });
      left += color(token.text, token.tone, token.bold);
      column += size;
    }
    const rightStart = width - selected.rightWidth;
    let right = '', offset = rightStart;
    for (const [index, token] of selected.rightTokens.entries()) {
      if (index) { right += '  '; offset += 2; }
      const size = cellWidth(token.text);
      if (token.type) this.hitTargets.push({ type: token.type, row: 1, left: offset + 1, right: offset + size });
      const active = token.type === 'top-skills' && this.panel === 'skills'
        || token.type === 'top-metrics' && this.panel === 'metrics'
        || token.type === 'top-agents' && this.panel === 'agents';
      right += token.surface
        ? fillSurface(token.text, size, this.theme, active ? palette.accent : palette.selection,
          active ? palette.background : token.tone, token.bold, surface)
        : color(token.text, token.tone || palette.muted, token.bold);
      offset += size;
    }
    return left + ' '.repeat(Math.max(1, rightStart - column)) + right;
  }
  settingsTopBar(width) {
    const { color } = this.theme, surface = palette.surface;
    const section = this.ui.settings?.page === 'main' ? 'Settings' : this.ui.settings?.pageTitle || 'Settings';
    const left = color(clip('  ' + section, Math.max(1, width - 18)), palette.text, true);
    const metrics = width >= 56 ? hostMetricsCompact(this.ui.hostMetrics) : '';
    const relayOnline = this.ui.connectionStatus?.core === true && this.ui.connectionStatus?.relay === true;
    const relayTone = relayOnline ? palette.goalSuccess : palette.danger;
    const relay = color('●', relayTone, true) + color(' BZZY Relay', palette.muted);
    const relayDot = color('●', relayTone, true);
    const metricText = metrics ? color(metrics, palette.muted) : '';
    const exit = this.ui.settingsOnly ? '  Esc · Exit  ' : '  Esc · Chat  ';
    const rightOptions = [
      relay + (metricText ? '  ' + metricText : '') + '  ' + exit,
      relayDot + (metricText ? '  ' + metricText : '') + '  ' + exit,
      relayDot + '  ' + exit,
      exit,
    ].filter((value, index, all) => all.indexOf(value) === index);
    const right = rightOptions.find(option => cellWidth(left) + cellWidth(option) + 1 <= width) || exit;
    const gap = Math.max(1, width - cellWidth(left) - cellWidth(right));
    const exitLeft = width - cellWidth(exit) + 1;
    this.hitTargets.push({ type: 'settings-exit', row: 1, left: exitLeft, right: width });
    return left + ' '.repeat(gap) + right.slice(0, -cellWidth(exit))
      + fillSurface(exit, cellWidth(exit), this.theme, palette.selection, palette.accent, true, surface);
  }
  codexBottom(width, height, completions) {
    const { color } = this.theme, surface = palette.surface;
    const lines = [], hits = [];
    const fitStyled = (line, limit = width) => cellWidth(line) <= limit ? line : color(clip(line, limit), palette.text);
    const align = (left, right) => {
      const gap = Math.max(1, width - cellWidth(left) - cellWidth(right));
      return left + ' '.repeat(gap) + right;
    };
    if (this.ui.tabs?.length > 1) {
      let column = 1, line = ' ';
      for (const [index, tab] of this.ui.tabs.entries()) {
        const label = tab.id === this.ui.activeTab ? ` [${index} ${agentLabel(tab.agent)}] ` : `  ${index} ${agentLabel(tab.agent)} `;
        hits.push({ type: 'tab', id: tab.id, row: lines.length, left: column, right: column + cellWidth(label) - 1 });
        line += (tab.id === this.ui.activeTab ? color(label, palette.accent, true) : color(label, palette.muted));
        column += cellWidth(label);
        if (cellWidth(line) >= width) break;
      }
      lines.push(fitStyled(line));
    }
    if (this.pendingApproval && (!this.pendingApproval.expiresAt || this.pendingApproval.expiresAt > Date.now())) {
      const disabled = this.ui.sessionMode === 'VIEW' || !this.ui.onAnswerApproval || this.approvalSubmitting;
      let line = '  ', column = 3;
      for (const [text, answer, tone] of [[' ✔ Approve once ', 'yes', palette.goalSuccess], [' ✕ Deny ', 'no', palette.danger]]) {
        const button = fillSurface(text, cellWidth(text), this.theme, disabled ? palette.surface : tone,
          disabled ? palette.muted : palette.background, true);
        line += button + ' ';
        if (!disabled) hits.push({ type: 'approval', answer, row: lines.length, left: column, right: column + cellWidth(text) - 1 });
        column += cellWidth(text) + 1;
      }
      lines.push(fitStyled(line));
    }
    if (this.busy && (this.currentTool || this.currentActivity)) {
      lines.push(color(clip('  ' + (this.currentTool || this.currentActivity), width), palette.muted));
    }
    if (completions.length) {
      const maximum = height < 20 ? 2 : height < 28 ? 3 : 5;
      const offset = Math.max(0, Math.min(this.completionFocus - Math.floor(maximum / 2), completions.length - maximum));
      lines.push(color(clip('  Commands · ↑/↓ choose · Tab complete · Esc close', width), palette.muted));
      for (let index = offset; index < Math.min(completions.length, offset + maximum); index++) {
        const item = completions[index];
        hits.push({ type: 'command', choice: item, row: lines.length, left: 3, right: width });
        lines.push(color(clip(`  ${index === this.completionFocus ? '›' : ' '} ${item.command.padEnd(18)}${item.description}`, width),
          index === this.completionFocus ? palette.accent : palette.muted, index === this.completionFocus));
      }
    }

    const composerTop = lines.length;
    const breathingRoom = height >= 18;
    if (this.promptDraft && this.question) {
      hits.push({ type: 'back', row: lines.length, left: 3, right: 9 });
      lines.push(color('  ← Back', palette.accent, true) + color(clip('  ' + this.question, Math.max(0, width - 8)), palette.text));
    }
    if (breathingRoom) lines.push('');
    const skillDirectoryInput = this.panel === 'skills' && this.ui.skillView === 'import';
    const skillDetail = this.panel === 'skills' && Boolean(this.ui.skillPreview || this.ui.skillHistoryState
      || this.ui.skillSyncDetails || this.ui.skillPromotionDraft || this.ui.skillCreatorDraft || this.ui.skillMoveDraft || this.ui.definitionBundleDraft?.panel === 'skills');
    const hasSubmit = (this.promptDraft || skillDirectoryInput || !['skills', 'agents', 'workflows', 'metrics'].includes(this.panel))
      && Boolean(this.resolveInput || this.ui.sessionId) && this.ui.sessionMode !== 'VIEW';
    const prompt = this.promptDraft && this.question ? this.question
      : this.panel === 'agents' ? this.ui.definitionBundleDraft?.panel === 'agents' ? 'ZIP review · Esc goes back' : this.ui.subagentCreatorDraft ? 'Agent preview · Esc returns to library' : 'Agents · Esc returns to chat'
      : this.panel === 'workflows' ? 'Workflows · ↑/↓ choose · Enter opens · Esc goes back'
      : this.panel === 'metrics' ? '←/→ scope · Enter opens · G goals · R refresh · PgUp/PgDn scroll'
      : this.ui.definitionBundleDraft?.panel === 'skills' && this.panel === 'skills' ? 'ZIP review · Esc goes back'
      : skillDirectoryInput ? 'Codex skills directory'
      : skillDetail ? 'Skill · Esc goes back'
      : this.panel === 'skills' ? 'Library · Esc returns to chat'
      : this.panel === 'room' ? 'Message all agents'
      : this.ui.sessionMode === 'VIEW' ? 'Read-only session'
        : this.promptDraft && this.question ? this.question
          : this.mode === 'delegate' && !this.goal ? 'Ask BZZY, or type /goal to delegate work'
            : 'Ask BZZY to do anything';
    const panelOnly = ['metrics', 'workflows'].includes(this.panel) && !this.promptDraft;
    const visibleValue = panelOnly ? '' : this.hidden ? '•'.repeat([...this.value].length) : this.value.replaceAll('\n', ' ↵ ');
    const before = panelOnly ? '' : this.hidden ? '•'.repeat(this.cursor) : [...this.value].slice(0, this.cursor).join('').replaceAll('\n', ' ↵ ');
    const sendLabel = this.promptDraft ? ' Confirm ↵ ' : skillDirectoryInput ? ' Save & refresh ' : ' Send ↵ ';
    const prefixWidth = 4, sendWidth = hasSubmit ? cellWidth(sendLabel) : 0;
    const inputWidth = Math.max(1, width - prefixWidth - (hasSubmit ? sendWidth + 1 : 0));
    const offset = Math.max(0, cellWidth(before) - inputWidth + 1);
    const inputText = visibleValue ? clip(cropLeft(visibleValue, offset), inputWidth, '') : clip(prompt, inputWidth);
    const inputLine = color('  › ', palette.accent, true) + color(inputText, visibleValue ? palette.text : palette.muted)
      + ' '.repeat(Math.max(0, inputWidth - cellWidth(inputText)));
    lines.push(inputLine + (hasSubmit ? ' ' + fillSurface(sendLabel, sendWidth, this.theme,
      this.value && !this.renderingPicker ? palette.accent : palette.selection,
      this.value && !this.renderingPicker ? palette.background : palette.accent, true, surface) : ''));
    const inputIndex = lines.length - 1;
    if (hasSubmit) hits.push({ type: 'confirm', row: inputIndex, left: prefixWidth + inputWidth + 2, right: width });
    if (breathingRoom) lines.push('');

    if (this.panel === 'chat' && !this.promptDraft) {
      const name = workflowChatLabel(this.ui);
      if (name !== 'None' && name !== 'Unavailable') {
        const label = clip(`  Workflow: ${name} · future goals`, width);
        hits.push({ type: 'workflow-open', row: lines.length, left: 3, right: cellWidth(label) });
        lines.push(color(label, /unavailable/i.test(name) ? palette.warning : palette.muted));
      }
    }

    const effort = (this.effort || 'default').replace(/^effort /, '').replace(/^provider default$/, 'default');
    const usage = `${this.tokenLabel()} · ${this.elapsedClock()}`;
    const effortText = ` effort ${effort} ▾ `, modelBudget = Math.max(8, width - cellWidth(effortText) - cellWidth(usage) - 7);
    const modelText = ` ${clip(this.model, modelBudget)} ▾ `;
    const metaRow = lines.length;
    let modelColumn = 3;
    hits.push({ type: 'model-control', command: '/providers', disabled: this.busy || this.ui.sessionMode === 'VIEW',
      row: metaRow, left: modelColumn, right: modelColumn + cellWidth(modelText) - 1 });
    const modelPart = color('  ', palette.text) + fillSurface(modelText, cellWidth(modelText), this.theme, palette.elevated,
      this.modelSelectionRequired ? palette.muted : palette.accent, true, surface);
    modelColumn += cellWidth(modelText);
    const effortPart = ' ' + fillSurface(effortText, cellWidth(effortText), this.theme, palette.selection,
      palette.accent, true, surface);
    hits.push({ type: 'model-control', command: '/effort', disabled: this.busy || this.ui.sessionMode === 'VIEW' || this.modelSelectionRequired,
      row: metaRow, left: modelColumn + 2, right: modelColumn + 1 + cellWidth(effortText) });
    lines.push(align(modelPart + effortPart, color(usage, palette.muted)));
    if (breathingRoom) lines.push('');

    const enabled = this.ui.yoloEnabled?.() || false;
    const yoloLabel = this.promptDraft ? ' ← Back '
      : this.ui.permissionSubmitting ? ' YOLO … ' : enabled ? ' YOLO ON ' : ' YOLO OFF ';
    const badges = this.goalBadgeLayout(width, { reserved: cellWidth(yoloLabel) + 1, surface, showEmpty: true });
    const goalPart = badges.line;
    const help = '? help  ·  / commands';
    const goalWidth = cellWidth(goalPart);
    const middle = goalWidth + cellWidth(help) + cellWidth(yoloLabel) + 5 <= width ? '  ' + color(help, palette.muted) : '';
    const yoloLeft = width - cellWidth(yoloLabel) + 1;
    const goalRow = lines.length;
    hits.push({ type: this.promptDraft ? 'cancel' : 'yolo', back: Boolean(this.promptDraft), row: goalRow, left: yoloLeft, right: width });
    if (middle) {
      const helpStart = goalWidth + 2;
      hits.push({ type: 'model-control', command: '/help', row: goalRow,
        left: helpStart + 1, right: Math.min(yoloLeft - 2, helpStart + 6) });
      const commandsOffset = helpStart + help.indexOf('/ commands');
      hits.push({ type: 'commands', row: goalRow, left: commandsOffset + 1,
        right: Math.min(yoloLeft - 2, commandsOffset + 10) });
    }
    lines.push(align(goalPart + middle, fillSurface(yoloLabel, cellWidth(yoloLabel), this.theme,
      enabled ? palette.yolo : palette.surface, enabled ? palette.background : palette.muted, true, surface)));
    lines.push(...badges.extra);

    const hint = this.copyMode ? '  COPY MODE · live updates held · Esc returns'
      : '  ? for shortcuts  ·  / commands  ·  PgUp/PgDn to scroll';
    const connection = connectionStatusLabel(this.ui.connectionStatus, this.theme, true);
    const hintLine = cellWidth(hint) + cellWidth(connection) + 1 <= width
      ? align(color(hint, palette.muted), connection)
      : color(clip(hint, Math.max(1, width - cellWidth(connection) - 1)), palette.muted)
        + ' '.repeat(Math.max(1, width - Math.min(width - 1, cellWidth(hint)) - cellWidth(connection))) + connection;
    lines.push(fitStyled(hintLine));
    return { lines, hits, inputIndex, textLeft: prefixWidth + 1, offset, backgroundTop: composerTop, backgroundBottom: lines.length - 1 };
  }
  delegateHeader(width) {
    if (this.mode !== 'delegate') return [];
    const color = this.theme.color, available = Math.max(1, width - 2);
    const roles = [
      { label: 'BRAIN', model: this.model === 'Provider default' ? 'Default model' : this.model, effort: this.effort, tone: palette.accent },
      { label: 'HANDS', model: this.executor ? this.executor.model || 'Default model' : 'Not set', effort: this.executor?.effort, tone: palette.user },
    ].map(role => ({ ...role, model: clean(role.model), effort: clean(role.effort || 'default').replace(/^effort /, '') }));
    const render = (role, budget) => {
      const label = role.label + '  ', effort = ' · ' + role.effort;
      return color(label, role.tone, true) + color(clip(role.model, Math.max(1, budget - cellWidth(label + effort))), palette.text, true) + color(effort, palette.muted);
    };
    const sizes = roles.map(role => cellWidth(role.label + '  ' + role.model + ' · ' + role.effort));
    if (sizes[0] + sizes[1] + 5 <= available) return ['  ' + roles.map((role, index) => render(role, sizes[index])).join(color('  │  ', palette.border))];
    return roles.map(role => '  ' + render(role, available));
  }
  persistentHeader(width, height, { compact = false, controls = '' } = {}) {
    const { color } = this.theme, muted = text => color(text, palette.muted), accent = text => color(text, palette.accent, true);
    const rows = compact ? 2 : height >= 36 ? 8 : height >= 30 ? 7 : height >= 24 ? 5 : 2;
    const eyeRows = this.ui.pet === false ? 0 : rows;
    const eyeWidth = compact ? 10 : Math.max(10, Math.min(42, Math.round(rows * 5.4), Math.floor(width * 0.42)));
    const left = compact ? 2 : 3, gap = compact ? 2 : 6;
    const textWidth = Math.max(1, width - left - (eyeRows ? eyeWidth + gap : 0));
    const effort = (this.effort || 'default').replace(/^effort /, '').replace(/^provider default$/, 'default');
    const provider = this.provider || 'agent';
    const modelWidth = Math.max(1, textWidth - 9 - cellWidth(provider) - cellWidth('effort ' + effort) - 6);
    let brand = accent('bzzy') + muted('  /  ') + color(provider + ' · ' + clip(this.model, modelWidth), palette.text, true) + muted(' · ') + color('effort ' + effort, palette.accent, true);
    const context = this.mode === 'delegate' ? 'Delegate · plan, execute, review'
      : this.mode === 'besties' || this.bestiesGroupId ? 'Besties · shared evidence, messages and peer reviews' : 'Type / for commands';
    const directory = this.cwd || 'Your project, your agent.';
    const shownAlias = this.aliasEdit ? [...this.aliasEdit.value].slice(0, this.aliasEdit.cursor).join('') + '▏' + [...this.aliasEdit.value].slice(this.aliasEdit.cursor).join('') : this.alias;
    let text = [brand, muted(clip(shownAlias ? `${shownAlias} · ${directory}` : directory, textWidth)),
      ...(this.mode === 'delegate' && !compact ? [
        ...(this.aliasEdit ? [muted(clip('Enter save name · Esc cancel', textWidth))] : []), ...this.delegateHeader(textWidth),
      ] : [muted(clip(this.aliasEdit ? 'Enter save name · Esc cancel' : context, textWidth))])];
    if (compact) {
      const controlWidth = cellWidth(controls), modelSpace = Math.max(1, textWidth - controlWidth - 2);
      brand = color(clip(`bzzy / ${provider} · ${this.model}`, modelSpace), palette.accent, true);
      this.compactControlLeft = left + (eyeRows ? eyeWidth + gap : 0) + cellWidth(brand) + 3;
      const connection = connectionStatusLabel(this.ui.connectionStatus, this.theme, true);
      text = [brand + (controls ? muted('  ' + controls) : ''), connection + muted(clip(' · ' + this.tokenLabel() + ' · ' + hostMetricsLabel(this.ui.hostMetrics, Math.min(64, textWidth)), Math.max(1, textWidth - cellWidth(connection))))];
    }
    const header = compact ? [] : [connectionStatusLabel(this.ui.connectionStatus, this.theme)];
    this.eyeRegion = null;
    if (!compact && height >= 30) header.push('');
    if (eyeRows) {
      const cells = mascotCells(this.animationTime, { columns: eyeWidth, rows: eyeRows, compact: true });
      const textStart = Math.max(0, Math.floor((eyeRows - text.length) / 2)), suffixes = [];
      this.eyeRegion = { top: header.length + 1, left: left + 1, columns: eyeWidth, rows: eyeRows, suffixes };
      this.eyeCells = cells;
      for (let row = 0; row < eyeRows; row++) {
        suffixes.push(' '.repeat(gap) + (text[row - textStart] || ''));
        header.push(' '.repeat(left) + mascotLine(cells[row], this.theme) + suffixes[row]);
      }
      if (this.mode === 'delegate' && !compact) for (const line of text.slice(eyeRows)) header.push(' '.repeat(left + eyeWidth + gap) + line);
    } else header.push(...(this.mode === 'delegate' && !compact ? text : text.slice(0, 2)).map(line => ' '.repeat(left) + line));
    if (!compact && this.alias) {
      const column = left + (eyeRows ? eyeWidth + gap : 0) + 1;
      this.hitTargets.push({ type: 'alias', row: eyeRows ? this.eyeRegion.top + Math.max(0, Math.floor((eyeRows - text.length) / 2)) + 1 : 2,
        left: column, right: Math.min(width, column + cellWidth(this.alias) - 1) });
    }
    if (!compact) { const row = header.length + 1; header.push(...this.modelHeader(width)); for (const hit of this.hitTargets) if (hit.type === 'model-control' && hit.row === 0) hit.row = row; }
    if (compact) return header.map(line => cellWidth(line) > width ? color(clip(line, width), palette.text) : line);
    if (height > 24) header.push('');
    if (this.ui.accountStatusEnabled) for (const line of wrap(accountStatusLabels(this.ui.accountStatus).map(item => `${item.label}: ${item.value}`).join('  ·  '), width - 4)) header.push(color('  ' + line, palette.accent));
    if (this.ui.hostMetricsEnabled) header.push(muted('  ' + clip(hostMetricsLabel(this.ui.hostMetrics, width - 4), width - 4)));
    header.push(color('  ' + clip(this.counters(), width - 3), ['needs your input', 'failed'].includes(this.state) ? palette.warning : palette.accent));
    if (this.ui.tabs?.length > 1) {
      let column = 1;
      header.push(this.ui.tabs.map((tab, index) => {
        const label = tab.id === this.ui.activeTab ? ` [${index} ${agentLabel(tab.agent)}] ` : ` ${index} ${agentLabel(tab.agent)} `;
        this.hitTargets.push({ type: 'tab', id: tab.id, row: header.length + 1, left: column, right: column + cellWidth(label) - 1 }); column += cellWidth(label);
        return (tab.id === this.ui.activeTab ? accent : muted)(label);
      }).join(''));
    }
    let column = 1;
    header.push(this.panels().map(panel => {
      const label = `  ${panel === 'room' ? 'SHARED ROOM' : panel.toUpperCase()}`;
      this.hitTargets.push({ type: 'panel', panel, row: header.length + 1, left: column, right: column + cellWidth(label) - 1 }); column += cellWidth(label);
      return (this.panel === panel ? accent : muted)(label);
    }).join(''));
    header.push(color('─'.repeat(width), palette.border));
    return header.map(line => cellWidth(line) > width ? color(clip(line, width), palette.text) : line);
  }
  renderSettings(width, height) {
    const { color } = this.theme, settings = this.ui.settings;
    const title = settings.pageTitle || 'Settings', subtitle = settings.pageSubtitle || '';
    const compactTop = !this.ui.minimal;
    const header = compactTop ? [this.settingsTopBar(width)] : this.persistentHeader(width, height);
    if (compactTop) this.eyeRegion = null;
    const backRow = header.length + 1;
    header.push(color('  ← Back', settings.busy ? palette.muted : palette.accent, true)
      + (compactTop && subtitle ? color(clip('  ' + subtitle, Math.max(0, width - 8)), palette.muted) : ''));
    this.hitTargets.push({ type: 'back', row: backRow, left: 3, right: 9 });
    if (!compactTop) {
      header.push(color(clip('  ' + title, width), palette.text, true)
        + (height <= 24 && subtitle ? color(clip(' · ' + subtitle, width - cellWidth(title) - 2), palette.muted) : ''));
      if (height > 24 && subtitle) header.push(color(clip('  ' + subtitle, width), palette.muted));
    }
    if (settings.page === 'default-models' && compactTop) {
      const usage = this.tokenLabel() + ' · ' + this.elapsedClock();
      const context = `  bzzy · ${this.model} · ${(this.effort || 'default').replace(/^effort /, '')} effort`;
      if (width < 60) { header.push(color(clip(context, width), palette.text)); header.push(color(clip('  ' + usage, width), palette.muted)); }
      else {
        const left = clip(context, Math.max(1, width - cellWidth(usage) - 2));
        header.push(color(left, palette.text) + ' '.repeat(Math.max(1, width - cellWidth(left) - cellWidth(usage))) + color(usage, palette.muted));
      }
    }
    this.sceneHeaderLength = header.length;
    const compact = height - header.length < 16;
    if (!compact) header.push('');
    const footer = compact ? [] : [''];
    if (settings.busy) footer.push(color('  Working…', palette.muted));
    if (settings.message) for (const line of wrap(settings.message, width - 4, 3)) footer.push(color('  ' + line, settings.warning ? palette.warning : palette.accent));
    const exit = settings.page !== 'main' ? 'back' : this.ui.settingsOnly ? 'close' : 'chat';
    if (!compact) footer.push('');
    const exitRow = footer.length;
    const navigationHint = settings.page === 'default-models' ? '↑/↓ rows · ←/→ cells · Enter edit' : '↑/↓ choose · Enter open';
    const backLabel = '  ← ' + (exit === 'back' ? 'Back' : exit === 'close' ? 'Close' : 'Back to chat'), escapeHint = 'Esc ' + (this.ui.settingsOnly ? 'exit' : 'chat');
    if (settings.page === 'default-models' && width < 72) {
      footer.push(color(clip(backLabel + '    ' + escapeHint, width), palette.muted));
      footer.push(color(clip('  ' + navigationHint, width), palette.muted));
    } else footer.push(color(clip(backLabel + '    ' + navigationHint + ' · ' + escapeHint, width), palette.muted));
    if (!compact) footer.push('');
    const bodyHeight = Math.max(1, height - header.length - footer.length);
    const body = this.content(width - 2), focus = this.settingsFocusRow || 0;
    // Start at the top; follow keyboard focus only when the page needs scrolling.
    this.settingsMaximum = Math.max(0, body.length - bodyHeight);
    this.settingsOffset = Math.min(this.settingsOffset || 0, this.settingsMaximum);
    if (this.settingsEnsureFocus) {
      if (focus < this.settingsOffset) this.settingsOffset = focus;
      else if (focus >= this.settingsOffset + bodyHeight) this.settingsOffset = focus - bodyHeight + 1;
      this.settingsEnsureFocus = false;
    }
    const visible = body.slice(this.settingsOffset, this.settingsOffset + bodyHeight);
    while (visible.length < bodyHeight) visible.push('');
    this.hitTargets.push(...this.contentHits.filter(hit => hit.row >= this.settingsOffset && hit.row < this.settingsOffset + bodyHeight)
      .map(hit => ({ ...hit, row: header.length + hit.row - this.settingsOffset + 1 })));
    this.hitTargets.push({ type: 'settings-back', row: header.length + bodyHeight + exitRow + 1, left: 3, right: exit === 'chat' ? 16 : 10 });
    const lines = [...header, ...visible, ...footer];
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) {
      const line = lines[row] || '';
      const background = compactTop && row === 0 ? palette.surface : palette.background;
      frame += `\x1b[${row + 1};1H${this.theme.background(background)}${this.theme.foreground(palette.text)}\x1b[2K${line}\x1b[0m`;
    }
    this.textRegion = null; this.scrollbar = null;
    this.lastFrame = lines.slice(0, height); this.lastBackgrounds = []; this.writeFrame(frame);
  }
  renderSettingsQR(width, height) {
    const { color } = this.theme, settings = this.ui.settings, qr = settings.qrLines();
    const qrWidth = Math.max(0, ...qr.map(line => cellWidth(line))) + 8;
    const notice = settings.warning || /copied|opened|copy request/i.test(settings.message);
    const controls = notice ? settings.message : 'C Copy code  O Open image  Esc back';
    let header = this.persistentHeader(width, height), compact = false;
    const fullFits = qr.length && qrWidth <= width && header.length + qr.length + 6 <= height;
    if (!fullFits && qr.length && qrWidth <= width && qr.length + 6 <= height) {
      // Two persistent brand rows plus the complete QR and its four-module
      // white quiet zone fit 80×24. Controls share the compact header.
      this.hitTargets = [];
      header = this.persistentHeader(width, height, { compact: true, controls });
      compact = true;
    }
    const lines = [...header];
    if (fullFits || compact) {
      if (!compact) lines.push(color(clip('  Scan with BZZY on iPhone', width), palette.accent, true));
      const indent = ' '.repeat(Math.max(0, Math.floor((width - qrWidth) / 2)));
      const blank = indent + '\x1b[47m' + ' '.repeat(qrWidth) + '\x1b[0m';
      lines.push(blank, blank);
      for (const line of qr) lines.push(indent + '\x1b[47m    ' + line + '\x1b[47m    \x1b[0m');
      lines.push(blank, blank);
      if (!compact) {
        while (lines.length < height - 1) lines.push('');
        lines.push(color(clip('  ' + controls, width), notice && settings.warning ? palette.warning : palette.muted));
      }
      const actionRow = compact ? 1 : height;
      const copyLeft = compact ? this.compactControlLeft : 3;
      const openLeft = compact ? this.compactControlLeft + cellWidth('C Copy code  ') : 16;
      this.hitTargets.push({ type: 'settings', action: 'copy-code', row: actionRow, left: copyLeft, right: Math.min(width, copyLeft + 10) },
        { type: 'settings', action: 'open-qr', row: actionRow, left: openLeft, right: Math.min(width, openLeft + 11) });
      lines[actionRow - 1] = replaceCells(lines[actionRow - 1], width - 10, color(' ← Back ', palette.accent), width, this.theme, palette.background);
      this.hitTargets.push({ type: 'qr-back', row: actionRow, left: width - 9, right: width - 3 });
    } else {
      this.hitTargets.push({ type: 'qr-back', row: lines.length + 1, left: 3, right: 9 });
      lines.push(color(clip('  ← Back  Pair iPhone', width), palette.accent, true), '');
      for (const line of wrap('Open the QR image to scan with your iPhone, or use the code.', width - 4)) lines.push(color('  ' + line, palette.muted));
      const actionRow = lines.length + 1;
      lines.push(color(clip('  [ Open QR image ]   [ Copy code ]', width), palette.accent, true), '');
      for (const line of wrap(settings.invitationCode() || '', width - 4)) lines.push(color('  ' + line, palette.text, true));
      if (notice) for (const line of wrap(settings.message, width - 4, 2)) lines.push(color('  ' + line, settings.warning ? palette.warning : palette.accent));
      lines.push(color(clip('  O Open QR image   C Copy code   Esc back', width), palette.muted));
      this.hitTargets.push({ type: 'settings', action: 'open-qr', row: actionRow, left: 3, right: Math.min(width, 19) },
        { type: 'settings', action: 'copy-code', row: actionRow, left: 22, right: Math.min(width, 34) });
    }
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}${this.theme.foreground(palette.text)}\x1b[2K${lines[row] || ''}\x1b[0m`;
    this.textRegion = null; this.scrollbar = null; this.privateFrame = true;
    this.lastFrame = []; this.lastBackgrounds = []; this.writeFrame(frame);
  }
  renderPrivateView(width, height) {
    const view = this.ui.privateView, { color } = this.theme;
    const lines = this.persistentHeader(width, height);
    lines.push(color(clip('  ' + clean(view.title), width), palette.accent, true), '');
    const content = (view.lines || []).flatMap(line => wrap(clean(line), Math.max(1, width - 4)).map(item => '  ' + item));
    const reserved = 5;
    lines.push(...content.slice(0, Math.max(0, height - reserved - lines.length)));
    const qr = view.qr || [], qrWidth = Math.max(0, ...qr.map(line => cellWidth(line))) + 8;
    if (qr.length && qrWidth <= width && lines.length + qr.length + reserved + 4 <= height) {
      const blank = '\x1b[47m' + ' '.repeat(qrWidth) + '\x1b[0m';
      lines.push(blank, blank, ...qr.map(line => '\x1b[47m    ' + line + '\x1b[47m    \x1b[0m'), blank, blank);
    } else if (qr.length && lines.length < height - reserved) {
      lines.push(color(clip(`  Resize for QR (${qrWidth} columns); the same code is shown above.`, width), palette.warning));
    }
    if (view.notice && lines.length < height - 4) lines.push(color(clip('  ' + clean(view.notice), width), palette.warning));
    while (lines.length < height - 3) lines.push('');
    const cancelRow = lines.length + 1, cancelLeft = width - 10;
    lines.push(replaceCells(color(clip('  ' + clean(this.resolveInput ? this.question : 'Waiting for encrypted transfer'), width - 12), palette.muted), cancelLeft, color(' ← Back ', palette.accent, true), width, this.theme, palette.background));
    const value = this.hidden ? '•'.repeat([...this.value].length) : clean(this.value);
    lines.push(color(clip('  › ' + value, width), palette.text), '');
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}${this.theme.foreground(palette.text)}\x1b[2K${lines[row] || ''}\x1b[0m`;
    // Private codes/QRs never enter chat entries, copy regions or frame caches.
    this.hitTargets = [{ type: 'private-cancel', row: cancelRow, left: cancelLeft + 1, right: cancelLeft + 8 }]; this.textRegion = null; this.scrollbar = null; this.privateFrame = true; this.lastFrame = []; this.lastBackgrounds = [];
    if (this.resolveInput) frame += `\x1b[${height - 1};${Math.min(width, 5 + cellWidth(value))}H\x1b[?25h`;
    this.writeFrame(frame);
  }
  render({ force = false } = {}) {
    if (this.closed || this.outputBlocked || this.copyMode && !force) return;
    if (this.textSelection && !this.selection) { this.renderTextSelection(); return; }
    if (this.panel === 'metrics') {
      this.ui.sessionMetrics ||= new SessionMetricsPanel(this.ui, { load: this.ui.sessionMetricsLoader });
      const id = this.ui.activeTab || this.ui.sessionId;
      if (this.ui.sessionMetrics.sessionId !== id) this.metricsTopRequested = true;
      this.ui.sessionMetrics.open(id);
    }
    const picker = this.selection, writer = this.writeFrame;
    this.selection = null; this.renderingPicker = picker;
    this.writeFrame = () => {};
    try { this.renderScene({ force }); }
    finally { this.selection = picker; this.renderingPicker = null; this.writeFrame = writer; }
    if (this.privateFrame) { this.paintedFrame = null; return this.renderScene({ force }); }
    const width = Math.max(16, (this.output.columns || 80) - 1), height = Math.max(8, this.output.rows || 24);
    const lines = (picker?.backgroundFrame || this.lastFrame).slice();
    this.popupRegion = null;
    if (picker) {
      const action = picker.kind === 'effort' ? 'core-effort' : 'core-model', command = picker.kind === 'effort' ? '/effort' : '/providers';
      const presetAction = picker.scope === 'preset-count' ? 'preset-count' : picker.scope?.startsWith('preset:') ? `preset-${picker.kind === 'effort' ? 'effort' : 'model'}:${picker.scope.slice(7)}` : null;
      const defaultModels = picker.scope?.startsWith('defaults:');
      const anchor = picker.anchor || this.hitTargets.find(hit => defaultModels ? hit.type === 'settings' && hit.action === this.settingsFocusedAction
        : presetAction ? hit.type === 'settings' && hit.action === presetAction : picker.scope === 'core' ? hit.type === 'settings' && hit.action === action : hit.type === 'model-control' && hit.command === command);
      const popup = choicePopup(picker, { width, height, anchor, minimumTop: this.sceneHeaderLength, theme: this.theme });
      this.popupRegion = { left: popup.left + 1, right: popup.left + popup.width, top: popup.top + 1, bottom: popup.top + popup.lines.length };
      for (let index = 0; index < popup.lines.length; index++) {
        const row = popup.top + index;
        if (row >= height) break;
        if (row + 1 < height - 1 && popup.left + popup.width < width) lines[row + 1] = replaceCells(lines[row + 1] || '', popup.left + 1, fillSurface('', popup.width, this.theme, '#000000', palette.text), width, this.theme, palette.background);
        lines[row] = replaceCells(lines[row] || '', popup.left, popup.lines[index], width, this.theme, palette.background);
      }
      this.hitTargets = popup.hits.filter(hit => hit.row > 0 && hit.row <= height && hit.left <= hit.right);
      this.scrollbar = null; this.textRegion = null;
    }
    for (const hit of this.hitTargets) {
      const pressed = this.pressedTarget === targetKey(hit) && Date.now() < this.pressedUntil, hovered = this.hoverTarget === targetKey(hit);
      if ((!pressed && !hovered) || hit.row < 1 || hit.row > height) continue;
      const text = clean(sliceCells(lines[hit.row - 1] || '', hit.left - 1, hit.right));
      lines[hit.row - 1] = replaceCells(lines[hit.row - 1] || '', hit.left - 1, fillSurface(text, hit.right - hit.left + 1, this.theme, pressed ? palette.accent : palette.hover, pressed ? palette.background : palette.text, true), width, this.theme, palette.background);
    }
    if (this.actionNotice && !picker && !this.hidden && !this.promptDraft) {
      const text = ' ' + clip(this.actionNotice.message, Math.min(75, width - 8)) + ' ', size = cellWidth(text);
      const row = Math.max(0, Math.min(height - 2, (this.composerRow || height - 3) - 4));
      lines[row] = replaceCells(lines[row] || '', Math.max(0, width - size - 2), fillSurface(text, size, this.theme, palette.selection, this.actionNotice.warning ? palette.warning : palette.accent), width, this.theme, palette.background);
    }
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) {
      const line = lines[row] || '';
      if (this.paintedFrame?.[row] !== line || force) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}${this.theme.foreground(palette.text)}\x1b[2K${line}\x1b[0m`;
    }
    this.lastFrame = lines; this.paintedFrame = lines.slice();
    if (this.canCompose() && !this.aliasEdit) {
      const before = this.hidden ? '•'.repeat(this.cursor) : [...this.value].slice(0, this.cursor).join('').replaceAll('\n', ' ↵ ');
      frame += `\x1b[${Math.min(height, this.composerRow)};${Math.max(1, Math.min(width - 1, (this.composerLeft || 0) + (this.composerTextLeft || 3) + cellWidth(before) - (this.composerOffset || 0)))}H\x1b[?25h`;
    }
    this.writeFrame(frame);
  }
  renderScene({ force = false } = {}) {
    if (this.closed || this.outputBlocked || this.copyMode && !force) return;
    this.composerLeft = 0;
    this.privateFrame = false; this.hitTargets = [];
    if (this.ui.privateView) {
      this.renderPrivateView(Math.max(16, (this.output.columns || 80) - 1), Math.max(8, this.output.rows || 24));
      return;
    }
    if (this.textSelection) { this.renderTextSelection(); return; }
    const width = Math.max(16, (this.output.columns || 80) - 1), height = Math.max(8, this.output.rows || 24);
    if (this.panel === 'settings' && !this.promptDraft && !this.selection) {
      if (this.ui.settings?.qrView) this.renderSettingsQR(width, height);
      else this.renderSettings(width, height);
      return;
    }
    const { color } = this.theme;
    const muted = text => color(text, palette.muted), edge = text => color(text, palette.border), accent = text => color(text, palette.accent, true);
    this.hitTargets = [];
    const selected = this.ui.tabs?.find(tab => tab.id === this.ui.activeTab);
    const completions = this.completions();
    const maximumPinned = height < 22 ? 1 : 2;
    const pinned = this.pinned && !['settings', 'metrics'].includes(this.panel) ? wrap(this.pinned, width - 5, maximumPinned + 1) : [];
    const sessionLabel = this.ui.sessionId ? `Session: ${this.ui.sessionId} · ${this.ui.sessionMode}` : 'Setup · no work started';
    const simpleChat = this.simpleChatLayout();
    if (this.ui.minimal) this.eyeRegion = null;
    if (simpleChat) this.eyeRegion = null;
    const header = this.ui.minimal ? [connectionStatusLabel(this.ui.connectionStatus, this.theme), ...this.delegateHeader(width)]
      : simpleChat ? [this.simpleTopBar(width)] : this.persistentHeader(width, height);
    if (this.panel !== 'chat' && this.panel !== 'settings' && !this.promptDraft) {
      this.hitTargets.push({ type: 'back', row: header.length + 1, left: 3, right: 9 });
      header.push(color('  ← Back', palette.accent, true) + color(clip('  ' + this.panel[0].toUpperCase() + this.panel.slice(1), Math.max(0, width - 8)), palette.muted));
    }
    if (pinned.length && !this.ui.minimal) {
      if (simpleChat) {
        for (const [index, line] of pinned.slice(0, maximumPinned).entries()) {
          const text = line + (index === maximumPinned - 1 && pinned.length > maximumPinned ? ' …' : '');
          header.push((index ? color('       │ ', palette.border) : color('  YOU  │ ', palette.user, true))
            + color(clip(text, width - 9), palette.text));
        }
      } else {
        header.push(color('  YOU ASKED', palette.user, true));
        for (const [index, line] of pinned.slice(0, maximumPinned).entries()) header.push(color('  │ ' + clip(line + (index === maximumPinned - 1 && pinned.length > maximumPinned ? ' …' : ''), width - 5), palette.accent));
        header.push(edge('─'.repeat(width)));
      }
    }
    if (simpleChat && this.mode === 'delegate') {
      header.push(...this.delegateHeader(width));
      const phase = this.busy ? this.delegationPhase || 'Supervisor planning'
        : this.goal?.status === 'complete' ? 'Goal complete' : 'Delegation';
      const status = phase + ' · ' + delegationCounters(this.delegationUsage);
      header.push(color(clip('  ' + status, width), palette.accent));
    }
    this.sceneHeaderLength = header.length;
    let bottom = [], bottomHits = [], inputIndex = 0, composerTextLeft = 3, composerOffset = 0;
    let composerBackgroundTop = 0, composerBackgroundBottom = 0;
    if (simpleChat) {
      const composer = this.codexBottom(width, height, completions);
      bottom = composer.lines;
      bottomHits = composer.hits;
      inputIndex = composer.inputIndex;
      composerTextLeft = composer.textLeft;
      composerOffset = composer.offset;
      composerBackgroundTop = composer.backgroundTop;
      composerBackgroundBottom = composer.backgroundBottom;
    } else {
      bottom = this.ui.minimal ? [] : [edge('─'.repeat(width))];
      if (this.mode === 'delegate' && !this.ui.minimal) {
        const phase = this.busy ? this.delegationPhase || 'Supervisor planning' : this.goal?.status === 'complete' ? 'Goal complete' : 'Delegation';
        const counters = delegationCounters(this.delegationUsage), text = phase + ' · ' + counters;
        if (cellWidth(text) > width - 3) bottom.push(color('  ' + phase, palette.accent), color('  ' + clip(counters, width - 3), palette.accent));
        else bottom.push(color('  ' + text, palette.accent));
      }
      if (this.panel === 'chat' && !this.promptDraft || this.panel === 'room' && !this.promptDraft) {
        const enabled = this.ui.yoloEnabled?.() || false, label = this.ui.permissionSubmitting ? ' YOLO … ' : enabled ? ' YOLO ON ' : ' YOLO OFF ';
        const left = width - cellWidth(label) - 1, badges = this.goalBadgeLayout(width, { reserved: this.ui.minimal ? 0 : cellWidth(label) + 1 });
        let line = badges.line || '  ';
        line += ' '.repeat(Math.max(0, left - cellWidth(line)));
        line += fillSurface(label, cellWidth(label), this.theme, enabled ? palette.yolo : palette.surface, enabled ? palette.background : palette.muted, true);
        if (!this.ui.minimal) { bottomHits.push({ type: 'yolo', row: bottom.length, left: left + 1, right: left + cellWidth(label) }); bottom.push(line); }
        else if (badges.line) bottom.push(badges.line);
        bottom.push(...badges.extra);
        if (this.pendingApproval && (!this.pendingApproval.expiresAt || this.pendingApproval.expiresAt > Date.now())) {
          const disabled = this.ui.sessionMode === 'VIEW' || !this.ui.onAnswerApproval || this.approvalSubmitting;
          let approvalLine = '  '; let column = 3;
          for (const [text, answer, tone] of [[' ✔ Approve once ', 'yes', palette.goalSuccess], [' ✕ Deny ', 'no', palette.danger]]) {
            approvalLine += fillSurface(text, cellWidth(text), this.theme, disabled ? palette.surface : tone, disabled ? palette.muted : palette.background, true) + ' ';
            if (!disabled) bottomHits.push({ type: 'approval', answer, row: bottom.length, left: column, right: column + cellWidth(text) - 1 }); column += cellWidth(text) + 1;
          }
          bottom.push(approvalLine);
        }
      }
      if (!this.ui.minimal && this.busy && (this.currentTool || this.currentActivity)) bottom.push(muted('  ' + clip(this.currentTool || this.currentActivity, width - 3)));
      if (this.panel === 'chat' && !this.promptDraft) {
        const name = workflowChatLabel(this.ui);
        if (name !== 'None' && name !== 'Unavailable') {
          const label = clip(`  Workflow: ${name} · future goals`, width);
          bottomHits.push({ type: 'workflow-open', row: bottom.length, left: 3, right: cellWidth(label) });
          bottom.push(color(label, /unavailable/i.test(name) ? palette.warning : palette.muted));
        }
      }
      if (completions.length) {
        const maximum = height < 28 ? 3 : 6, offset = Math.max(0, Math.min(this.completionFocus - Math.floor(maximum / 2), completions.length - maximum));
        bottom.push(muted('  Commands · ↑/↓ choose · Tab complete · Esc close'));
        for (let index = offset; index < Math.min(completions.length, offset + maximum); index++) {
          const item = completions[index];
          bottomHits.push({ type: 'command', choice: item, row: bottom.length, left: 3, right: width - 1 });
          bottom.push(color(`  ${index === this.completionFocus ? '›' : ' '} ${item.command.padEnd(18)}${clip(item.description, width - 25)}`, index === this.completionFocus ? palette.accent : palette.muted, index === this.completionFocus));
        }
      }
      const workflowOnly = this.panel === 'workflows' && !this.promptDraft;
      const prompt = workflowOnly ? 'Workflows' : this.panel === 'settings' && !this.promptDraft ? 'Settings' : !this.resolveInput || /^(bzzy\b)/.test(this.question || '') ? 'Message' : clip(this.question || 'Message', width - 6);
      bottom.push(edge('╭─ ') + color(prompt, palette.text, true) + edge(' ' + '─'.repeat(Math.max(0, width - cellWidth(prompt) - 5)) + '╮'));
      if (this.promptDraft) {
        const left = width - 11;
        bottom[bottom.length - 1] = replaceCells(bottom.at(-1), left, color(' ← Back ', palette.accent, true), width, this.theme, palette.background);
        bottomHits.push({ type: 'cancel', back: true, row: bottom.length - 1, left: left + 1, right: left + 8 });
      }
      const visibleValue = workflowOnly ? '' : this.hidden ? '•'.repeat([...this.value].length) : this.value.replaceAll('\n', ' ↵ ');
      const before = workflowOnly ? '' : this.hidden ? '•'.repeat(this.cursor) : [...this.value].slice(0, this.cursor).join('').replaceAll('\n', ' ↵ ');
      const hasSubmit = !workflowOnly && Boolean(this.resolveInput || this.ui.sessionId) && this.ui.sessionMode !== 'VIEW';
      const sendLabel = this.promptDraft ? ' Confirm ' : ' Send ↵ ';
      const inputWidth = Math.max(1, width - 5 - (hasSubmit ? cellWidth(sendLabel) + 1 : 0));
      const cropped = cropLeft(visibleValue, Math.max(0, cellWidth(before) - inputWidth + 1));
      const inputText = visibleValue ? clip(cropped, inputWidth, '') : clip(workflowOnly ? '↑/↓ choose · Enter opens · Esc goes back' : this.panel === 'settings' && !this.promptDraft ? `↑/↓ choose · Enter opens · Esc ${this.ui.settingsOnly ? 'closes Settings' : 'returns to chat'}` : this.ui.sessionMode === 'VIEW' ? 'Read-only · /tabs or /detach' : this.mode === 'delegate' && !this.goal ? 'Chat, or /goal <objective> for supervised work' : 'Ask something, or /goal an objective', inputWidth);
      const inputLine = color(inputText, visibleValue ? palette.text : palette.muted) + ' '.repeat(Math.max(0, inputWidth - cellWidth(inputText)));
      bottom.push(edge('│ ') + inputLine + (hasSubmit ? ' ' + fillSurface(sendLabel, cellWidth(sendLabel), this.theme, this.value && !this.renderingPicker ? palette.accent : palette.selection, this.value && !this.renderingPicker ? palette.background : palette.accent, true) : '') + '  ' + edge('│'));
      inputIndex = bottom.length - 1;
      if (hasSubmit) bottomHits.push({ type: 'confirm', row: inputIndex, left: inputWidth + 4, right: inputWidth + 3 + cellWidth(sendLabel) });
      bottom.push(edge('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯'));
      if (!this.ui.minimal && !this.promptDraft && height >= 28) {
        const controls = [[' Paste ', 'paste'], [' ↓ Latest ', 'latest'], [this.showTools ? ' Hide tools ' : ' Show tools ', 'tools'], ...(this.busy ? [[' Pause ', 'model-control', '/pause']] : [])];
        let left = 3, line = '  ';
        for (const [label, type, command] of controls) {
          if (left + cellWidth(label) > width) break;
          bottomHits.push({ type, command, row: bottom.length, left, right: left + cellWidth(label) - 1 });
          line += color(label, palette.muted) + ' '; left += cellWidth(label) + 1;
        }
        bottom.push(line);
      }
      if (!this.ui.minimal) {
        for (const line of wrap(sessionLabel, width - 2)) bottom.push(muted(' ' + line));
        if (selected && selected.id !== this.ui.sessionId) for (const line of wrap(`Chat: ${selected.id}`, width - 2)) bottom.push(muted(' ' + line));
      }
      composerOffset = Math.max(0, cellWidth(before) - inputWidth + 1);
      composerBackgroundTop = Math.max(0, inputIndex - 1);
      composerBackgroundBottom = bottom.length - 1;
    }
    // Keep the host header in place; constrained terminals spend their
    // remaining rows on the current screen and composer.
    const overflow = Math.max(0, header.length + bottom.length - height);
    if (overflow) bottom.splice(Math.max(0, bottom.length - overflow), overflow);
    let bodyHeight = Math.max(0, height - header.length - bottom.length);
    const metricsAtTop = this.panel === 'metrics' && this.scroll >= (this.scrollbar?.maximum || 0);
    this.selectionHeight = bodyHeight;
    const contentWidth = width - 2;
    const roomLabels = this.panel === 'room' ? JSON.stringify([this.peers.map(peer => [peer.sessionId || peer.id, peer.namespace || peer.agent]), this.ui.tabs?.map(tab => [tab.id, tab.agent])]) : '';
    const contentKey = `${['skills', 'agents', 'workflows'].includes(this.panel) ? Date.now() : this.panel === 'metrics' ? this.ui.sessionMetrics?.revision : ''}:${contentWidth}:${this.panel}:${this.showTools}:${this.contentRevision || 0}:${roomLabels}`;
    let body;
    if (!this.selection && this.panel !== 'settings' && this.bodyCache?.key === contentKey) {
      body = this.bodyCache.lines; this.contentHits = this.bodyCache.hits;
    } else { body = this.content(contentWidth); if (!this.selection) this.bodyCache = { key: contentKey, lines: body, hits: this.contentHits }; }
    const opening = this.panel === 'chat' && !this.selection && !this.entries.some(entry => !entry.welcome && entry.kind !== 'tool');
    if (!body.length || opening) {
      const welcome = this.mode === 'delegate' ? ['', accent('  What should the team work on?'), color('  Chat normally, or use /goal to start supervised delegated work.', palette.text), muted('  The brain plans; hands execute; evidence is reviewed.'), muted('  Type / for commands.')]
        : ['', accent('  What should BZZY work on?'), color('  Ask a question, build something, or investigate a task.', palette.text), muted('  /goal <objective>   Persist until the outcome is verified'), muted('  Type / for commands, models and sessions.')];
      const mode = this.entries.findLast(entry => /^(Parallel|Debate|Validate) mode/.test(entry.text));
      if (mode) welcome.push('', ...wrap(mode.text.replace(/^Debate mode/, 'Validate mode'), width - 5).map(line => muted('  ' + line)));
      body = this.panel === 'metrics' ? [] : this.panel === 'chat' ? welcome : this.panel === 'room' ? [accent('  Shared room · waiting for peer messages'), ...wrap('The two besties exchange findings, evidence and reviews here. Their separate chats stay available above. Use /goal <objective> to begin collaboration.', width - 5).map(line => muted('  ' + line))]
        : this.panel === 'http' ? [muted('  No HTTP records yet.'), ...wrap('WebFetch and browser visits appear automatically as backend-reported activity. For measured shell HTTP traffic, start bzzy with --capture-network. The http_request tool always records observed requests.', width - 5).map(line => muted('  ' + line))] : [muted('  No ' + this.panel + ' records yet.')];
    }
    if (this.panel === 'settings' && !this.selection && this.settingsEnsureFocus) {
      const start = Math.max(0, body.length - this.scroll - bodyHeight), focus = this.settingsFocusRow || 0;
      if (focus < start) this.scroll = Math.max(0, body.length - bodyHeight - focus);
      else if (focus >= start + bodyHeight) this.scroll = Math.max(0, body.length - focus - 1);
      this.settingsEnsureFocus = false;
    }
    if (this.panel === 'skills' && !this.selection) {
      if (this.skillTopRequested) { this.scroll = Math.max(0, body.length - bodyHeight); this.skillTopRequested = false; }
      if (this.skillEnsureFocus) {
        const start = Math.max(0, body.length - this.scroll - bodyHeight), focus = this.skillFocusRow || 0;
        if (focus < start) this.scroll = Math.max(0, body.length - bodyHeight - focus);
        else if (focus >= start + bodyHeight) this.scroll = Math.max(0, body.length - focus - 1);
        this.skillEnsureFocus = false;
      }
    }
    if (this.panel === 'agents' && !this.selection) {
      if (this.agentTopRequested) { this.scroll = Math.max(0, body.length - bodyHeight); this.agentTopRequested = false; }
      if (this.agentEnsureFocus) {
        const start = Math.max(0, body.length - this.scroll - bodyHeight), focus = this.agentFocusRow || 0;
        if (focus < start) this.scroll = Math.max(0, body.length - bodyHeight - focus);
        else if (focus >= start + bodyHeight) this.scroll = Math.max(0, body.length - focus - 1);
        this.agentEnsureFocus = false;
      }
    }
    if (this.panel === 'workflows' && !this.selection) {
      if (this.workflowTopRequested) { this.scroll = Math.max(0, body.length - bodyHeight); this.workflowTopRequested = false; }
      if (this.workflowEnsureFocus) {
        const start = Math.max(0, body.length - this.scroll - bodyHeight), focus = this.workflowFocusRow || 0;
        if (focus < start) this.scroll = Math.max(0, body.length - bodyHeight - focus);
        else if (focus >= start + bodyHeight) this.scroll = Math.max(0, body.length - focus - 1);
        this.workflowEnsureFocus = false;
      }
    }
    if (this.panel === 'metrics' && !this.selection && (this.metricsTopRequested || metricsAtTop)) {
      this.scroll = Math.max(0, body.length - bodyHeight); this.metricsTopRequested = false;
    }
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - bodyHeight));
    const end = this.selection ? Math.min(body.length, bodyHeight) : Math.max(0, body.length - this.scroll), start = Math.max(0, end - bodyHeight);
    const visibleBody = body.slice(start, end);
    while (visibleBody.length < bodyHeight) visibleBody.push('');
    const maximum = Math.max(0, body.length - bodyHeight), thumbHeight = Math.min(bodyHeight, Math.max(1, Math.round(bodyHeight * bodyHeight / Math.max(1, body.length))));
    const thumbOffset = maximum ? Math.round((1 - this.scroll / maximum) * (bodyHeight - thumbHeight)) : 0;
    this.scrollbar = !this.selection && bodyHeight ? { column: width, top: header.length + 1, height: bodyHeight, maximum, thumbHeight, thumbTop: header.length + 1 + thumbOffset } : null;
    for (let index = 0; index < visibleBody.length; index++) {
      let line = visibleBody[index];
      if (cellWidth(line) > contentWidth) line = color(clip(line, contentWidth), palette.text);
      visibleBody[index] = line + ' '.repeat(Math.max(0, width - 1 - cellWidth(line))) + (this.selection || !maximum ? ' ' : index >= thumbOffset && index < thumbOffset + thumbHeight ? color('┃', palette.accent) : edge('│'));
    }
    if (['chat', 'room', 'skills', 'agents', 'workflows', 'settings', 'metrics'].includes(this.panel) || this.selection) for (const hit of this.contentHits) if (hit.row >= start && hit.row < end) this.hitTargets.push({ ...hit, row: header.length + hit.row - start + 1 });
    for (const hit of bottomHits) this.hitTargets.push({ ...hit, row: header.length + bodyHeight + hit.row + 1 });
    this.composerRow = header.length + bodyHeight + inputIndex + 1;
    this.composerOffset = composerOffset;
    this.composerTextLeft = composerTextLeft;
    this.textRegion = !this.selection && bodyHeight ? { top: header.length + 1, bottom: header.length + bodyHeight, left: 1, right: width - 1 } : null;
    const lines = [...header, ...visibleBody, ...bottom].slice(0, height);
    const backgrounds = [];
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) {
      let line = lines[row] || '';
      if (cellWidth(line) > width || /[\r\n\u2028\u2029]/.test(clean(line))) line = color(clip(line, width), palette.text);
      const composerTop = header.length + bodyHeight + composerBackgroundTop;
      const composerBottom = header.length + bodyHeight + Math.min(bottom.length - 1, composerBackgroundBottom);
      const background = simpleChat && row === 0 || row >= composerTop && row <= composerBottom
        ? palette.surface : palette.background;
      backgrounds.push(background);
      if (this.lastFrame[row] !== line || this.lastBackgrounds?.[row] !== background) frame += `\x1b[${row + 1};1H${this.theme.background(background)}${this.theme.foreground(palette.text)}\x1b[2K${line}\x1b[0m`;
      lines[row] = line;
    }
    this.lastFrame = lines; this.lastBackgrounds = backgrounds;
    if (this.canCompose()) {
      const before = this.hidden ? '•'.repeat(this.cursor)
        : [...this.value].slice(0, this.cursor).join('').replaceAll('\n', ' ↵ ');
      const row = header.length + bodyHeight + inputIndex + 1;
      const column = Math.min(width - 1, composerTextLeft + cellWidth(before) - composerOffset);
      frame += `\x1b[${Math.min(height, row)};${Math.max(1, column)}H\x1b[?25h`;
    }
    this.writeFrame(frame);
  }
  restore(preserveScreen = false) { if (this.restored) return; this.restored = true; this.input.setRawMode?.(this.wasRaw); this.output.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l' + (preserveScreen ? '' : '\x1b[?1049l')); }
  close({ preserveScreen = false } = {}) {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer); clearTimeout(this.renderTimer); clearTimeout(this.clipboardNoticeTimer); clearTimeout(this.feedbackTimer); clearTimeout(this.noticeTimer); this.keyInput.close();
    this.ui.sessionMetrics?.close();
    this.finish(null); this.finishSelection(null, true); this.input.removeListener('keypress', this.onKey); this.input.removeListener('data', this.onRawData); this.output.removeListener?.('resize', this.onResize); this.output.removeListener?.('drain', this.onDrain); process.removeListener('exit', this.onExit); this.restore(preserveScreen); this.input.pause();
  }
}
function agentLabel(value) {
  const text = clean(value || 'Agent'), bestie = /^(.*?)-bestie-(\d+)(?:-|$)/.exec(text);
  return bestie ? `${bestie[1]} · ${bestie[2]}` : text.split('-').slice(0, 2).join('-');
}
function libraryActionList(rows) {
  return rows.flatMap(row => row.segments
    ? row.segments.filter(segment => segment.action).map(segment => segment.action)
    : row.action ? [row.action] : []);
}
function libraryRowToggle(rows, focused) {
  return rows.find(row => row.toggleAction && (row.action === focused || row.segments?.some(segment => segment.action === focused)))?.toggleAction;
}
function screenPoint(x, y, region) { return { x: Math.max(region.left, Math.min(region.right, x)), y: Math.max(region.top, Math.min(region.bottom, y)) }; }
function screenRange(anchor, focus) { return anchor.y < focus.y || anchor.y === focus.y && anchor.x <= focus.x ? [anchor, focus] : [focus, anchor]; }
const screenGraphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function screenSegments(value, left, right) {
  const parts = { before: '', selected: '', after: '' }; let column = 0;
  for (const { segment } of screenGraphemes.segment(clean(value))) {
    const size = cellWidth(segment), end = column + size;
    parts[end <= left ? 'before' : column < right ? 'selected' : 'after'] += segment; column = end;
  }
  return parts;
}
function delegationCounters(usage) {
  const count = value => Number.isFinite(value) ? value.toLocaleString() : '—';
  const workers = usage?.providers || usage?.agents || [];
  const handsKnown = usage && !workers.some(agent => !agent.available);
  const handsPartial = !handsKnown && workers.some(agent => agent.available || agent.tokens > 0);
  const hands = handsKnown ? count(usage.delegatedTokens) : handsPartial ? '≥' + count(usage.delegatedTokens) : '—';
  const known = usage && (Number.isFinite(usage.supervisorTokens) || workers.some(agent => agent.available || agent.tokens > 0));
  const total = known ? (usage.complete ? '' : '≥') + count(usage.totalTokens) : '—';
  return `brain ${count(usage?.supervisorTokens)} · hands ${hands} · total ${total} tokens`;
}
function cropLeft(text, offset) {
  let used = 0, result = '';
  for (const char of text) { if (used >= offset) result += char; used += cellWidth(char); }
  return result;
}
function wordBoundary(chars, cursor, direction) {
  const next = () => chars[cursor + (direction < 0 ? -1 : 0)];
  while (next() != null && /\s/u.test(next())) cursor += direction;
  const isWord = char => /[\p{L}\p{N}\p{M}_]/u.test(char), word = next() != null && isWord(next());
  while (next() != null && !/\s/u.test(next()) && isWord(next()) === word) cursor += direction;
  return cursor;
}
