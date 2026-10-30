import { canControlSession } from './session-controls.js';
import { skillRows, returnToSkillLibrary } from './skills-ui.js';
import { subagentRows } from './subagents-ui.js';
import { workflowRows, workflowAction, workflowChatLabel } from './workflow-ui.js';
import { goalRows, goalAction } from './saved-goals-ui.js';
import { ExecutionFeedback } from './execution-feedback.js';
import { libraryLayout, libraryActions as libraryActionList } from './library-layout.js';
import { assertLibraryMenu, prepareLibraryRemoval } from './library-entry-menu.js';
import { namedTerminalSessions, confirmSavedSessionOpen } from './session-browser.js';
import { clean, cellWidth, clip, wrap, wrapProse, duration } from './terminal-format.js';
import { commandSuggestions, privateChatCommand } from './terminal-commands.js';
import { referenceToken, referenceCatalog, insertReference } from './reference-completions.js';
import { backendVisit } from './backend-traffic.js';
import { accountStatusLabels } from './account-status.js';
import { hostMetricsLabel } from './host-metrics.js';
import { copyText, readClipboard } from './clipboard.js';
import { palette, createTerminalTheme } from './terminal-theme.js';
import { messageBodyToPlainText, parseMessageBody } from '@bzzy/core/message-format';
import { renderMessageContent } from './message-renderer.js';
import { choicePopup, visibleChoices } from './choice-popup.js';
import { fillSurface, replaceCells, sliceCells } from './terminal-surface.js';
import { settingsLayout, settingsActions, navigateSettings } from './settings-layout.js';
import { goalIndicator, goalValidationIndicator, chatWorkIndicator } from './goal-indicator.js';
import { escapeInputKind, TerminalKeyInput } from './terminal-keys.js';
import { recordDebateEvent, debateEntryLayout } from './debate-ui.js';
import { goalValidationFor } from '@bzzy/core/engine/goal-validation.js';
import { SessionMetricsPanel, sessionMetricsLayout } from './session-metrics-ui.js';
import { returnFromDefinitionBundle, cancelDefinitionBundle } from './definition-bundle-ui.js';
import { recordInvocationEvent, reconcileInvocationEntries, invocationEntryLayout, attributeInvocationActors } from './invocation-ui.js';
import { ToolTreeProjection, toolTreeLayout, changeToolTree } from './tool-tree-ui.js';
import { ActorProjection } from './actor-ui.js';
import { ActivityMonitor, actorColor } from './activity-monitor.js';
import { workspaceGeometry, workspaceChrome } from './workspace-layout.js';
import { workspaceHeader, workspaceNavigation, sectionHeading } from './workspace-header.js';
import { workspaceComposer, workspacePanelFooter } from './workspace-composer.js';
import { responseResources, openTerminalLink } from './response-actions.js';
import { chooseSavedModel } from './model-controls.js';
import { loadSession } from '@bzzy/core/engine/store.js';
import { createTerminalSourceProjection } from '@bzzy/core/engine/terminal-source.js';

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
    this.executionFeedback = new ExecutionFeedback();
    this.toolTrees = new ToolTreeProjection(); this.showTools = true;
    this.actors = new ActorProjection();
    this.monitor = new ActivityMonitor(); this.workspaceOptions = {};
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
      const sourceAnimating = this.monitor?.animating();
      if (!this.copyMode && !this.outputBlocked) {
        if (sourceAnimating || previous !== this.frame && (this.historyRestoreDepth || this.busy || this.selection?.loading || goalIndicator(this.goal, this.frame)?.animated || goalValidationIndicator(this.goal, this.goalValidation, this.frame)?.animated)) this.schedule();
      }
      const interval = sourceAnimating ? 1000 / 30 : this.ui.pet === false ? 100 : animationInterval;
      deadline += interval;
      if (deadline <= instant) deadline = instant + interval;
      this.timer = setTimeout(tick, Math.max(1, deadline - performance.now())); this.timer.unref();
    };
    this.timer = setTimeout(tick, animationInterval); this.timer.unref();
  }
  writeFrame(frame) { if (frame && !this.output.write(frame)) this.outputBlocked = true; }
  privateAction(value) {
    const view = this.ui.privateView;
    if (!view?.actionMode || !this.resolveInput || !view.actions?.some(action => action.value === value && !action.disabled)) return;
    this.finish(value);
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
    this.captureNetwork = session.captureNetwork;
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
    if (this.spending && this.spending.sessionId !== session.id) this.spending = null;
    if (snapshot.spending?.sessionId === session.id) this.spending = snapshot.spending;
    if (Object.hasOwn(snapshot, 'compactorUsage')) this.compactorUsage = snapshot.compactorUsage?.sessionId === session.id ? snapshot.compactorUsage : null;
    else if (this.compactorUsage?.sessionId !== session.id) this.compactorUsage = null;
    this.bestiesGroupId = session.bestiesSessionId || (session.mode === 'besties' ? session.id || this.ui.sessionId : null);
    this.peers = session.peers || [];
    if (!this.bestiesGroupId && !this.sharedRoom.length && this.panel === 'room') this.panel = 'chat';
    if (session.delegationUsage) this.delegationUsage = session.delegationUsage;
    const job = snapshot.execution;
    this.executionGoal = typeof job?.goal === 'boolean' ? job.goal : typeof snapshot.run?.goalMode === 'boolean' ? snapshot.run.goalMode : undefined;
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
    const sessionId = this.ui.activeTab || this.ui.sessionId, actorRevision = this.actors.revision;
    this.actors.snapshot(snapshot, { sessionId });
    if (actorRevision !== this.actors.revision) {
      this.entryLayouts = new WeakMap(); this.bodyCache = null;
      for (const group of this.toolTrees.groups.values()) group.agent = this.actors.for(group.actorSessionId, sessionId).label;
    }
    const invocations = [...reconcileInvocationEntries(this.entries, snapshot, { sessionId }), ...attributeInvocationActors(this.entries, this.actors, { sessionId })];
    if (invocations.length) this.contentRevision = (this.contentRevision || 0) + 1;
    for (const entry of invocations) { this.entryLayouts.delete(entry); this.monitor.invocation(entry); }
    if (!this.pinned && session.goal?.objective) this.pinned = session.goal.objective;
    this.executionFeedback.update(snapshot);
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
    if (data.eventSessionId && data.eventSessionId !== (this.ui.activeTab || this.ui.sessionId)) return;
    this.executionFeedback.event(type, data);
    this.contentRevision = (this.contentRevision || 0) + 1;
    const invocation = recordInvocationEvent(this.entries, type, data, { sessionId: this.ui.activeTab || this.ui.sessionId });
    if (invocation.changed && invocation.entry) { this.entryLayouts.delete(invocation.entry); this.monitor.invocation(invocation.entry, data); }
    const sessionId = this.ui.activeTab || this.ui.sessionId, actorRevision = this.actors.revision;
    this.actors.event(type, data, this.entries, { sessionId });
    if (actorRevision !== this.actors.revision) {
      this.entryLayouts = new WeakMap(); this.bodyCache = null;
      for (const group of this.toolTrees.groups.values()) group.agent = this.actors.for(group.actorSessionId, sessionId).label;
    }
    for (const entry of attributeInvocationActors(this.entries, this.actors, { sessionId })) this.entryLayouts.delete(entry);
    this.monitor.event(type, data, this.actors, sessionId);
    if (!this.historyRestoreDepth && ['backend', 'worker.tool'].includes(type)) {
      try { this.sourceProjection(sessionId).event(type, data); } catch { /* Observation cannot interrupt chat. */ }
    }
    const tools = this.toolTrees.event(this.entries, type, data, { sessionId, actors: this.actors });
    if (tools.group && this.workspace?.right && !tools.group.workspaceCollapsed) { tools.group.expanded = false; tools.group.workspaceCollapsed = true; }
    for (const entry of tools.changed || []) this.entryLayouts.delete(entry);
    if (this.entries.length > 5000) this.entries.splice(0, 500);
    if (type === 'text' || type === 'peer.text') {
      const peerSessionId = type === 'peer.text' ? data.childSessionId || data.sessionId || data.agent : null;
      const actorSessionId = data.childSessionId || data.actorSessionId || (type === 'peer.text' ? data.sessionId : sessionId), actor = this.actors.for(actorSessionId, sessionId);
      const label = actor.role === 'main' ? 'bzzy' : actor.name;
      // Peer chunks can interleave. Stable response IDs keep one complete entry
      // per reply so its copy button includes chunks received between peers.
      const previous = peerSessionId && data.itemId ? this.entries.findLast(entry => entry.kind === 'assistant' && entry.peerSessionId === peerSessionId && entry.itemId === data.itemId && entry.turnId === data.turnId)
        : this.entries.findLast(entry => !['invocation', 'tool-tree', 'actor-activity'].includes(entry.kind));
      if (previous?.kind === 'assistant' && previous.label === label && previous.peerSessionId === peerSessionId && previous.itemId === data.itemId && previous.turnId === data.turnId
        && (peerSessionId || (previous.replyBoundary || 0) === (this.replyBoundary || 0))) previous.text += String(data.text ?? '');
      else this.add('assistant', data.text, { label, peerSessionId, actorSessionId, occurredAt: data.occurredAt, itemId: data.itemId, turnId: data.turnId, replyBoundary: this.replyBoundary || 0 });
      this.streaming = true;
    } else if (type === 'message.user') {
      if (data.kind === 'goal') { this.goal = { status: 'active', objective: clean(data.text) }; this.goalValidation = null; }
      this.pinned = (data.kind === 'goal' ? '/goal ' : '') + clean(data.text); this.add('user', data.text, { goal: data.kind === 'goal', channel: data.channel, occurredAt: data.occurredAt }); this.streaming = false; this.scroll = 0;
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
      this.replyBoundary = (this.replyBoundary || 0) + 1;
      this.currentTool = clean(data.name || 'Tool');
      if (!tools.handled) this.add('tool', this.currentTool); this.streaming = false;
    } else if (type === 'activity') {
      const worker = data.sessionId && data.sessionId !== sessionId;
      const actor = this.actors.for(data.actorSessionId || data.sessionId, sessionId);
      this.currentActivity = data.closedAt ? '' : actor.label + ' · ' + data.summary;
      if (worker && !data.closedAt && data.status === 'running') this.delegationPhase = 'Executor running';
      const index = this.activities.findIndex(item => item.id && item.id === data.id);
      if (index >= 0) this.activities[index] = data; else this.activities.push(data);
      if (typeof data.summary === 'string' && data.summary.trim() && (!data.eventSessionId || data.eventSessionId === sessionId)) {
        const prior = data.id && this.entries.find(entry => entry.kind === 'actor-activity' && entry.activityId === data.id);
        const content = { actorSessionId: data.actorSessionId || data.sessionId || sessionId, status: data.status, closed: Boolean(data.closedAt) };
        if (prior) { Object.assign(prior, content, { text: clean(data.summary) }); this.entryLayouts.delete(prior); }
        else this.add('actor-activity', data.summary, { ...content, activityId: data.id });
      }
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

  clear() { this.monitor = new ActivityMonitor(); this.compactorUsage = null; this.actors = new ActorProjection(); this.executionFeedback = new ExecutionFeedback(); this.toolTrees = new ToolTreeProjection(); this.toolFocus = null; this.entries = []; this.activities = []; this.traffic = []; this.sharedRoom = []; this.assignments.clear(); this.delegationPhase = null; this.delegationUsage = null; this.groupUsage = null; this.debateFocus = null; this.textSelection = null; this.pinned = ''; this.scroll = 0; this.streaming = false; this.currentActivity = ''; this.currentTool = ''; this.tokens = undefined; this.startedAt = null; this.finishedAt = null; this.bodyCache = null; this.pendingApproval = null; this.goal = null; this.goalValidation = null; this.goalValidationVersions = new Map(); this.retiredGoalIds = new Set(); this.snapshotGoalId = null; this.schedule(); }
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
  openExitPrompt() {
    if (!this.ui.sessionId || this.selection || this.hidden || this.promptDraft || this.ui.privateView || this.ui.coreLifecycleInterrupted || this.resolveInput && !/^bzzy\b/.test(this.question || '')) return false;
    const reader = this.ui.reader;
    this.selection = { title: 'Exit BZZY?', presentation: 'context', scope: 'exit', backgroundFrame: this.lastFrame.slice(), single: true, loading: false, focus: 1, query: '',
      choices: [{ value: 'exit', label: 'Exit' }, { value: 'cancel', label: 'Cancel' }], resolve: action => { this.ui.reader = reader; if (action === 'exit') this.localCommand('/exit'); } };
    this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule(); return true;
  }
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
        { value: 'share', label: 'Share full context', description: !canControlSession(this.ui) ? 'Attach with control to share.' : 'Full project and saved chats · QR / expiring code · recipient approval', disabled: !canControlSession(this.ui) },
        { value: 'delete', label: 'Delete chat', description: 'Remove this saved chat from BZZY. Project files are kept.', disabled: /VIEW/.test(this.ui.sessionMode || '') && !this.ui.permissionConnection?.acquire },
        { value: 'rename', label: 'Rename terminal', disabled: !canControlSession(this.ui) },
        { value: 'cancel', label: 'Cancel' },
      ], resolve: action => {
        this.selection = parent; this.ui.reader = reader;
        if (!['open', 'share', 'delete', 'rename'].includes(action)) return;
        if (parent) this.finishSelection(action === 'open' ? id : { value: id, action });
        else this.localCommand(action === 'open' ? '/open-session ' + id : '/session-action ' + action + ' ' + id);
      } };
    this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule(); return true;
  }
  activeAgentCount() {
    const active = new Map([...this.assignments.entries()].map(([id, row]) => [id, row.state || row.status]));
    for (const entry of this.entries) if (entry.kind === 'invocation' && entry.invocationType === 'agent') active.set(entry.assignmentId, entry.state);
    return [...active.values()].filter(state => ['starting', 'running', 'cancelling', 'assigned', 'launched'].includes(state)).length;
  }
  responseParts(entry) {
    this.responseResourceCache ||= new WeakMap();
    const previous = this.responseResourceCache.get(entry);
    if (previous?.text === entry.text) return previous.value;
    const value = responseResources(entry.text); this.responseResourceCache.set(entry, { text: entry.text, value }); return value;
  }
  openResponseMenu(entry, x, y) {
    if (!entry || !['chat', 'room'].includes(this.panel) || this.selection || this.hidden || this.promptDraft || this.ui.privateView || this.aliasEdit) return false;
    const reader = this.ui.reader, resources = this.responseParts(entry);
    this.textSelection = null;
    this.selection = { title: 'Agent response', presentation: 'context', scope: 'response-menu', anchor: { left: x, row: y },
      backgroundFrame: this.lastFrame.slice(), single: true, loading: false, focus: 0, query: '', choices: [
        { value: 'copy', label: 'Copy response', description: 'Copy the complete reply as readable text.' },
        ...resources.code.map((block, index) => ({ value: 'code:' + index, label: 'Copy code · ' + block.language })),
        ...resources.links.map((url, index) => ({ value: 'link:' + index, label: 'Open link · ' + url })),
        { value: 'cancel', label: 'Cancel' },
      ], resolve: action => {
        this.ui.reader = reader;
        if (action === 'copy') this.clipboardTask = this.copySelection(clean(messageBodyToPlainText(entry.text)));
        else if (action?.startsWith('code:') && resources.code[Number(action.slice(5))]) this.clipboardTask = this.copySelection(resources.code[Number(action.slice(5))].text);
        else if (action?.startsWith('link:') && resources.links[Number(action.slice(5))]) this.linkTask = openTerminalLink(resources.links[Number(action.slice(5))]).catch(error => this.notice(error.message, true));
      } };
    this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule(); return true;
  }
  openLibraryMenu(menu, x, y) {
    if (!menu || this.selection || this.hidden || this.promptDraft || this.ui.privateView || this.aliasEdit) return false;
    try { assertLibraryMenu(this.ui, menu); } catch (error) { this.notice(error.message, true); return false; }
    const shown = structuredClone(menu), reader = this.ui.reader;
    this.textSelection = null;
    this.selection = { title: shown.entry.name || 'Saved goal', presentation: 'context', scope: 'library-entry-menu',
      anchor: { left: x, row: y }, backgroundFrame: this.lastFrame.slice(), single: true, loading: false, focus: 0, query: '', choices: [
        { value: 'open', label: 'Open details', description: shown.entry.objective || `Inspect this ${shown.entry.scope} ${shown.kind}.` },
        { value: 'remove', label: 'Remove…', description: 'Remove this Library entry after confirmation. Chat history and evidence are retained.' },
        { value: 'cancel', label: 'Cancel' },
      ], resolve: action => {
        this.ui.reader = reader;
        if (!['open', 'remove'].includes(action)) return;
        try {
          assertLibraryMenu(this.ui, shown);
          this.localCommand(action === 'open' ? shown.openAction : '/library remove-entry ' + prepareLibraryRemoval(this.ui, shown));
        } catch (error) { this.notice(error.message, true); }
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
    if (!this.promptDraft && (this.panel === 'monitor' || this.panel === 'extension' || this.panel === 'settings' || this.panel === 'metrics' || this.panel === 'agents' || this.panel === 'workflows' || this.panel === 'goals'
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
    if (['settings', 'skills', 'agents', 'workflows', 'goals', 'metrics'].includes(this.panel)) return [];
    if (!this.canCompose() || this.hidden || this.promptDraft || this.pasting || this.resolveInput && !/^bzzy\b/.test(this.question || '')) return [];
    const key = JSON.stringify([this.ui.activeTab || this.ui.sessionId, this.cwd, this.value, this.cursor]);
    if (this.completionQuery !== key) { this.completionQuery = key; this.completionFocus = 0; this.completionDismissed = false; }
    if (this.completionDismissed) return [];
    const token = referenceToken(this.value, this.cursor);
    if (!token) return this.resolveInput ? commandSuggestions(this.value) : [];
    const catalogKey = JSON.stringify([this.ui.activeTab || this.ui.sessionId, this.cwd, token.query]);
    if (this.referenceCatalog?.key !== catalogKey || Date.now() - this.referenceCatalog.loadedAt > 1000) {
      try { this.referenceCatalog = { key: catalogKey, loadedAt: Date.now(), ...referenceCatalog(this.ui, token.query) }; }
      catch { this.referenceCatalog = { key: catalogKey, loadedAt: Date.now(), choices: [] }; }
    }
    this.completionFocus = Math.min(this.completionFocus, Math.max(0, this.referenceCatalog.choices.length - 1));
    return this.referenceCatalog.choices;
  }
  completeCommand(choice) {
    if (choice.kind === 'reference') {
      try {
        const draft = insertReference(this.ui, this.value, this.cursor, choice);
        if (!draft) return;
        Object.assign(this, draft);
        this.completionQuery = JSON.stringify([this.ui.activeTab || this.ui.sessionId, this.cwd, this.value, this.cursor]);
        this.completionDismissed = true;
      } catch (error) { this.referenceCatalog = null; this.completionDismissed = true; this.notice(error.message, true); }
    } else { this.value = choice.command + ' '; this.cursor = [...this.value].length; }
    this.schedule();
  }
  completionHint(completions) {
    if (completions[0].kind !== 'reference') return '  Commands · ↑/↓ choose · Tab complete · Esc close';
    return this.referenceCatalog?.truncated ? `  Skills & agents · ${completions.length}/${this.referenceCatalog.total} · type to filter`
      : '  Skills & agents · type to filter · ↑/↓ · Enter/Tab';
  }
  panels() { return this.mode === 'besties' || this.bestiesGroupId || this.sharedRoom.length ? ['chat', 'room', 'activity', 'http', 'sessions', 'skills', 'agents', 'workflows', 'goals', 'metrics', 'settings'] : ['chat', 'activity', 'http', 'sessions', 'skills', 'agents', 'workflows', 'goals', 'metrics', 'settings']; }
  setPanel(panel) {
    if (this.ui.coreLifecycleInterrupted && !['settings', 'metrics', 'chat'].includes(panel)) return;
    if (this.promptDraft || this.selection) return;
    if (panel === 'room' && !this.panels().includes('room')) { this.ui.event('info', { message: 'The shared room is available in a besties conversation. Start with bzzy --besties.' }); return; }
    if (panel === 'settings' && !this.ui.settings) { this.ui.openSettings(); return; }
    if (panel === 'sessions' && this.ui.onSessions?.() === false) return;
    const extensionScroll = this.panel === 'extension' && panel === 'chat' ? this.ui.extensions?.chatScroll : null;
    if (this.panel === 'extension' && panel !== 'extension') this.ui.extensions?.leave();
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
    if (panel === 'goals') { this.goalTopRequested = true; this.goalEnsureFocus = true; this.goalFocus = 0; }
    if (panel === 'metrics') {
      this.ui.sessionMetrics ||= new SessionMetricsPanel(this.ui, { load: this.ui.sessionMetricsLoader });
      this.ui.sessionMetrics.open(this.ui.activeTab || this.ui.sessionId);
      this.metricsTopRequested = true;
    } else this.ui.sessionMetrics?.stop();
    this.textSelection = null; this.panel = panel; this.scroll = extensionScroll ?? 0; this.schedule();
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
    else if (picker.emptyMessage) { picker.error = picker.emptyMessage; this.schedule(); }
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
    if (this.historyRestoreDepth || this.copyMode) return;
    if (this.workspaceMouse(button, x, y, released)) return;
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
      } else if (this.panel === 'extension' && !this.promptDraft) {
        const extensions = this.ui.extensions; extensions.offset = Math.max(0, Math.min(extensions.maximum || 0, extensions.offset + delta));
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
      if (target?.libraryMenu) { if (this.openLibraryMenu(target.libraryMenu, x, y)) this.feedback(target); return; }
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
    if (hit?.type === 'workspace-models' || hit?.type === 'workspace-actions') { this.menuTask = this.openWorkspaceMenu(hit.type === 'workspace-models' ? 'models' : 'actions'); return; }
    if (hit?.type?.startsWith('extension-')) { this.ui.extensions.click(hit); return; }
    if (hit?.type === 'session-new') { this.localCommand('/new'); return; }
    if (hit?.type === 'session-paths') {
      const cwd = this.ui.sessionWorkingDirectory, memory = this.ui.sessionProjectLocation?.path;
      this.pathTask = this.localChoice('Session locations · click to copy', [{ value: cwd, label: 'Working directory', description: cwd || 'Unavailable', disabled: !cwd }, { value: memory, label: 'Session .bzzy', description: memory || 'Unavailable', disabled: !memory }], { presentation: 'dropdown' }).then(value => value && this.copySelection(value));
      return;
    }
    if (hit?.type === 'working-directory') {
      if (hit.path) this.clipboardTask = this.copySelection(hit.path);
      else this.notice('The session working directory is unavailable.', true);
      return;
    }
    if (hit?.type === 'session-project-path') {
      const location = this.ui.refreshSessionProjectLocation();
      if (location.path) this.clipboardTask = this.copySelection(location.path);
      else this.ui.showSessionProjectLocation();
      return;
    }
    if (hit?.type === 'response-menu' || hit?.type === 'response-code') { this.openResponseMenu(hit.entry, hit.left, hit.row); return; }
    if (hit?.type === 'response-link') { this.linkTask = openTerminalLink(hit.url).catch(error => this.notice(error.message, true)); return; }
    if (hit?.type === 'top-chat') { this.setPanel('chat'); return; }
    if (hit?.type === 'top-skills') { this.localCommand('/skills'); return; }
    if (hit?.type === 'top-agents') { this.localCommand('/agents'); return; }
    if (hit?.type === 'top-workflows') { this.localCommand('/workflow library'); return; }
    if (hit?.type === 'top-goals') { this.localCommand('/saved-goals'); return; }
    if (hit?.type === 'workflow-open') { this.localCommand('/workflow'); return; }
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
    if (changeToolTree(hit)) { this.refreshToolTree(hit.group); return; }
    if (hit?.type === 'alias-save') { const value = this.aliasEdit?.value.trim(); this.aliasEdit = null; if (value) this.localCommand('/alias ' + value); this.schedule(); return; }
    if (hit?.type === 'alias-cancel') { this.aliasEdit = null; this.schedule(); return; }
    if (this.aliasEdit && hit?.type !== 'alias') { this.aliasEdit = null; this.schedule(); }
    if (hit?.type === 'panel') this.setPanel(hit.panel);
    else if (hit?.type === 'model-control') {
      if (hit.disabled) this.notice(!canControlSession(this.ui) ? 'This terminal is read-only.' : this.busy ? 'Pause the current response before changing its model.' : 'Select a model first.', true);
      else if (hit.command === '/providers @saved' && this.busy) { this.modelAnchor = { left: hit.left, row: hit.row }; this.modelSaveTask = this.saveModelWhileWorking(); }
      else if (hit.command === '/settings core') { this.ui.openSettings(); this.settingsAction('core'); }
      else { this.modelAnchor = { left: hit.left, row: hit.row }; this.localCommand(hit.command); }
    }
    else if (hit?.type === 'skill-action') this.localCommand('/skills ' + hit.action);
    else if (hit?.type === 'agent-action') this.localCommand('/agents ' + hit.action);
    else if (hit?.type === 'workflow-action') this.localCommand('/workflow ' + hit.action);
    else if (hit?.type === 'goal-action') { if (!hit.disabled) this.localCommand('/saved-goals ' + hit.action); }
    else if (hit?.type === 'saved-session') this.sessionOpenTask = confirmSavedSessionOpen(this.ui, hit.id).then(open => { if (open) this.localCommand('/open-session ' + hit.id); });
    else if (hit?.type === 'alias') {
      const time = Date.now();
      if (time - (this.aliasClickedAt || 0) < 450 && !this.selection && !this.promptDraft && this.resolveInput && /^bzzy\b/.test(this.question || '') && canControlSession(this.ui)) this.aliasEdit = { value: this.alias || '', cursor: [...(this.alias || '')].length };
      this.aliasClickedAt = time; this.schedule();
    }
    else if (hit?.type === 'settings') this.settingsAction(hit.action);
    else if (hit?.type === 'settings-back') { if (!this.ui.settings.busy) { if (!this.ui.settings.back()) { if (this.ui.settingsOnly) this.finish(null); else this.setPanel('chat'); } } }
    else if (hit?.type === 'qr-back') { this.ui.settings.qrView = false; this.lastFrame = []; this.schedule(); }
    else if (hit?.type === 'private-cancel') { if (this.resolveInput) this.finish(null); else this.ui.privateView?.onCancel?.(); }
    else if (hit?.type === 'private-action') this.privateAction(hit.action);
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
  refreshToolTree(group) {
    this.toolFocus = group.expanded ? group : null;
    this.entryLayouts.delete(group.entry); this.contentRevision++; this.bodyCache = null; this.schedule();
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
    if (this.panel === 'goals') { if (this.ui.goalPreview) goalAction('back', this.ui); else this.setPanel('chat'); return; }
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
    if (this.panel === 'chat' && this.toolFocus?.expanded) { this.toolFocus.expanded = false; this.refreshToolTree(this.toolFocus); return true; }
    if (this.panel === 'settings') { this.leaveSettings(); return true; }
    if (this.panel === 'skills' && returnToSkillLibrary(this.ui)) return true;
    if (this.panel === 'workflows') { workflowAction('back', this.ui); return true; }
    if (this.panel === 'goals') { if (this.ui.goalPreview) goalAction('back', this.ui); else this.setPanel('chat'); return true; }
    if (this.panel === 'agents' && returnFromDefinitionBundle(this.ui, 'agents')) return true;
    if (this.panel === 'agents' && this.ui.subagentCreatorDraft) {
      this.ui.subagentCreatorDraft = null; this.ui.subagentPreview = null; this.ui.subagentView = 'library';
      this.bodyCache = null; this.scroll = 0; this.agentTopRequested = true; this.schedule(); return true;
    }
    if (this.panel !== 'chat') { this.setPanel('chat'); return true; }
    return this.openExitPrompt();
  }
  key(text, key) {
    if (this.historyRestoreDepth) {
      key.bzzyHandled = true;
      if (key.sequence === '\x1b[<') this.loadingMouseReport = true;
      else if (this.loadingMouseReport) { if (/[Mm]$/.test(text || key.sequence || '')) this.loadingMouseReport = false; }
      else if (this.historyLoading && this.historyLoading.keys.length < 8192) this.historyLoading.keys.push([text, { ...key, bzzyHandled: false }]);
      return;
    }
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
    if (this.ui.privateView?.actionMode && this.resolveInput) {
      key.bzzyHandled = true;
      const view = this.ui.privateView, actions = (view.actions || []).filter(action => !action.disabled);
      if (key.name === 'escape' || key.ctrl && key.name === 'c') this.finish(null);
      else if (['tab', 'left', 'right'].includes(key.name) && actions.length) {
        const step = key.name === 'left' || key.shift ? -1 : 1;
        view.actionFocus = ((view.actionFocus || 0) + step + actions.length) % actions.length; this.schedule();
      } else if (key.name === 'return' && actions.length) {
        const action = actions[view.actionFocus || 0];
        if (action?.value !== '/cancel' || view.actionFocus !== undefined) this.privateAction(action?.value);
      }
      else if (!key.ctrl && !key.meta && ['c', 'v', 'q', 'a'].includes((text || key.name || '').toLowerCase())) this.privateAction((text || key.name).toLowerCase());
      return;
    }
    if (this.aliasEdit) {
      key.bzzyHandled = true;
      const edit = this.aliasEdit, chars = [...edit.value];
      if (key.name === 'escape' || key.ctrl && key.name === 'c') this.aliasEdit = null;
      else if (key.name === 'return') { this.aliasEdit = null; if (edit.value.trim()) this.localCommand('/alias ' + edit.value.trim()); }
      else if (key.name === 'left') edit.cursor = Math.max(0, edit.cursor - 1);
      else if (key.name === 'right') edit.cursor = Math.min(chars.length, edit.cursor + 1);
      else if ((key.meta || key.ctrl) && key.name === 'backspace' || key.ctrl && key.name === 'w') { const start = wordBoundary(chars, edit.cursor, -1); chars.splice(start, edit.cursor - start); edit.cursor = start; edit.value = chars.join(''); }
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
      if (['skills', 'agents', 'workflows', 'goals'].includes(this.panel) && !this.selection && !this.promptDraft) {
        const key = ({ skills: 'skill', agents: 'agent', workflows: 'workflow', goals: 'goal' })[this.panel];
        const library = this.libraryMenus?.panel === this.panel ? this.libraryMenus : null;
        const action = library?.actions[this[key + 'Focus'] || 0], menu = library?.menus.get(action);
        const hit = this.hitTargets?.find(target => target.action === action && target.libraryMenu);
        if (menu) this.openLibraryMenu(menu, hit?.left || 3, hit?.row || (this.sceneHeaderLength || 2) + 1);
        else this.notice('Choose a Library entry, then press F10 for its actions.');
        return;
      }
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
    if (!this.selection && !this.promptDraft && !this.hidden && key.name === 'f6') {
      const ids = ['', ...(this.ui.extensions?.catalog || []).map(e => e.id)], at = ids.indexOf(this.ui.extensions?.id || '');
      this.ui.extensions?.select(ids[(at + (key.shift ? ids.length - 1 : 1)) % ids.length]); key.bzzyHandled = true; return;
    }
    if (this.panel === 'extension' && !this.selection && !this.promptDraft) { key.bzzyHandled = true; this.ui.extensions.key(text, key); return; }
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
      else if (picker.kind === 'model' && (key.name === 'backspace' || key.ctrl && key.name === 'w')) {
        const query = [...(picker.query || '')];
        picker.query = query.slice(0, key.meta || key.ctrl ? wordBoundary(query, query.length, -1) : -1).join(''); picker.error = '';
      }
      else if (picker.kind === 'model' && key.ctrl && key.name === 'u') { picker.query = ''; picker.error = ''; }
      else if (picker.kind === 'model' && text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) { picker.query = ((picker.query || '') + text).slice(0, 120); picker.error = ''; }
      this.schedule(); return;
    }
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; return; }
    if (key.ctrl && key.name === 'b' && this.panel === 'chat' && !this.promptDraft && !this.hidden && !this.pasting) {
      key.bzzyHandled = true; this.toggleDebate(this.entries.findLast(entry => entry.kind === 'debate')); return;
    }
    if (key.ctrl && key.name === 't' && this.panel === 'chat' && !this.promptDraft && !this.hidden && !this.pasting) {
      const group = this.entries.findLast(entry => entry.toolTree)?.toolTree;
      if (group) { group.expanded = !group.expanded; this.refreshToolTree(group); }
      key.bzzyHandled = true; return;
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
      key.bzzyHandled = true;
      if (this.promptDraft || this.hidden || !this.ui.sessionId) this.finish(null);
      else if (this.busy && canControlSession(this.ui)) this.localCommand('/pause');
      else this.openExitPrompt();
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
      else if (key.name === 'e' && !key.ctrl && !key.meta) this.metricsAction('export');
      else if (key.name === 'f' && !key.ctrl && !key.meta) this.metricsAction('full-export');
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
      } else if (key.name === 'return' && actions[this.workflowFocus || 0]) this.localCommand('/workflow ' + actions[this.workflowFocus || 0]);
      else if (key.name === 'home') this.scroll = this.scrollbar?.maximum || 0;
      else if (key.name === 'end') this.scroll = 0;
      this.schedule(); return;
    }
    if (this.panel === 'goals' && !this.promptDraft) {
      key.bzzyHandled = true;
      const actions = libraryActionList(goalRows(this.ui));
      if (['up', 'down', 'left', 'right', 'tab'].includes(key.name) && actions.length) {
        const backwards = ['up', 'left'].includes(key.name) || key.name === 'tab' && key.shift;
        this.goalFocus = ((this.goalFocus || 0) + (backwards ? actions.length - 1 : 1)) % actions.length;
        this.goalEnsureFocus = true;
      } else if (key.name === 'return' && actions[this.goalFocus || 0]) this.localCommand('/saved-goals ' + actions[this.goalFocus || 0]);
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
    if (this.pasting && (['backspace', 'delete'].includes(key.name) || key.ctrl && key.name === 'w')) { key.bzzyHandled = true; return; }

    const completions = this.completions();
    if (completions.length) {
      if (['up', 'down', 'tab', 'escape', 'return'].includes(key.name) && !key.ctrl && !key.meta && !(key.name === 'return' && key.shift) && !this.pasting) {
        key.bzzyHandled = true;
        if (key.name === 'up' || key.name === 'down') this.completionFocus = (this.completionFocus + (key.name === 'up' ? completions.length - 1 : 1)) % completions.length;
        else if (key.name === 'escape') this.completionDismissed = true;
        else {
          const choice = completions[this.completionFocus];
          if (choice.kind === 'reference' || key.name === 'tab' || choice.argument && this.value !== choice.command) { this.completeCommand(choice); return; }
          this.value = choice.command; this.cursor = [...this.value].length;
          // Enter confirms a command; the normal submit path handles local views below.
        }
        if (key.name !== 'return') { this.schedule(); return; }
      }
    }
    if (key.name === 'tab') return;
    if (key.ctrl && key.name === 'd' && !this.value) { key.bzzyHandled = true; if (this.promptDraft || this.hidden || !this.ui.sessionId) this.finish(null); else this.openExitPrompt(); return; }
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
    else if ((key.meta || key.ctrl) && key.name === 'backspace' || key.ctrl && key.name === 'w') { const start = wordBoundary(chars, this.cursor, -1); chars.splice(start, this.cursor - start); this.cursor = start; }
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
      if (picker.columnHeader) put('        ' + picker.columnHeader, palette.muted);
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
        const confirm = `[ ${picker.confirmLabel || 'Confirm'} ]`, cancel = `[ ${picker.cancelLabel || 'Cancel'} ]`;
        this.contentHits.push({ type: 'confirm', row: lines.length, left: 3, right: 2 + cellWidth(confirm) },
          { type: 'cancel', row: lines.length, left: 6 + cellWidth(confirm), right: 5 + cellWidth(confirm + cancel) });
        put('  ' + confirm + '   ' + cancel, palette.accent);
      }
    } else if (this.panel === 'settings') {
      const tightMain = this.ui.settings.page === 'main' && (this.output.rows || 24) <= 24 && this.ui.settings.rows().filter(row => row.card).length > 4;
      const layout = settingsLayout(this.ui.settings, width, this.theme, { spaced: (this.output.rows || 24) - (this.sceneHeaderLength || 2) >= 18 && !tightMain });
      this.settingsFocusRow = layout.focusRow; this.settingsFocusRange = layout.focusRange; this.settingsFocusedAction = layout.focusAction; this.contentHits.push(...layout.hits); lines.push(...layout.lines);
    } else if (['skills', 'agents', 'workflows', 'goals'].includes(this.panel)) {
      const rows = this.panel === 'skills' ? skillRows(this.ui) : this.panel === 'agents' ? subagentRows(this.ui)
        : this.panel === 'workflows' ? workflowRows(this.ui) : goalRows(this.ui);
      const key = ({ skills: 'skill', agents: 'agent', workflows: 'workflow', goals: 'goal' })[this.panel];
      const layout = libraryLayout(rows, width, this.theme, { panel: key, focus: this[key + 'Focus'] || 0 });
      this.libraryMenus = { panel: this.panel, menus: layout.menus, actions: layout.actions };
      this[key + 'FocusRow'] = layout.focusRow; this.contentHits.push(...layout.hits); lines.push(...layout.lines);
    } else if (this.panel === 'metrics') {
      const layout = sessionMetricsLayout(this.ui.sessionMetrics, width, { currentGoal: this.goal, alias: this.alias, focus: this.metricsFocus || 0, selection: this });
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
        const attribution = this.actors.for(item.actorSessionId || item.sessionId, this.ui.activeTab || this.ui.sessionId).label + ' · ';
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
      let assistantSpeaker = null;
      for (const entry of this.entries) {
        if (['tool', 'tool-tree'].includes(entry.kind) && !this.showTools) continue;
        const layout = this.entryLayout(entry, width);
        const speaker = entry.kind === 'assistant' ? JSON.stringify([entry.label || 'BZZY', entry.peerSessionId || null]) : null;
        const continuation = speaker !== null && speaker === assistantSpeaker;
        const entryLines = continuation ? layout.lines.slice(1) : layout.lines.slice();
        if (speaker !== null) assistantSpeaker = speaker;
        else if (!['tool', 'tool-tree', 'invocation', 'notice', 'actor-activity'].includes(entry.kind)) assistantSpeaker = null;
        if (entry.kind === 'assistant') for (let offset = 0; offset < entryLines.length - 1; offset++)
          this.contentHits.push({ type: 'response', entry, row: lines.length + offset, left: 3, right: width - 2 });
        if (entry.kind === 'assistant') {
          const resources = this.responseParts(entry);
          if (!continuation && cellWidth(entryLines[0]) + 8 <= width) {
            const left = cellWidth(entryLines[0]) + 1;
            entryLines[0] += color('  [ ⋯ ]', palette.muted);
            this.contentHits.push({ type: 'response-menu', entry, row: lines.length, left, right: left + 7 });
          }
          for (const [offset, styled] of entryLines.entries()) {
            const visible = clean(styled);
            for (const url of resources.links) {
              const start = visible.indexOf(url);
              if (start >= 0) this.contentHits.push({ type: 'response-link', url, row: lines.length + offset, left: cellWidth(visible.slice(0, start)) + 1, right: cellWidth(visible.slice(0, start + url.length)) });
            }
            if (resources.code.length && (/┌─ /.test(visible) || /```/.test(visible))) this.contentHits.push({ type: 'response-code', entry, row: lines.length + offset, left: 3, right: width - 2 });
          }
        }
        if (entry.kind === 'approval') this.contentHits.push({ type: 'approval-details', id: entry.questionId, row: lines.length, left: 3, right: width - 2 });
        if (entry.kind === 'debate' || entry.toolTree) for (const hit of layout.hits || []) this.contentHits.push({ ...hit, row: lines.length + hit.row });
        for (const line of entryLines) lines.push(line);
      }
    }
    return lines;
  }

  entryLayout(entry, width) {
    const cached = this.entryLayouts.get(entry);
    if (cached?.width === width && cached.text === entry.text && (!entry.toolTree || cached.showTools === Boolean(this.showTools))) return cached;
    if (entry.kind === 'tool-tree') {
      const layout = { ...toolTreeLayout(entry.toolTree, width, this.theme), width, text: entry.text, showTools: Boolean(this.showTools) };
      this.entryLayouts.set(entry, layout); return layout;
    }
    if (entry.kind === 'debate') {
      const layout = { ...debateEntryLayout(entry, width, this.theme), width, text: entry.text };
      this.entryLayouts.set(entry, layout); return layout;
    }
    if (entry.kind === 'invocation') {
      const base = invocationEntryLayout(entry, width, this.theme), tools = entry.toolTree && this.showTools ? toolTreeLayout(entry.toolTree, width, this.theme, { nested: true }) : { lines: [], hits: [] };
      const layout = { lines: [...base.lines, ...tools.lines], hits: tools.hits.map(hit => ({ ...hit, row: hit.row + base.lines.length })), width, text: entry.text, showTools: Boolean(this.showTools) };
      this.entryLayouts.set(entry, layout); return layout;
    }
    const { color } = this.theme;
    const lines = [], put = (text, tone = palette.text, bold = false) => lines.push(color(text, tone, bold));
    const identityTone = actorColor(this.actors.for(entry.actorSessionId || entry.peerSessionId, this.ui.activeTab || this.ui.sessionId));
    const replyLine = line => color('  │ ', identityTone) + color(line, palette.text);
    const stamp = entry.occurredAt && Number.isFinite(Date.parse(entry.occurredAt)) ? '  ' + new Date(entry.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
    const speaker = (icon, label, tone) => fillSurface(' ' + icon + ' ', 3, this.theme, tone, palette.background, true) + color(' ' + label, tone, true) + color(stamp, palette.muted);
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
      lines.push(speaker('›', label === 'YOU' ? 'You' : 'You · Goal', palette.user));
      for (const line of wrapProse(text, width - 7)) {
        lines.push(color('  ▎ ', palette.user)
          + color(line, palette.userText));
      }
      put('');
    }
    else if (entry.kind === 'notice') { for (const line of wrap(entry.text, width - 5)) put('  · ' + line, palette.muted); put(''); }
    else if (entry.kind === 'actor-activity') {
      const actor = this.actors.for(entry.actorSessionId, this.ui.activeTab || this.ui.sessionId);
      const status = ['planned', 'running', 'completed', 'blocked', 'inconclusive'].includes(entry.status) ? entry.status : 'reported';
      for (const line of wrap(`${actor.label} · ${entry.text} · ${entry.closed ? 'stopped' : status}`, Math.max(1, width - 4))) put(clip('  › ' + line, width), palette.muted);
      put('');
    }
    else if (entry.kind === 'tool') put('  › ' + clip(entry.text, width - 5), palette.muted);
    else {
      // Keep the original body for replay and copying; derive presentation only
      // after a complete valid root is available. Incomplete markup stays text.
      const projection = entry.kind === 'assistant' ? parseMessageBody(entry.text) : null;
      const displayText = clean(projection ? projection.plainText : entry.text);
      const isFormatted = Boolean(projection?.isFormatted);
      const tone = entry.kind === 'error' ? palette.danger : entry.kind === 'question' ? palette.warning : entry.kind === 'assistant' ? actorColor(this.actors.for(entry.actorSessionId || entry.peerSessionId, this.ui.activeTab || this.ui.sessionId)) : palette.agent;
      const actor = this.actors.for(entry.actorSessionId || entry.peerSessionId, this.ui.activeTab || this.ui.sessionId);
      const label = entry.kind === 'assistant' ? actor.role === 'main' ? 'BZZY · Main' : actor.label.replace(/^(Agent|Worker|Reviewer)/, word => word.toUpperCase()) : entry.kind === 'question' ? 'YOUR INPUT IS NEEDED' : entry.kind.toUpperCase();
      const displayLabel = entry.kind === 'assistant' ? clip(label, width - 4) : label;
      if (isFormatted) {
        lines.push(speaker('✦', displayLabel, tone));
        const rendered = renderMessageContent(projection, { width: width - 7, theme: this.theme, background: palette.background });
        for (const line of rendered.lines) lines.push(replyLine(line));
        lines.push(color('  │', tone));
        const layout = { width, text: entry.text, lines, displayText, isFormatted };
        this.entryLayouts.set(entry, layout); return layout;
      }
      const append = entry.kind === 'assistant' && cached?.width === width && cached.rawLines && isFormatted === cached.isFormatted && displayText.startsWith(cached.displayText);
      // Only the final wrapped line can change when a response receives a delta.
      // Keep older Unicode/Markdown lines as well as completed replies cached.
      const tail = wrapProse(append ? cached.rawLines.at(-1) + displayText.slice(cached.displayText.length) : displayText, width - (entry.kind === 'assistant' ? 7 : 5));
      const rawLines = append ? [...cached.rawLines.slice(0, -1), ...tail] : tail;
      if (append) for (const line of cached.lines.slice(0, -2)) lines.push(line);
      else if (entry.kind === 'assistant') lines.push(speaker('✦', displayLabel, tone));
      else put(`  ${displayLabel}`, tone, true);
      for (const line of tail) {
        const text = isFormatted ? line : line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/^#{1,6}\s+/, '');
        if (entry.kind === 'assistant') lines.push(replyLine(text));
        else put('  ' + text, entry.kind === 'error' ? palette.danger : palette.text, !isFormatted && /^#{1,6}\s/.test(line));
      }
      if (entry.kind === 'assistant') lines.push(color('  │', tone));
      else put('');
      const layout = { width, text: entry.text, lines, rawLines, displayText, isFormatted };
      this.entryLayouts.set(entry, layout); return layout;
    }
    const layout = { width, text: entry.text, lines };
    this.entryLayouts.set(entry, layout); return layout;
  }

  executionActivity(width) {
    const view = this.executionFeedback.view(this.entries);
    if (!view) return [];
    const { color } = this.theme, tone = view.warning ? palette.warning : view.complete ? palette.goalSuccess : palette.accent;
    const prefix = view.complete ? view.warning ? '■' : '✓' : view.waiting ? '?' : spinner[this.frame % spinner.length];
    const elapsed = ` ${view.elapsed} `, title = `${prefix} ${view.title}${view.detail ? ' · ' + view.detail : ''}`;
    const first = '  ' + color(clip(title, Math.max(1, width - cellWidth(elapsed) - 3)), tone, true);
    const lines = [first + ' '.repeat(Math.max(1, width - cellWidth(first) - cellWidth(elapsed))) + color(elapsed, tone)];
    if (view.meta) lines.push(color(clip('    ' + view.meta, width), view.warning ? palette.warning : palette.muted));
    return lines;
  }
  sourceProjection(id = this.ui.activeTab || this.ui.sessionId) {
    if (this.terminalSource?.id !== id || this.terminalSource.monitor !== this.monitor) this.terminalSource = { id, monitor: this.monitor,
      projection: createTerminalSourceProjection(id, (type, data) => this.monitor.event(type, data, this.actors, id)) };
    return this.terminalSource.projection;
  }
  beginHistoryRestore(session) {
    if (!this.historyRestoreDepth) this.historyLoading = { session, count: 0, started: Date.now(), keys: [] };
    this.historyRestoreDepth = (this.historyRestoreDepth || 0) + 1;
    clearTimeout(this.renderTimer); this.renderTimer = null; this.render();
    let finished = false;
    return (success = true) => {
      if (finished) return;
      finished = true;
      if (!success && this.historyLoading) this.historyLoading.failed = true;
      if (--this.historyRestoreDepth === 0) {
        const queued = this.historyLoading?.failed ? [] : this.historyLoading?.keys || [];
        this.historyLoading = null; this.loadingMouseReport = false; this.loadingFrameKey = null; this.paintedFrame = null; this.lastFrame = [];
        this.scroll = 0; this.bodyCache = null;
        if (success) { try { this.sourceProjection(session?.id).restore(); } catch { /* Missing old input stays absent. */ } }
        this.render();
        for (const [text, key] of queued) this.key(text, key);
      }
    };
  }
  historyRestoreProgress(count) { if (this.historyLoading) { this.historyLoading.count += count; this.schedule(); } }
  schedule() { if (!this.renderTimer && !this.closed && !this.copyMode && !this.outputBlocked) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, animationInterval); }
  tokenLabel() {
    const partial = ['besties', 'parallel'].includes(this.mode) && this.groupUsage && !this.groupUsage.complete;
    return this.tokens != null ? (partial ? '≥' : '') + this.tokens.toLocaleString() + ' tokens' : 'tokens —';
  }
  goalBadgeLayout(width, { reserved = 0, surface = palette.background, showEmpty = false } = {}) {
    const goal = goalIndicator(this.goal, this.frame, { validating: this.mode === 'debate' && this.busy });
    const work = ['queued', 'starting', 'stopping', 'needs your input'].includes(this.state)
      || this.executionGoal === false || this.executionGoal == null && !goal?.animated ? chatWorkIndicator(this, this.frame) : null;
    const primary = work || goal, validation = goalValidationIndicator(this.goal, this.goalValidation, this.frame);
    if (!primary && !showEmpty) return { line: '', extra: [] };
    const badge = (indicator, maximum) => {
      const text = ' ' + clip(indicator.label, Math.max(1, maximum - 2)) + ' ';
      return this.theme.background(surface) + this.theme.color(text, indicator.empty ? palette.muted : indicator.tone, true) + this.theme.background(surface);
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
  privateHeader(width, options = {}) {
    const header = workspaceHeader(this, width, { ...options, privateMode: true });
    return header;
  }
  renderSettings(width, height) {
    const { color } = this.theme, settings = this.ui.settings;
    const subtitle = settings.pageSubtitle || '';
    const header = this.navigationHeader(width);
    const backRow = header.length + 1;
    header.push(color('  ← Back', settings.busy ? palette.muted : palette.accent, true)
      + color(clip('  ' + settings.pageTitle + (subtitle ? ' · ' + subtitle : ''), Math.max(0, width - 9)), palette.muted));
    this.hitTargets.push({ type: 'back', row: backRow, left: 3, right: 9 });
    this.sceneHeaderLength = header.length;
    const compact = height - header.length < 16 || settings.page === 'main' && height <= 28;
    if (!compact) header.push('');
    const footer = compact ? [] : [''];
    if (settings.busy) footer.push(color('  Working…', palette.muted));
    if (settings.message) for (const line of wrap(settings.message, width - 4, 3)) footer.push(color('  ' + line, settings.warning ? palette.warning : palette.accent));
    const exit = settings.page !== 'main' ? 'back' : this.ui.settingsOnly ? 'close' : 'chat';
    if (!compact) footer.push('');
    const exitRow = footer.length;
    const backLabel = '  [← ' + (exit === 'back' ? 'Back' : exit === 'close' ? 'Close' : 'Chat') + ']';
    footer.push(color(clip(backLabel + '   [Actions ⋯]', width), palette.accent));
    if (!compact) footer.push('');
    if (height < 14) footer.length = 0;
    const bodyHeight = Math.max(1, height - header.length - footer.length);
    const body = this.content(width - 2), focus = this.settingsFocusRow || 0;
    const focusKey = [settings.page, settings.focus, width, height].join(':');
    if (this.settingsFocusKey !== focusKey) this.settingsEnsureFocus = true;
    this.settingsFocusKey = focusKey;
    // Start at the top; follow keyboard focus only when the page needs scrolling.
    this.settingsMaximum = Math.max(0, body.length - bodyHeight);
    this.settingsOffset = Math.min(this.settingsOffset || 0, this.settingsMaximum);
    if (this.settingsEnsureFocus) {
      const range = this.settingsFocusRange;
      if (range && range.bottom - range.top + 1 <= bodyHeight) {
        if (range.top < this.settingsOffset) this.settingsOffset = range.top;
        else if (range.bottom >= this.settingsOffset + bodyHeight) this.settingsOffset = range.bottom - bodyHeight + 1;
      } else if (focus < this.settingsOffset) this.settingsOffset = focus;
      else if (focus >= this.settingsOffset + bodyHeight) this.settingsOffset = focus - bodyHeight + 1;
      this.settingsEnsureFocus = false;
    }
    const visible = body.slice(this.settingsOffset, this.settingsOffset + bodyHeight);
    while (visible.length < bodyHeight) visible.push('');
    this.hitTargets.push(...this.contentHits.filter(hit => hit.row >= this.settingsOffset && hit.row < this.settingsOffset + bodyHeight)
      .map(hit => ({ ...hit, row: header.length + hit.row - this.settingsOffset + 1 })));
    if (footer.length) {
      const row = header.length + bodyHeight + exitRow + 1;
      this.hitTargets.push({ type: 'settings-back', row, left: 3, right: cellWidth(backLabel) }, { type: 'workspace-actions', row, left: cellWidth(backLabel) + 3, right: Math.min(width, cellWidth(backLabel) + 16) });
    }
    const lines = [...header, ...visible, ...footer];
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) {
      const line = lines[row] || '';
      const background = row === 0 ? palette.surface : palette.background;
      frame += `\x1b[${row + 1};1H${this.theme.background(background)}${this.theme.foreground(palette.text)}\x1b[2K${line}\x1b[0m`;
    }
    this.textRegion = null; this.scrollbar = null;
    this.lastFrame = lines.slice(0, height); this.lastBackgrounds = []; this.writeFrame(frame);
  }
  renderSettingsQR(width, height) {
    const { color } = this.theme, settings = this.ui.settings, qr = settings.qrLines();
    const qrWidth = Math.max(0, ...qr.map(line => cellWidth(line))) + 8;
    const notice = settings.warning || /copied|opened|copy request/i.test(settings.message);
    const copyLabel = width < 70 ? 'Copy' : 'Copy code', openLabel = width < 70 ? 'Open' : 'Open image';
    const controls = copyLabel + '  ' + openLabel + '  Chat';
    // Two compact rows leave room for every QR module and its quiet zone at 80×24.
    const fits = qr.length && qrWidth <= width && qr.length + 6 <= height;
    const { lines: header, controlLeft } = this.privateHeader(width, { controls: fits ? controls : '' });
    if (notice) header[1] = color(clip('  ' + settings.message, width), settings.warning ? palette.warning : palette.accent);
    const lines = [...header];
    if (fits) {
      const indent = ' '.repeat(Math.max(0, Math.floor((width - qrWidth) / 2)));
      const blank = indent + '\x1b[47m' + ' '.repeat(qrWidth) + '\x1b[0m';
      lines.push(blank, blank);
      for (const line of qr) lines.push(indent + '\x1b[47m    ' + line + '\x1b[47m    \x1b[0m');
      lines.push(blank, blank);
      const openLeft = controlLeft + cellWidth(copyLabel + '  ');
      this.hitTargets.push({ type: 'settings', action: 'copy-code', row: 1, left: controlLeft, right: controlLeft + cellWidth(copyLabel) - 1 },
        { type: 'settings', action: 'open-qr', row: 1, left: openLeft, right: openLeft + cellWidth(openLabel) - 1 },
        { type: 'top-chat', row: 1, left: width - cellWidth('Chat') + 1, right: width });
    } else {
      this.hitTargets.push({ type: 'qr-back', row: lines.length + 1, left: 3, right: 9 });
      lines.push(color(clip('  ← Back  Pair iPhone', width), palette.accent, true), '');
      for (const line of wrap('Open the QR image to scan with your iPhone, or use the code.', width - 4)) lines.push(color('  ' + line, palette.muted));
      const actionRow = lines.length + 1;
      lines.push(color(clip('  [ Open QR image ]   [ Copy code ]', width), palette.accent, true), '');
      for (const line of wrap(settings.invitationCode() || '', width - 4)) lines.push(color('  ' + line, palette.text, true));
      if (notice) for (const line of wrap(settings.message, width - 4, 2)) lines.push(color('  ' + line, settings.warning ? palette.warning : palette.accent));
      lines.push(color(clip('  Scan the QR, or copy the expiring code.', width), palette.muted));
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
    const lines = this.privateHeader(width).lines;
    lines.push(sectionHeading(clean(view.title), width, this.theme), '');
    const hits = [], buttonRows = [];
    if (view.code) lines.push(...wrap(clean(view.code), Math.max(1, width - 4)).map(line => color('  ' + line, palette.text, true)), '');
    if (view.actions?.length) {
      let line = '  ', column = 3;
      for (const [index, action] of view.actions.entries()) {
        const label = '[ ' + clean(action.label) + ' ]', size = Math.min(width - 4, cellWidth(label));
        if (column + size > width && column > 3) { buttonRows.push(line); line = '  '; column = 3; }
        const disabled = !view.actionMode || !this.resolveInput || action.disabled;
        const focused = view.actionFocus === index || !view.actionFocus && index === 0;
        line += fillSurface(clip(label, size), size, this.theme, focused && !disabled ? palette.selection : palette.surface, disabled ? palette.muted : palette.accent, !disabled) + '  ';
        hits.push({ type: 'private-action', action: action.value, disabled, row: lines.length + buttonRows.length + 1, left: column, right: column + size - 1 });
        column += size + 2;
      }
      buttonRows.push(line); lines.push(...buttonRows.map(row => sliceCells(row, 0, width)), '');
    }
    const content = (view.lines || []).flatMap(line => wrap(clean(line), Math.max(1, width - 4)).map(item => '  ' + item));
    const reserved = 5;
    lines.push(...content.slice(0, Math.max(0, height - reserved - lines.length)));
    if (view.progress && lines.length < height - reserved) {
      lines.push(color(clip('  ' + clean(view.progress.label || 'Importing…'), width), palette.accent));
      const { received, total } = view.progress;
      if (Number.isSafeInteger(received) && Number.isSafeInteger(total) && total > 0 && received >= 0 && received <= total && lines.length < height - reserved) {
        const fraction = received / total;
        const bytes = value => value < 1024 ? value + ' B' : (value / 1024).toFixed(1) + ' KiB';
        const counts = Math.floor(fraction * 100) + '% · ' + bytes(received) + ' / ' + bytes(total);
        const cells = Math.max(4, Math.min(24, width - cellWidth(counts) - 5)), filled = Math.floor(cells * fraction);
        lines.push(color(clip('  [' + '='.repeat(filled) + '-'.repeat(cells - filled) + '] ' + counts, width), palette.accent));
      }
    }
    const qr = view.qr || [], qrWidth = Math.max(0, ...qr.map(line => cellWidth(line))) + 8;
    if (qr.length && qrWidth <= width && lines.length + qr.length + reserved + 4 <= height) {
      const blank = '\x1b[47m' + ' '.repeat(qrWidth) + '\x1b[0m';
      lines.push(blank, blank, ...qr.map(line => '\x1b[47m    ' + line + '\x1b[47m    \x1b[0m'), blank, blank);
    } else if (qr.length && lines.length < height - reserved) {
      lines.push(color(clip(`  Resize for QR (${qrWidth} columns); the same code is shown above.`, width), palette.warning));
    }
    if (view.notice && lines.length < height - 4) lines.push(...wrap(clean(view.notice), Math.max(1, width - 4), Math.max(1, height - lines.length - 4)).map(line => color('  ' + line, view.noticeTone === 'success' ? palette.goalSuccess : palette.warning)));
    while (lines.length < height - 3) lines.push('');
    const cancelRow = lines.length + 1, cancelLeft = width - 10;
    lines.push(replaceCells(color(clip('  ' + clean(this.resolveInput ? this.question : 'Waiting for encrypted transfer'), width - 12), palette.muted), cancelLeft, color(' ← Back ', palette.accent, true), width, this.theme, palette.background));
    const value = this.hidden ? '•'.repeat([...this.value].length) : clean(this.value);
    lines.push(view.actionMode || !this.resolveInput ? '' : color(clip('  › ' + value, width), palette.text), '');
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}${this.theme.foreground(palette.text)}\x1b[2K${lines[row] || ''}\x1b[0m`;
    // Private codes/QRs never enter chat entries, copy regions or frame caches.
    this.hitTargets = [...hits.filter(hit => hit.row < cancelRow && hit.row <= height - 3), { type: 'private-cancel', row: cancelRow, left: cancelLeft + 1, right: cancelLeft + 8 }]; this.textRegion = null; this.scrollbar = null; this.privateFrame = true; this.lastFrame = []; this.lastBackgrounds = [];
    if (this.resolveInput && !view.actionMode) frame += `\x1b[${height - 1};${Math.min(width, 5 + cellWidth(value))}H\x1b[?25h`;
    this.writeFrame(frame);
  }
  renderWorkspaceScene(options) {
    const width = Math.max(16, (this.output.columns || 80) - 1), height = Math.max(8, this.output.rows || 24);
    const privateScene = Boolean(this.ui.privateView || this.ui.settings?.qrView);
    const geometry = workspaceGeometry(width, height, { ...this.workspaceOptions, minimal: this.ui.minimal, chromeOnly: privateScene || this.hidden });
    this.workspace = geometry; this.workspaceRegions = [];
    if (privateScene) { this.workspaceActive = false; this.renderScene(options); return; }
    this.workspaceActive = true; this.sceneDimensions = { width: geometry.center, height: geometry.bodyHeight };
    try { this.renderScene(options); } finally { this.sceneDimensions = null; this.workspaceActive = false; }
    const centerHits = this.hitTargets.map(hit => ({ ...hit, row: hit.row + geometry.y, left: hit.left + geometry.x, right: Math.min(geometry.width, hit.right + geometry.x) }));
    if (this.scrollbar) this.scrollbar = { ...this.scrollbar, top: this.scrollbar.top + geometry.y, thumbTop: this.scrollbar.thumbTop + geometry.y, column: this.scrollbar.column + geometry.x };
    if (this.textRegion) this.textRegion = { ...this.textRegion, top: this.textRegion.top + geometry.y, bottom: this.textRegion.bottom + geometry.y, left: this.textRegion.left + geometry.x, right: this.textRegion.right + geometry.x };
    this.composerLeft = geometry.x; if (this.composerRow) this.composerRow += geometry.y; this.sceneHeaderLength += geometry.y;
    const chrome = workspaceChrome(this, geometry);
    this.lastFrame = chrome.lines; this.hitTargets = [...centerHits, ...chrome.hits].filter(hit => hit.row >= 1 && hit.row <= height && hit.left <= hit.right); this.workspaceRegions = chrome.regions;
  }
  async localChoice(title, choices, options = {}) {
    const reader = this.ui.reader, resolveInput = this.resolveInput, id = this.ui.activeTab || this.ui.sessionId;
    const result = await this.ui.chooseOne(title, choices, { presentation: 'dropdown', ...options });
    if (!this.ui.reader && this.resolveInput === resolveInput && (this.ui.activeTab || this.ui.sessionId) === id) this.ui.reader = reader;
    return (this.ui.activeTab || this.ui.sessionId) === id ? result : null;
  }
  async localAsk(question, options) {
    const id = this.ui.activeTab || this.ui.sessionId;
    const saved = Object.fromEntries(['resolveInput', 'question', 'hidden', 'promptDraft', 'value', 'cursor'].map(key => [key, this[key]]));
    const reader = this.ui.reader;
    try { return await this.ask(question, options); }
    finally {
      if (!this.closed && (this.ui.activeTab || this.ui.sessionId) === id) {
        Object.assign(this, saved); this.ui.reader = reader; this.schedule();
      } else saved.resolveInput?.(null);
    }
  }
  async saveModelWhileWorking() {
    if (this.selection || this.promptDraft || this.hidden || !canControlSession(this.ui)) return;
    const current = loadSession(this.ui.activeTab || this.ui.sessionId);
    if (!current) return;
    try {
      // Naming a tuple writes only private presets: no input claim, execution
      // control or model mutation. Suspend the chat reader while naming it.
      await chooseSavedModel(current, { chooseOne: (...args) => this.localChoice(...args), ask: (...args) => this.localAsk(...args) }, { allowSelection: false });
    } catch (error) { this.notice(error.message, true); }
  }
  async openWorkspaceMenu(kind) {
    if (this.selection || this.promptDraft || this.hidden || this.ui.privateView || this.historyRestoreDepth) return;
    const blocked = this.busy || !canControlSession(this.ui);
    const choices = kind === 'models' ? [
      { value: '/providers @saved', label: 'Saved combinations ▾', description: `${this.provider} · ${this.model} · ${this.effort || 'default'}. Use, name or save this combination.`, disabled: !canControlSession(this.ui) },
      { value: '/providers @provider', label: 'Provider…', disabled: blocked },
      { value: '/models', label: 'Model…', disabled: blocked },
      { value: '/effort', label: 'Reasoning effort…', disabled: blocked || this.modelSelectionRequired },
      { value: '/providers', label: 'Configure provider + model…', disabled: blocked },
    ] : kind === 'live' ? [
      { value: '@agents', label: 'AGENTS · live execution feed' },
      { value: '@http', label: 'HTTP PROBE · observed requests' },
      { value: '@code', label: 'CODE · actual file edits' },
    ] : kind === 'navigation' ? [
      ...workspaceNavigation.map(([label, panel]) => ({ value: ':' + panel, label, selected: this.panel === panel })),
      { value: '/sessions', label: 'Sessions…' }, { value: '/new', label: 'New session' },
      { value: '@models', label: 'Model configuration…' }, { value: '@live', label: 'Live activity…' },
      { value: '@paths', label: 'Session folders…' }, { value: '@usage', label: 'Usage / host…' }, { value: '@actions', label: 'Actions…' }, { value: '/exit', label: 'Exit BZZY' },
    ] : [
      { value: ':chat', label: 'Back to chat' }, { value: '@models', label: 'Model configuration…' },
      { value: '@live', label: 'Live activity…' }, { value: '@paths', label: 'Session folders…' },
      { value: '@right', label: this.workspace?.right ? 'Hide live panels' : 'Show live panels' },
      { value: '@paste', label: 'Paste into draft', disabled: !this.canCompose() },
      { value: '@yolo', label: this.ui.yoloEnabled?.() ? 'Disable YOLO' : 'Enable YOLO', disabled: !canControlSession(this.ui) },
      { value: '/help', label: 'Help and slash commands' }, { value: '@latest', label: 'Jump to latest' }, { value: '@tools', label: this.showTools ? 'Hide tool details' : 'Show tool details' },
      ...(this.busy && canControlSession(this.ui) ? [{ value: '/pause', label: 'Pause session' }, { value: '/cancel', label: 'Cancel session' }] : []),
    ];
    const title = kind === 'models' ? 'MODEL · provider, model and effort' : kind === 'live' ? 'LIVE ACTIVITY' : kind === 'navigation' ? 'NAVIGATION' : 'ACTIONS';
    const chosen = await this.localChoice(title, choices);
    if (!chosen) return;
    if (chosen === '/providers @saved' && this.busy) { await this.saveModelWhileWorking(); return; }
    if (['@models', '@live', '@actions'].includes(chosen)) { await this.openWorkspaceMenu(chosen.slice(1)); return; }
    if (chosen === '@usage') {
      const usage = this.compactorUsage, compactor = usage?.available && Number.isSafeInteger(usage.tokens) ? (usage.complete ? '' : '≥') + usage.tokens.toLocaleString() : 'unavailable';
      const selected = await this.localChoice('USAGE / HOST', { description: this.tokenLabel() + '\nBackground compactor tokens: ' + compactor + '\nUpdates on reported compactor usage; ≥ marks missing or unfinished receipts.\n' + hostMetricsLabel(this.ui.hostMetrics, this.output.columns || 80), descriptionRows: 8, choices: [{ value: 'metrics', label: 'Detailed Metrics' }, { value: 'close', label: 'Close' }] });
      if (selected === 'metrics') this.setPanel('metrics');
    } else if (chosen === '@paths') {
      const cwd = this.ui.sessionWorkingDirectory, memory = this.ui.sessionProjectLocation?.path;
      const value = await this.localChoice('SESSION FOLDERS · click to copy', [
        { value: cwd, label: 'Working directory', description: cwd || 'Unavailable', disabled: !cwd },
        { value: memory, label: 'Session .bzzy', description: memory || 'Unavailable', disabled: !memory },
      ]);
      if (value) this.clipboardTask = this.copySelection(value);
    } else if (chosen === '@paste') this.clipboardTask = this.pasteClipboard();
    else if (chosen === '@right') { this.workspaceOptions.hideRight = Boolean(this.workspace?.right); this.workspaceOptions.showRight = !this.workspaceOptions.hideRight; this.render(); }
    else if (chosen === '@yolo') await this.ui.toggleYolo();
    else if (chosen === '@latest') { this.scroll = 0; this.schedule(); }
    else if (chosen === '@tools') { this.showTools = !this.showTools; this.schedule(); }
    else if (chosen.startsWith('@')) { this.monitor.expanded = chosen.slice(1); this.monitor.detail = null; this.setPanel('monitor'); }
    else if (chosen.startsWith(':')) {
      const panel = chosen.slice(1), command = { skills: '/skills', agents: '/agents', workflows: '/workflow library', goals: '/saved-goals', settings: '/settings' }[panel];
      if (command) this.localCommand(command); else this.setPanel(panel);
    } else this.localCommand(chosen);
  }

  workspaceMouse(button, x, y, released) {
    if (!this.monitor) return false;
    if (released && this.workspaceDrag) { this.workspaceDrag = null; return true; }
    if (released) return false;
    if (this.selection || this.promptDraft || this.ui.privateView || this.hidden) return false;
    const motion = button & 32, wheel = button & 64;
    const region = this.workspaceRegions?.findLast(item => x >= item.left && x <= item.right && y >= item.top && y <= item.bottom);
    if (motion && this.workspaceDrag) {
      const drag = this.workspaceDrag;
      if (drag.kind === 'width') {
        this.workspaceOptions[drag.side] = drag.side === 'left' ? Math.max(23, Math.min(36, x - 1)) : Math.max(28, Math.min(60, this.workspace.width - x));
      } else {
        const weights = this.workspaceOptions.weights ||= [1, 1, 1];
        const delta = (y - drag.y) / Math.max(4, this.workspace.bodyHeight / 3);
        weights[drag.index] = Math.max(.3, Math.min(3, drag.before + delta));
        weights[drag.index + 1] = Math.max(.3, Math.min(3, drag.after - delta));
      }
      this.schedule(); return true;
    }
    if (wheel && (region && !['height', 'width'].includes(region.kind) || this.panel === 'monitor' && this.textRegion && x >= this.textRegion.left && x <= this.textRegion.right && y >= this.textRegion.top && y <= this.textRegion.bottom)) {
      const delta = button & 1 ? 3 : -3;
      if (region?.kind === 'sessions') this.sidebarOffset = Math.max(0, Math.min(this.sidebarMaximum || 0, (this.sidebarOffset || 0) + delta));
      else this.monitor.scroll(region?.kind || this.monitor.expanded, delta);
      this.schedule(); return true;
    }
    if (motion || wheel) return false;
    const hit = this.hitTargets?.findLast(target => y === target.row && x >= target.left && x <= target.right);
    if ((button & 3) === 2 && (region?.kind === 'code' || hit?.type === 'monitor-line')) { void this.monitorMenu('code'); return true; }
    if ((button & 3) !== 0) return false;
    if (region && ['width', 'height'].includes(region.kind)) {
      const weights = this.workspaceOptions.weights || [1, 1, 1];
      this.workspaceDrag = { ...region, y, before: weights[region.index], after: weights[region.index + 1] }; return true;
    }
    if (hit?.type === 'workspace-toggle') {
      if (hit.side === 'left') {
        if (this.workspace.width < 78 || this.workspace.height < 22 || this.ui.minimal) this.menuTask = this.openWorkspaceMenu('navigation');
        else this.workspaceOptions.hideLeft = this.workspace.left > 0;
      } else if (this.workspace.width < 76) this.menuTask = this.openWorkspaceMenu('live');
      else { this.workspaceOptions.hideRight = this.workspace.right > 0; this.workspaceOptions.showRight = !this.workspace.right; }
      this.schedule(); return true;
    }
    if (hit?.type === 'top-monitor') { this.monitor.expanded = 'agents'; this.monitor.detail = null; this.setPanel('monitor'); return true; }
    if (!hit?.type?.startsWith('monitor-')) return false;
    this.feedback(hit);
    if (hit.type === 'monitor-toggle') {
      if (this.monitor.collapsed.has(hit.kind)) this.monitor.collapsed.delete(hit.kind); else this.monitor.collapsed.add(hit.kind);
    } else if (hit.type === 'monitor-expand') { this.monitor.expanded = hit.kind; this.monitor.detail = null; this.setPanel('monitor'); }
    else if (hit.type === 'monitor-menu') { void this.monitorMenu(hit.kind); }
    else if (hit.type === 'monitor-latest') { this.monitor.offsets[hit.kind] = 0; if (hit.kind === 'code') this.monitor.followCode = true; }
    else if (hit.type === 'monitor-follow') { this.monitor.followCode = !this.monitor.followCode; if (this.monitor.followCode) this.monitor.offsets.code = 0; }
    else if (hit.type === 'monitor-detail') { this.monitor.detail = { kind: hit.kind, row: hit.item }; this.monitor.expanded = hit.kind; this.monitor.offsets[hit.kind] = 0; this.setPanel('monitor'); }
    else if (hit.type === 'monitor-line') { this.clipboardTask = this.copySelection(hit.file.lines[hit.index]); }
    else if (hit.type === 'monitor-close') { this.monitor.detail = null; this.setPanel('chat'); }
    else if (hit.type === 'monitor-back') { this.monitor.detail = null; this.monitor.offsets[hit.kind] = 0; }
    this.schedule(); return true;
  }
  async monitorMenu(kind) {
    if (this.selection || this.promptDraft || this.hidden || this.ui.privateView) return;
    if (kind === 'agents') { this.monitor.detail = null; this.monitor.offsets.agents = 0; this.schedule(); return; }
    const sessionId = this.ui.activeTab || this.ui.sessionId, monitor = this.monitor;
    const choices = kind === 'code' ? [...[...monitor.files.values()].reverse().map(file => ({ value: file.key, label: file.path, description: `${this.actors.for(file.actorSessionId, sessionId).label} · ${file.language} · ${file.phase}` })),
      ...(monitor.activeFile ? [{ value: '@copy', label: 'Copy current source' }, { value: '@diff', label: 'Inspect captured edit diff' }] : [])]
      : [{ value: '@capture', label: this.ui.launchCaptureNetwork ? 'Disable shell capture for next run' : 'Enable shell capture for next run', disabled: !canControlSession(this.ui), description: 'Applies to your next message or goal, including its workers. Current processes keep their existing capture settings.' },
        { value: '@coverage', label: 'How HTTP capture works…', description: monitor.captureLabel(this) },
        { value: 'all', label: 'All observed requests' }, { value: 'errors', label: 'Errors (4xx / 5xx)' }, ...['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(value => ({ value, label: value })), { value: '@status', label: 'Sort by status' }, { value: '@time', label: 'Sort by capture time' }, { value: '@history', label: 'Open HTTP history (includes web visits)' }];
    const selected = await this.localChoice(kind === 'code' ? 'Recent source / files' : 'HTTP filters', choices, { presentation: 'dropdown' });
    if ((this.ui.activeTab || this.ui.sessionId) !== sessionId || this.monitor !== monitor) return;
    if (kind === 'code') {
      const file = monitor.files.get(monitor.activeFile);
      if (selected === '@copy' && file) this.clipboardTask = this.copySelection(file.lines.join('\n'));
      else if (selected === '@diff' && file) { monitor.detail = { kind: 'agents', row: { actorId: file.actorSessionId, summary: file.diff || 'No edit diff was exposed by this backend. Changed lines compare the captured source versions.', type: 'source.changed', at: file.observedAt } }; monitor.expanded = 'code'; this.setPanel('monitor'); }
      else if (monitor.files.has(selected)) { monitor.activeFile = selected; monitor.offsets.code = 0; }
    } else if (selected === '@capture' && canControlSession(this.ui)) {
      this.ui.launchCaptureNetwork = !this.ui.launchCaptureNetwork;
      this.ui.captureNetworkOverride = this.ui.launchCaptureNetwork;
      this.notice(`Shell capture ${this.ui.launchCaptureNetwork ? 'enabled' : 'disabled'} for the next execution. Existing processes keep their capture settings.`);
    } else if (selected === '@coverage') {
      await this.localChoice('HTTP PROBE · capture coverage', { description: 'CLI shell capture is enabled by default for new executions in existing or new chats.\nCore HTTP-tool requests appear automatically. Proxy-aware clients are covered; direct sockets and clients ignoring proxy/CA settings are not.\nProvider/model traffic is excluded. Missing historical traffic cannot be recovered. Already-running processes retain their launch environment.', descriptionRows: 12, choices: [{ value: 'close', label: 'Close' }] });
    } else if (selected === '@history') this.setPanel('http');
    else if (selected === '@status' || selected === '@time') monitor.httpSort = selected.slice(1);
    else if (selected) { monitor.httpFilter = selected; monitor.offsets.http = 0; monitor.detail = null; }
    this.schedule();
  }
  renderMonitorScene(width, height, header) {
    const { color } = this.theme, kind = this.monitor.expanded || 'agents';
    const label = ` ${kind === 'http' ? 'HTTP PROBE' : kind.toUpperCase()}  [ ${kind === 'code' ? 'Sources ▾' : kind === 'http' ? 'Filter ▾' : 'Newest first'} ]`;
    const row = header.length + 1;
    header.push(color(clip(label, width - 12), palette.accent, true) + color('  [ Close ]', palette.accent));
    this.hitTargets.push({ type: 'monitor-menu', kind, row, left: 2, right: Math.min(width - 13, cellWidth(label)) }, { type: 'monitor-close', row, left: Math.min(width - 11, cellWidth(label) + 1), right: Math.min(width, cellWidth(label) + 12) });
    if (this.monitor.detail) {
      this.hitTargets.push({ type: 'monitor-back', kind, row: header.length + 1, left: 2, right: width });
      header.push(color(' [ ← Back to feed ]', palette.accent));
    }
    if (kind === 'agents' && this.busy) {
      const controlsRow = header.length + 1;
      header.push(color(' [ Pause session ]  [ Cancel session ]', palette.warning));
      this.hitTargets.push({ type: 'model-control', command: '/pause', row: controlsRow, left: 2, right: 18 }, { type: 'model-control', command: '/cancel', row: controlsRow, left: 21, right: Math.min(width, 39) });
    }
    const file = this.monitor.files.get(this.monitor.activeFile);
    if (kind === 'code' && file && !this.monitor.detail) header.push(color(clip(` ${file.path} · ${this.actors.for(file.actorSessionId, this.ui.sessionId).label} · ${file.language} · ${file.phase}${file.redacted ? ' · redacted' : ''}`, width), palette.tool));
    const available = Math.max(1, height - header.length - 1), layout = this.monitor.rows(kind, width - 2, this);
    const maximum = Math.max(0, layout.lines.length - available); this.monitor.maxima[kind] = maximum; this.monitor.offsets[kind] = Math.min(maximum, this.monitor.offsets[kind]);
    const start = kind === 'agents' ? this.monitor.offsets[kind] : Math.max(0, layout.lines.length - available - this.monitor.offsets[kind]);
    const body = layout.lines.slice(start, start + available); while (body.length < available) body.push('');
    const footer = color(` [ ↓ Latest ]  ${kind === 'code' ? '[ Follow '+ (this.monitor.followCode ? 'ON' : 'OFF') + ' ]' : this.monitor.offsets[kind] ? 'Follow paused' : 'Following'} · scroll ↕`, palette.accent);
    this.hitTargets.push({ type: 'monitor-latest', kind, row: height, left: 2, right: 14 });
    if (kind === 'code') this.hitTargets.push({ type: 'monitor-follow', kind, row: height, left: 16, right: Math.min(width, 31) });
    this.hitTargets.push(...layout.hits.filter(hit => hit.row >= start && hit.row < start + available).map(hit => ({ ...hit, row: header.length + hit.row - start + 1 })));
    this.textRegion = { left: 1, right: width - 1, top: header.length + 1, bottom: height - 1 };
    this.scrollbar = null; this.composerRow = 0;
    this.lastFrame = [...header, ...body, footer].slice(0, height);
  }

  render({ force = false } = {}) {
    if (this.closed || this.outputBlocked || this.copyMode && !force) return;
    if (this.historyRestoreDepth) { this.renderHistoryLoading(); return; }
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
    try { this.renderWorkspaceScene({ force }); }
    finally { this.selection = picker; this.renderingPicker = null; this.writeFrame = writer; }
    if (this.privateFrame) { this.paintedFrame = null; return this.renderScene({ force }); }
    const width = Math.max(16, (this.output.columns || 80) - 1), height = Math.max(8, this.output.rows || 24);
    const lines = (picker?.backgroundFrame || this.lastFrame).slice();
    this.popupRegion = null;
    if (picker) {
      const action = picker.kind === 'effort' ? 'core-effort' : 'core-model', command = picker.kind === 'effort' ? '/effort' : '/providers';
      const presetAction = picker.scope === 'preset-count' ? 'preset-count' : picker.scope?.startsWith('preset:') ? `preset-${picker.kind === 'effort' ? 'effort' : 'model'}:${picker.scope.slice(7)}` : null;
      const defaultModels = picker.scope?.startsWith('defaults:');
      const anchor = picker.anchor || picker.scope === 'chat' && this.modelAnchor || this.hitTargets.find(hit => defaultModels ? hit.type === 'settings' && hit.action === this.settingsFocusedAction
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
  renderHistoryLoading() {
    const loading = this.historyLoading || { count: 0, started: Date.now() }, width = Math.max(16, (this.output.columns || 80) - 1), height = Math.max(8, this.output.rows || 24);
    const elapsed = Math.floor((Date.now() - loading.started) / 1000), key = [width, height, this.frame, loading.count, elapsed].join(':');
    if (this.loadingFrameKey === key) return; this.loadingFrameKey = key;
    const { color } = this.theme, target = loading.session;
    const geometry = workspaceGeometry(width, height, { ...this.workspaceOptions, minimal: this.ui.minimal });
    const center = geometry.center;
    this.lastFrame = [color(clip(' ┌─ Loading saved chat…', center), palette.accent, true),
      color(clip(' ' + (target?.alias || target?.id || 'Saved session'), center), palette.text), '',
      color(clip(` ${spinner[this.frame % spinner.length]} ${loading.count.toLocaleString()} history items loaded · ${elapsed}s`, center), palette.muted)];
    const chrome = workspaceChrome(this, geometry), lines = chrome.lines;
    this.hitTargets = []; this.textRegion = null; this.scrollbar = null;
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}\x1b[2K${lines[row] || ''}\x1b[0m`;
    this.lastFrame = lines; this.paintedFrame = null; this.writeFrame(frame);
  }
  navigationHeader(width) {
    const { color: c } = this.theme;
    this.topBarHasMetrics = true;
    const header = [];
    if (this.aliasEdit) {
      const chars = [...this.aliasEdit.value], label = chars.slice(0, this.aliasEdit.cursor).join('') + '▏' + chars.slice(this.aliasEdit.cursor).join('');
      const controls = ' [Save] [Cancel] ', left = Math.max(2, width - cellWidth(controls));
      header.push(c('│ ' + clip(label, Math.max(1, left - 3)), palette.accent) + ' '.repeat(Math.max(1, left - 2 - cellWidth(clip(label, Math.max(1, left - 3))))) + c(controls, palette.accent));
      this.hitTargets.push({ type: 'alias-save', row: 1, left, right: left + 6 }, { type: 'alias-cancel', row: 1, left: left + 7, right: width });
    } else {
      const label = (this.alias || 'New chat') + '  #' + (this.ui.sessionId || '').slice(0, 6);
      const detail = width >= 42 ? this.activeAgentCount() + ' agents ' : '';
      const available = Math.max(1, width - cellWidth(detail) - 8), name = clip(label, available);
      const line = c('┌', palette.border) + c('≡ ', palette.accent, true) + c('● ', palette.main) + c(name, palette.accent, true)
        + ' '.repeat(Math.max(1, width - cellWidth(name) - cellWidth(detail) - 6)) + c(detail, palette.muted) + c('┐', palette.border);
      header.push(line);
      this.hitTargets.push({ type: 'alias', row: 1, left: 4, right: Math.min(width - 2, cellWidth(name) + 5) },
        { type: 'workspace-toggle', side: 'left', row: 1, left: 2, right: 3 });
    }
    if (this.pinned && !this.ui.minimal && !['settings', 'metrics'].includes(this.panel) && (this.output.rows || 24) >= 18) header.push(c(clip(' ❯ ' + this.pinned, width), palette.user));
    if (this.ui.tabs?.length > 1 && !this.promptDraft) {
      let line = '';
      for (const tab of this.ui.tabs) {
        const text = ' [' + agentLabel(tab.agent) + '] ';
        if (cellWidth(line) + cellWidth(text) > width) break;
        this.hitTargets.push({ type: 'tab', id: tab.id, row: header.length + 1, left: cellWidth(line) + 1, right: cellWidth(line + text) });
        line += c(text, tab.id === this.ui.activeTab ? palette.accent : palette.muted, true);
      }
      if (line) header.push(line);
    }
    const tabs = this.ui.extensions?.tabs(width, header.length + 1, this.theme);
    if (tabs?.hits?.length) { header.push(tabs.line); this.hitTargets.push(...tabs.hits); }
    return header;
  }
  renderExtensionScene(width, height, header) {
    const available = Math.max(0, height - header.length - 2), layout = this.ui.extensions.layout(width - 1, available, this.theme);
    this.hitTargets.push(...layout.hits.map(h => ({ ...h, row: header.length + h.row + 1 })));
    const panelFooter = workspacePanelFooter(this, width), footer = panelFooter.lines[0];
    this.hitTargets.push(...panelFooter.hits.map(hit => ({ ...hit, row: height })));
    const lines = [...header, ...layout.lines, ...Array(Math.max(0, available - layout.lines.length)).fill(''), '', footer].slice(0, height);
    this.textRegion = null; this.scrollbar = null; this.contentHits = []; this.composerRow = 0;
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}\x1b[2K${lines[row] || ''}\x1b[0m`;
    this.lastFrame = lines; this.lastBackgrounds = lines.map(() => palette.background); this.writeFrame(frame);
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
    const width = this.sceneDimensions?.width || Math.max(16, (this.output.columns || 80) - 1), height = this.sceneDimensions?.height || Math.max(8, this.output.rows || 24);
    if (this.panel === 'settings' && !this.promptDraft && !this.selection) {
      if (this.ui.settings?.qrView) this.renderSettingsQR(width, height);
      else this.renderSettings(width, height);
      return;
    }
    const { color } = this.theme;
    const muted = text => color(text, palette.muted), edge = text => color(text, palette.border), accent = text => color(text, palette.accent, true);
    this.hitTargets = [];
    const completions = this.completions();
    const header = this.navigationHeader(width);
    if (this.panel !== 'chat' && this.panel !== 'settings' && !this.promptDraft) {
      this.hitTargets.push({ type: 'back', row: header.length + 1, left: 3, right: 9 });
      header.push(color('  ← Back', palette.accent, true) + color(clip('  ' + this.panel[0].toUpperCase() + this.panel.slice(1), Math.max(0, width - 8)), palette.muted));
    }
    if (this.panel === 'activity' && this.ui.accountStatusEnabled) {
      for (const line of wrapProse(accountStatusLabels(this.ui.accountStatus).map(item => `${item.label}: ${item.value}`).join('  ·  '), width - 4)) header.push(color('  ' + line, palette.muted));
    }
    if (this.mode === 'delegate') {
      header.push(...this.delegateHeader(width));
      const phase = this.busy ? this.delegationPhase || 'Supervisor planning'
        : this.goal?.status === 'complete' ? 'Goal complete' : 'Delegation';
      header.push(color(clip('  ' + phase, width), palette.accent));
      for (const line of wrap(delegationCounters(this.delegationUsage), width - 4)) header.push(color('  ' + line, palette.muted));
    }
    this.sceneHeaderLength = header.length;
    if (this.panel === 'monitor' && !this.promptDraft) { this.renderMonitorScene(width, height, header); return; }
    if (this.panel === 'extension' && !this.promptDraft) { this.renderExtensionScene(width, height, header); return; }
    const composing = this.canCompose();
    const composer = composing ? workspaceComposer(this, width, height, completions) : workspacePanelFooter(this, width);
    let bottom = composer.lines, bottomHits = composer.hits, inputIndex = composer.inputIndex;
    const composerTextLeft = composer.textLeft, composerOffset = composer.offset;
    const composerBackgroundTop = composer.backgroundTop, composerBackgroundBottom = composer.backgroundBottom;
    // Keep the host header in place; constrained terminals spend their
    // remaining rows on the current screen and composer.
    const overflow = Math.max(0, header.length + bottom.length - height);
    if (overflow) bottom.splice(Math.max(0, bottom.length - overflow), overflow);
    let bodyHeight = Math.max(0, height - header.length - bottom.length);
    const metricsAtTop = this.panel === 'metrics' && this.scroll >= (this.scrollbar?.maximum || 0);
    this.selectionHeight = bodyHeight;
    const contentWidth = width - 2;
    const roomLabels = this.panel === 'room' ? JSON.stringify([this.peers.map(peer => [peer.sessionId || peer.id, peer.namespace || peer.agent]), this.ui.tabs?.map(tab => [tab.id, tab.agent])]) : '';
    const contentKey = `${['skills', 'agents', 'workflows', 'goals'].includes(this.panel) ? Date.now() : this.panel === 'metrics' ? this.ui.sessionMetrics?.revision : ''}:${contentWidth}:${this.panel}:${this.showTools}:${this.contentRevision || 0}:${roomLabels}`;
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
    if (this.panel === 'goals' && !this.selection) {
      if (this.goalTopRequested) { this.scroll = Math.max(0, body.length - bodyHeight); this.goalTopRequested = false; }
      if (this.goalEnsureFocus) {
        const start = Math.max(0, body.length - this.scroll - bodyHeight), focus = this.goalFocusRow || 0;
        if (focus < start) this.scroll = Math.max(0, body.length - bodyHeight - focus);
        else if (focus >= start + bodyHeight) this.scroll = Math.max(0, body.length - focus - 1);
        this.goalEnsureFocus = false;
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
    for (const hit of this.contentHits) if (hit.row >= start && hit.row < end) this.hitTargets.push({ ...hit, row: header.length + hit.row - start + 1 });
    for (const hit of bottomHits) this.hitTargets.push({ ...hit, row: header.length + bodyHeight + hit.row + 1 });
    this.composerRow = composing ? header.length + bodyHeight + inputIndex + 1 : 0;
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
      const background = composing && row >= composerTop && row <= composerBottom
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
