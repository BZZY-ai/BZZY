import readline from 'node:readline';
import { clean, cellWidth, clip, wrap, duration } from './terminal-format.js';
import { mascotCells, mascotLine } from './mascot.js';
import { commandSuggestions, privateChatCommand } from './terminal-commands.js';
import { backendVisit } from './backend-traffic.js';
import { accountStatusLabels } from './account-status.js';
import { copyText, readClipboard } from './clipboard.js';
import { palette, createTerminalTheme } from './terminal-theme.js';
import { messageBodyToPlainText, parseMessageBody } from '@bzzy/core/message-format';
import { renderMessageContent } from './message-renderer.js';
import { hostMetricsLabel } from './host-metrics.js';

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const animationInterval = 1000 / 60;
const mouseOn = '\x1b[?1000h\x1b[?1002h\x1b[?1006h', mouseOff = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

export class TerminalChat {
  constructor(ui) {
    this.ui = ui; this.input = ui.input; this.output = ui.output;
    this.theme = createTerminalTheme(this.output);
    this.entries = []; this.activities = []; this.traffic = []; this.sharedRoom = []; this.panel = 'chat'; this.scroll = 0;
    this.assignments = new Map();
    this.value = ''; this.cursor = 0; this.history = []; this.historyIndex = 0; this.drafts = new Map();
    this.entryLayouts = new WeakMap(); this.inputQueue = [];
    this.state = 'ready'; this.model = 'default'; this.provider = ''; this.frame = 0; this.lastFrame = [];
    this.animationTime = 0; this.animationStarted = performance.now();
    this.wasRaw = Boolean(this.input.isRaw);
    this.output.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?2004h' + mouseOn);
    readline.emitKeypressEvents(this.input, { escapeCodeTimeout: 50 }); this.input.setRawMode?.(true); this.input.resume();
    this.onKey = (text, key) => this.key(text, key || {});
    this.input.on('keypress', this.onKey);
    this.onResize = () => { this.textSelection = null; if (this.copyMode) this.setCopyMode(false); this.lastFrame = []; this.render(); };
    this.output.on?.('resize', this.onResize);
    this.onDrain = () => { this.outputBlocked = false; this.lastFrame = []; this.schedule(); };
    this.output.on?.('drain', this.onDrain);
    this.onExit = () => this.restore(); process.once('exit', this.onExit);
    this.render();
    this.startAnimation();
  }

  startAnimation() {
    let deadline = performance.now() + animationInterval;
    const tick = () => {
      if (this.closed) return;
      const instant = performance.now(), previous = this.frame;
      this.animationTime = (instant - this.animationStarted) / 1000; this.frame = Math.floor(this.animationTime * 10);
      if (!this.copyMode && !this.outputBlocked) {
        if (previous !== this.frame && (this.busy || this.selection?.loading)) this.schedule();
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
    if (!region || this.copyMode || this.textSelection || this.outputBlocked || this.closed) return;
    const next = mascotCells(this.animationTime, { columns: region.columns, rows: region.rows, compact: true });
    let output = '';
    for (let row = 0; row < next.length; row++) {
      const changed = column => next[row][column].text !== this.eyeCells[row][column].text || next[row][column].tone !== this.eyeCells[row][column].tone;
      for (let column = 0; column < region.columns;) {
        if (!changed(column)) { column++; continue; }
        const start = column++;
        while (column < region.columns && changed(column)) column++;
        output += `\x1b[${region.top + row};${region.left + start}H` + mascotLine(next[row].slice(start, column), this.theme);
      }
      if (!this.privateFrame) this.lastFrame[region.top + row - 1] = ' '.repeat(region.left - 1) + mascotLine(next[row], this.theme) + region.suffixes[row];
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
    this.model = session.resolvedModel || session.model || 'default';
    this.effort = session.selectedEffort === 'default' ? 'effort default' : session.selectedEffort || session.reasoningEffort || '';
    this.cwd = session.projectRoot || session.cwd || this.cwd;
    this.alias = session.alias || '';
    this.goal = session.goal;
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
    if (!this.pinned && session.goal?.objective) this.pinned = session.goal.objective;
    this.schedule();
  }

  add(kind, text, extra = {}) {
    this.contentRevision = (this.contentRevision || 0) + 1;
    const entry = { kind, text: kind === 'assistant' ? String(text ?? '') : clean(text), ...extra }; this.entries.push(entry);
    if (this.entries.length > 5000) this.entries.splice(0, 500);
    return entry;
  }
  event(type, data) {
    this.contentRevision = (this.contentRevision || 0) + 1;
    if (type === 'text' || type === 'peer.text') {
      const peerSessionId = type === 'peer.text' ? data.childSessionId || data.sessionId || data.agent : null;
      const label = type === 'peer.text' ? data.agent || peerSessionId || 'Agent' : 'bzzy';
      // Peer chunks can interleave. Stable response IDs keep one complete entry
      // per reply so its copy button includes chunks received between peers.
      const previous = peerSessionId && data.itemId ? this.entries.findLast(entry => entry.kind === 'assistant' && entry.peerSessionId === peerSessionId && entry.itemId === data.itemId && entry.turnId === data.turnId)
        : this.entries.at(-1);
      if (previous?.kind === 'assistant' && previous.label === label && previous.peerSessionId === peerSessionId && previous.itemId === data.itemId && previous.turnId === data.turnId) previous.text += String(data.text ?? '');
      else this.add('assistant', data.text, { label, peerSessionId, itemId: data.itemId, turnId: data.turnId });
      this.streaming = true;
    } else if (type === 'message.user') {
      this.pinned = (data.kind === 'goal' ? '/goal ' : '') + clean(data.text); this.add('user', data.text, { goal: data.kind === 'goal', channel: data.channel }); this.streaming = false; this.scroll = 0;
      if (this.mode === 'delegate') this.delegationPhase = 'Supervisor planning';
    } else if (['peer.message', 'peer.sent', 'peer.review'].includes(type)) {
      this.recordRoomEvent(type, data);
    } else if (type === 'question') this.add('question', data.question);
    else if (type === 'question.answered') this.add('user', data.answer);
    else if (type === 'tool') {
      this.currentTool = `${data.name}${data.detail ? ' · ' + clean(data.detail).slice(0, 250) : ''}`;
      this.add('tool', this.currentTool); this.streaming = false;
    } else if (type === 'activity') {
      const worker = this.mode === 'delegate' && data.sessionId && data.sessionId !== (this.ui.activeTab || this.ui.sessionId);
      this.currentActivity = data.closedAt ? '' : (worker ? 'Hands · ' : '') + data.summary;
      if (worker && !data.closedAt && data.status === 'running') this.delegationPhase = 'Executor running';
      const index = this.activities.findIndex(item => item.id && item.id === data.id);
      if (index >= 0) this.activities[index] = data; else this.activities.push(data);
    } else if (type.startsWith('assignment.') && this.mode === 'delegate') {
      this.assignmentEvent(type, data);
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
    else if (type === 'summary') { this.add(data.status === 'complete' ? 'success' : 'notice', data.message); this.busy = false; if (['besties', 'parallel'].includes(this.mode) && data.usage) this.acceptGroupUsage(data.usage); }
    else if (type === 'error' || type === 'control.failed') this.add('error', data.message);
    else if (type === 'worker.progress') {
      if (data.type === 'error') this.add('error', `${this.mode === 'delegate' ? 'Hands' : 'Agent'} · ${data.agent || data.workerSessionId?.slice(0, 8) || 'worker'}: ${data.message}`);
      if (data.type === 'tool' && this.mode === 'delegate') this.delegationPhase = 'Executor running';
    }
    else if (type === 'debate.message') this.add('assistant', data.text, { label: `${data.participant} · ${data.role}${data.round ? ` · round ${data.round}/${data.maxRounds}` : ''}` });
    else if (type === 'debate.result') this.add(data.status === 'complete' ? 'success' : 'notice', data.message);
    else if (type === 'info' && data.message) this.add('notice', data.message, { welcome: Boolean(data.welcome) });
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

  clear() { this.entries = []; this.activities = []; this.traffic = []; this.sharedRoom = []; this.assignments.clear(); this.delegationPhase = null; this.delegationUsage = null; this.groupUsage = null; this.textSelection = null; this.pinned = ''; this.scroll = 0; this.streaming = false; this.currentActivity = ''; this.currentTool = ''; this.tokens = undefined; this.startedAt = null; this.finishedAt = null; this.bodyCache = null; this.schedule(); }
  selectTab(previous, next) {
    if (previous === next) return;
    this.textSelection = null;
    if (previous) this.drafts.set(previous, { value: this.value, cursor: this.cursor });
    const draft = this.drafts.get(next) || { value: '', cursor: 0 };
    Object.assign(this, draft); this.schedule();
  }
  ask(question, { hidden = false } = {}) {
    const queued = !hidden && /^bzzy\b/.test(question) ? this.inputQueue.findIndex(item => item.sessionId === (this.ui.activeTab || this.ui.sessionId)) : -1;
    if (queued >= 0) return Promise.resolve(this.inputQueue.splice(queued, 1)[0].text);
    return new Promise(resolve => {
      this.question = clean(question); this.hidden = hidden; this.resolveInput = resolve;
      if (hidden || !/^bzzy\b/.test(this.question)) { this.promptDraft = { value: this.value, cursor: this.cursor }; this.value = ''; this.cursor = 0; }
      this.ui.reader = { close: () => this.finish(null), setPrompt: text => { this.question = clean(text); }, prompt: () => this.schedule() };
      this.schedule();
    });
  }
  chooseMany(title, choices) {
    this.textSelection = null;
    return new Promise(resolve => {
      this.selection = { title, choices, selected: new Set(choices.filter(choice => choice.selected).map(choice => choice.value)), focus: 0, resolve };
      this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule();
    });
  }
  chooseOne(title, choices) {
    this.textSelection = null;
    return new Promise(resolve => {
      const picker = { title, choices: [], focus: 0, resolve, single: true, loading: true };
      this.selection = picker; this.ui.reader = { close: () => this.finishSelection(null) }; this.schedule();
      Promise.resolve(choices).then(result => {
        if (this.selection !== picker) return;
        picker.choices = Array.isArray(result) ? result : result.choices;
        picker.description = result.description || '';
        picker.descriptionRows = Math.min(4, result.descriptionRows || 2);
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
  finishSelection(value) { const selection = this.selection; if (!selection) return; this.selection = null; this.ui.reader = null; selection.resolve(value); this.schedule(); }
  finish(answer) {
    const resolve = this.resolveInput; if (!resolve) return;
    this.resolveInput = null; this.ui.reader = null;
    if (answer != null && !this.hidden && !this.promptDraft && answer.trim() && !privateChatCommand(answer)) { this.history.push(answer); this.historyIndex = this.history.length; }
    if (this.promptDraft) { Object.assign(this, this.promptDraft); this.promptDraft = null; }
    else if (answer != null) { this.value = ''; this.cursor = 0; }
    this.hidden = false; resolve(answer); this.schedule();
  }
  canCompose() { return this.panel === 'settings' && !this.promptDraft ? false : Boolean(this.resolveInput || this.ui.sessionId && !this.hidden && !this.selection && !this.promptDraft); }
  submitMessage() {
    if (this.resolveInput) { this.finish(this.value); return; }
    if (!this.value.trim()) return;
    this.inputQueue.push({ sessionId: this.ui.activeTab || this.ui.sessionId, text: this.value });
    if (!privateChatCommand(this.value)) this.history.push(this.value);
    this.historyIndex = this.history.length;
    this.value = ''; this.cursor = 0; this.schedule();
  }
  completions() {
    if (this.panel === 'settings') return [];
    if (!this.resolveInput || this.hidden || this.selection || this.pasting || !/^bzzy\b/.test(this.question || '')) return [];
    if (this.completionQuery !== this.value) { this.completionQuery = this.value; this.completionFocus = 0; this.completionDismissed = false; }
    return this.completionDismissed ? [] : commandSuggestions(this.value);
  }
  completeCommand(choice) { this.value = choice.command + ' '; this.cursor = [...this.value].length; this.schedule(); }
  panels() { return this.mode === 'besties' || this.bestiesGroupId || this.sharedRoom.length ? ['chat', 'room', 'activity', 'http', 'sessions', 'settings'] : ['chat', 'activity', 'http', 'sessions', 'settings']; }
  setPanel(panel) {
    if (this.ui.coreLifecycleInterrupted && panel !== 'settings') return;
    if (this.promptDraft || this.selection) return;
    if (panel === 'room' && !this.panels().includes('room')) { this.ui.event('info', { message: 'The shared room is available in a besties conversation. Start with bzzy --besties.' }); return; }
    if (panel === 'settings' && !this.ui.settings) { this.ui.openSettings(); return; }
    if (panel === 'sessions' && this.ui.onSessions?.() === false) return;
    if (this.settingsDraft && panel !== 'settings' && !this.promptDraft) { Object.assign(this, this.settingsDraft); this.settingsDraft = null; }
    if (panel === 'settings' && this.panel !== 'settings') { this.settingsDraft = { value: this.value, cursor: this.cursor }; this.value = ''; this.cursor = 0; }
    this.settingsEnsureFocus = panel === 'settings';
    this.textSelection = null; this.panel = panel; this.scroll = 0; this.schedule();
  }
  settingsAction(action) {
    if (!this.resolveInput || this.ui.settings?.busy || this.promptDraft || this.selection) return;
    this.ui.settings.focusAction(action);
    // Dispatch through the normal client loop, never a model conversation.
    this.finish(`/settings ${action}`);
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
        if (!this.selection.loading && this.selection.choices.length) this.selection.focus = Math.max(0, Math.min(this.selection.choices.length - 1, this.selection.focus + delta));
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
    if (motion || (button & 3) !== 0) return;
    this.textSelection = null;
    const bar = this.scrollbar;
    if (bar?.maximum && x === bar.column && y >= bar.top && y < bar.top + bar.height) {
      this.scrollDrag = y >= bar.thumbTop && y < bar.thumbTop + bar.thumbHeight ? y - bar.thumbTop : Math.floor(bar.thumbHeight / 2);
      const fraction = Math.max(0, Math.min(1, (y - bar.top - this.scrollDrag) / Math.max(1, bar.height - bar.thumbHeight)));
      this.scroll = Math.round((1 - fraction) * bar.maximum); this.schedule(); return;
    }
    const hit = this.hitTargets?.findLast(target => y === target.row && x >= target.left && x <= target.right);
    if (hit?.type === 'panel') this.setPanel(hit.panel);
    else if (hit?.type === 'settings') this.settingsAction(hit.action);
    else if (hit?.type === 'copy-response') { this.clipboardTask = this.copySelection(clean(messageBodyToPlainText(hit.entry.text))); }
    else if (hit?.type === 'tab') this.ui.onSelectTab?.(hit.id);
    else if (hit?.type === 'command') this.completeCommand(hit.choice);
    else if (hit?.type === 'choice' && this.selection && !this.selection.loading) {
      this.selection.focus = hit.index;
      if (!this.selection.single) {
        const value = this.selection.choices[hit.index].value;
        if (this.selection.selected.has(value)) this.selection.selected.delete(value); else this.selection.selected.add(value);
      }
      this.schedule();
    } else if (hit?.type === 'effort' && this.selection) { this.selection.focus = hit.index; this.key('', { name: hit.direction }); }
    else if (hit?.type === 'confirm') this.key('', { name: 'return' });
    else if (hit?.type === 'cancel') this.key('', { name: 'escape' });
    else if (this.resolveInput && !this.selection && y === this.composerRow) {
      const cells = Math.max(0, x - 3) + (this.composerOffset || 0), chars = [...this.value];
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
  key(text, key) {
    if (this.ui.privateView && !this.resolveInput) {
      key.bzzyHandled = true;
      if (key.name === 'escape' || key.ctrl && key.name === 'c') this.ui.privateView.onCancel?.();
      return;
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
    if (this.copyMode) { if (key.name === 'escape' || key.ctrl && key.name === 's') this.setCopyMode(false); return; }
    if (this.panel === 'settings' && this.ui.settings?.qrView && !this.promptDraft) {
      key.bzzyHandled = true;
      if (key.name === 'escape' || key.name === 'return') { this.ui.settings.qrView = false; this.lastFrame = []; this.schedule(); }
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
      else if (key.name === 'up' || key.name === 'down') picker.focus = (picker.focus + (key.name === 'up' ? picker.choices.length - 1 : 1)) % picker.choices.length;
      else if (picker.selectEffort && (key.name === 'left' || key.name === 'right')) {
        const choice = picker.choices[picker.focus];
        if (choice.efforts?.length) {
          const efforts = ['default', ...choice.efforts], index = Math.max(0, efforts.indexOf(picker.efforts.get(choice.value)));
          picker.efforts.set(choice.value, efforts[(index + (key.name === 'left' ? efforts.length - 1 : 1)) % efforts.length]);
        }
      }
      else if (key.name === 'space' && !picker.single) { const value = picker.choices[picker.focus].value; if (picker.selected.has(value)) picker.selected.delete(value); else picker.selected.add(value); }
      else if (key.name === 'return') {
        if (picker.single) {
          const choice = picker.choices[picker.focus];
          if (choice.disabled) { picker.error = choice.description || 'This option is not available yet.'; this.schedule(); return; }
          this.finishSelection(picker.selectEffort ? { value: choice.value, effort: picker.efforts.get(choice.value) } : choice.value);
        } else if (picker.selected.size) this.finishSelection([...picker.selected]); else picker.error = 'Select at least one agent.';
      }
      this.schedule(); return;
    }
    if (key.name === 'paste-start') { this.pasting = true; return; }
    if (key.name === 'paste-end') { this.pasting = false; return; }
    if (key.name === 'pageup' || key.name === 'pagedown') {
      if (this.panel === 'settings' && !this.promptDraft) { this.settingsOffset = Math.max(0, Math.min(this.settingsMaximum || 0, (this.settingsOffset || 0) + (key.name === 'pageup' ? -8 : 8))); this.settingsEnsureFocus = false; }
      else this.scroll = Math.max(0, this.scroll + (key.name === 'pageup' ? 8 : -8));
      this.schedule(); return;
    }
    if (key.ctrl && key.name === 'g') { const panels = this.panels(); this.setPanel(panels[(panels.indexOf(this.panel) + 1) % panels.length]); return; }
    if (key.ctrl && key.name === 'o') { this.showTools = !this.showTools; this.schedule(); return; }
    if (key.ctrl && key.name === 'l') { this.lastFrame = []; this.schedule(); return; }
    if (key.ctrl && key.name === 'c') {
      if (!this.promptDraft && process.listenerCount('SIGINT')) process.emit('SIGINT'); else this.finish(null);
      return;
    }
    if (key.name === 'escape' && this.promptDraft) { this.finish(null); return; }
    if (this.panel === 'settings' && !this.promptDraft) {
      key.bzzyHandled = true;
      if (key.name === 'escape') { if (this.ui.settings.back()) return; if (this.ui.settingsOnly) this.finish(null); else this.setPanel('chat'); return; }
      if (key.name === 'home' || key.name === 'end') { this.settingsOffset = key.name === 'home' ? 0 : this.settingsMaximum || 0; this.settingsEnsureFocus = false; this.schedule(); return; }
      const actions = this.ui.settings.rows().filter(row => row.action);
      if (key.name === 'up' || key.name === 'down' || key.name === 'tab') {
        const direction = key.name === 'up' || key.name === 'tab' && key.shift ? -1 : 1;
        this.ui.settings.focus = (this.ui.settings.focus + direction + actions.length) % actions.length; this.settingsEnsureFocus = true; this.schedule();
      } else if (key.name === 'return') this.settingsAction(actions[this.ui.settings.focus]?.action);
      return;
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
      if (!this.hidden && /^bzzy\b/.test(this.question || '') && this.value.trim() === '/usage') { this.value = ''; this.cursor = 0; this.ui.showAccountStatus(); return; }
      if (!this.hidden && /^bzzy\b/.test(this.question || '') && this.value.trim() === '/copy') { this.value = ''; this.cursor = 0; this.setCopyMode(true); return; }
      const panel = /^bzzy\b/.test(this.question || '') && !this.hidden && /^\/(chat|room|activity|http|sessions|settings)$/.exec(this.value.trim())?.[1];
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
      if (picker.loading) put('  ' + spinner[this.frame % spinner.length] + ' Loading available models…', palette.accent);
      const warning = picker.warning ? wrap(picker.warning, width - 5).slice(0, compact ? 1 : 2) : [];
      for (const line of warning) put('  ' + line, palette.warning);
      const focused = picker.choices[picker.focus];
      const effortDetail = picker.selectEffort ? focused?.efforts?.length ? `Effort: ${picker.efforts.get(focused.value)}${focused.defaultEffort ? ` · provider default: ${focused.defaultEffort}` : ''}. ` : focused?.supportsEffort === false ? 'This model has no effort setting. ' : '' : '';
      const details = picker.single ? effortDetail + (focused?.description || picker.description || '') : 'Every participant reviews the same fixed reply independently.';
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
      this.contentHits.push({ type: 'confirm', row: lines.length, left: 3, right: 13 }, { type: 'cancel', row: lines.length, left: 17, right: 26 });
      put('  [ Confirm ]   [ Cancel ]', palette.accent);
    } else if (this.panel === 'settings') {
      const rows = this.ui.settings.rows(), actions = rows.filter(row => row.action);
      this.ui.settings.focus = Math.max(0, Math.min(this.ui.settings.focus, actions.length - 1));
      let index = 0;
      for (const row of rows) {
        const focused = row.action && index === this.ui.settings.focus;
        const wrapped = wrap((row.action ? focused ? '› ' : '  ' : '') + row.text, width - 4);
        if (row.action) {
          if (focused) this.settingsFocusRow = lines.length;
          for (let offset = 0; offset < wrapped.length; offset++) this.contentHits.push({ type: 'settings', action: row.action, row: lines.length + offset, left: 2, right: width });
          index++;
        }
        for (const line of wrapped) put('  ' + line, palette[row.tone], Boolean(focused));
      }
    } else if (this.panel === 'room') {
      for (const item of this.sharedRoom) {
        const review = item.kind === 'review';
        const sender = this.peerLabel(review ? item.reviewer : item.from), recipient = this.peerLabel(review ? item.peerSessionId : item.to);
        const caption = review ? `${sender} · review: ${clean(item.assessment || 'recorded')}` : `${sender} → ${recipient}`;
        const label = clip(caption, width - 8), left = cellWidth('  ' + label + '  ') + 1;
        this.contentHits.push({ type: 'copy-response', entry: item.copyEntry, row: lines.length, left, right: left + 2 });
        put(`  ${label}  [c]`, review && item.assessment === 'disputed' ? palette.warning : palette.accent, true);
        const time = String(item.createdAt || item.occurredAt || '').replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
        const refs = (Array.isArray(item.evidence) ? item.evidence : []).map(id => clean(id).slice(0, 8)).join(', ');
        if (time) put('  ' + time, palette.muted);
        for (const line of wrap(review ? item.rationale || '' : item.text || '', width - 5)) put('  ' + line);
        if (review) for (const line of wrap(`Reviewing ${recipient} · message ${clean(item.messageId || '').slice(0, 8)} · peer judgment`, width - 5)) put('  ' + line, palette.muted);
        if (refs) for (const line of wrap(`Evidence: ${refs}`, width - 5)) put('  ' + line, palette.accent);
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
        if (layout.copyLeft != null) this.contentHits.push({ type: 'copy-response', entry, row: lines.length, left: layout.copyLeft, right: layout.copyLeft + 2 });
        for (const line of layout.lines) lines.push(line);
      }
    }
    return lines;
  }

  entryLayout(entry, width) {
    const cached = this.entryLayouts.get(entry);
    if (cached?.width === width && cached.text === entry.text) return cached;
    const { color } = this.theme;
    const lines = [], put = (text, tone = palette.text, bold = false) => lines.push(color(text, tone, bold));
    let copyLeft;
    if (entry.kind === 'notice') { for (const line of wrap(entry.text, width - 5)) put('  · ' + line, palette.muted); put(''); }
    else if (entry.kind === 'tool') put('  › ' + clip(entry.text, width - 5), palette.muted);
    else {
      // Keep the original body for replay and copying; derive presentation only
      // after a complete valid root is available. Incomplete markup stays text.
      const projection = entry.kind === 'assistant' ? parseMessageBody(entry.text) : null;
      const displayText = clean(projection ? projection.plainText : entry.text);
      const isFormatted = Boolean(projection?.isFormatted);
      const tone = ['error', 'question'].includes(entry.kind) ? palette.warning : palette.accent;
      const label = entry.kind === 'user' ? 'YOU' + (entry.goal ? '  /goal' : '') : entry.kind === 'assistant' ? entry.label || 'bzzy' : entry.kind === 'question' ? 'YOUR INPUT IS NEEDED' : entry.kind.toUpperCase();
      const displayLabel = entry.kind === 'assistant' ? clip(label, width - 9) : label;
      if (entry.kind === 'assistant') copyLeft = cellWidth('  ' + displayLabel + '  ') + 1;
      if (isFormatted) {
        put(`  ${displayLabel}  [c]`, tone, true);
        const rendered = renderMessageContent(projection, { width: width - 5, theme: this.theme, background: palette.background });
        for (const line of rendered.lines) lines.push('  ' + line);
        put('');
        const layout = { width, text: entry.text, lines, copyLeft, displayText, isFormatted };
        this.entryLayouts.set(entry, layout); return layout;
      }
      const append = entry.kind === 'assistant' && cached?.width === width && cached.rawLines && isFormatted === cached.isFormatted && displayText.startsWith(cached.displayText);
      // Only the final wrapped line can change when a response receives a delta.
      // Keep older Unicode/Markdown lines as well as completed replies cached.
      const tail = wrap(append ? cached.rawLines.at(-1) + displayText.slice(cached.displayText.length) : displayText, width - 5);
      const rawLines = append ? [...cached.rawLines.slice(0, -1), ...tail] : tail;
      if (append) for (const line of cached.lines.slice(0, -2)) lines.push(line);
      else put(`  ${displayLabel}${entry.kind === 'assistant' ? '  [c]' : ''}`, tone, true);
      for (const line of tail) {
        const text = isFormatted ? line : line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/^#{1,6}\s+/, '');
        put('  ' + text, entry.kind === 'error' ? palette.warning : palette.text, !isFormatted && /^#{1,6}\s/.test(line));
      }
      put('');
      const layout = { width, text: entry.text, lines, copyLeft, rawLines, displayText, isFormatted };
      this.entryLayouts.set(entry, layout); return layout;
    }
    const layout = { width, text: entry.text, lines, copyLeft };
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
    const context = this.mode === 'delegate' && this.executor ? `Hands: ${this.executor.provider} · ${this.executor.model || 'default'} · ${this.executor.effort || 'default'}`
      : this.mode === 'besties' || this.bestiesGroupId ? 'Besties · shared evidence, messages and peer reviews' : 'Type / for commands';
    const directory = this.cwd || 'Your project, your agent.';
    let text = [brand, muted(clip(this.alias ? `${this.alias} · ${directory}` : directory, textWidth)), muted(clip(context, textWidth))];
    if (compact) {
      const controlWidth = cellWidth(controls), modelSpace = Math.max(1, textWidth - controlWidth - 2);
      brand = color(clip(`bzzy / ${provider} · ${this.model}`, modelSpace), palette.accent, true);
      this.compactControlLeft = left + (eyeRows ? eyeWidth + gap : 0) + cellWidth(brand) + 3;
      text = [brand + (controls ? muted('  ' + controls) : ''), muted(clip(this.tokenLabel() + ' · ' + hostMetricsLabel(this.ui.hostMetrics, Math.min(64, textWidth)), textWidth))];
    }
    const header = [];
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
    } else header.push(...text.slice(0, 2).map(line => ' '.repeat(left) + line));
    if (compact) return header.map(line => cellWidth(line) > width ? color(clip(line, width), palette.text) : line);
    if (height >= 24) header.push('');
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
    const title = settings.page === 'approve' ? 'Confirm iPhone' : settings.page === 'pair' ? 'Pair iPhone' : settings.page === 'core' ? 'BZZY Core' : 'Settings';
    const header = this.persistentHeader(width, height);
    header.push(color(clip('  ' + title, width), palette.accent, true));
    const compact = height - header.length < 16;
    if (!compact) header.push('');
    const footer = compact ? [] : [''];
    if (settings.busy) footer.push(color('  Working…', palette.muted));
    if (settings.message) for (const line of wrap(settings.message, width - 4, 3)) footer.push(color('  ' + line, settings.warning ? palette.warning : palette.accent));
    const exit = settings.page !== 'main' ? 'back' : this.ui.settingsOnly ? 'close' : 'chat';
    if (!compact) footer.push('');
    footer.push(color(clip('  ↑/↓ choose   Enter open   Esc ' + exit, width), palette.muted));
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
    const lines = [...header, ...visible, ...footer];
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) {
      const line = lines[row] || '';
      frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}${this.theme.foreground(palette.text)}\x1b[2K${line}\x1b[0m`;
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
    } else {
      lines.push(color(clip('  Pair iPhone', width), palette.accent, true), '');
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
    lines.push(color(clip('  ' + clean(this.resolveInput ? this.question : 'Waiting for encrypted transfer · Esc cancels'), width), palette.muted));
    const value = this.hidden ? '•'.repeat([...this.value].length) : clean(this.value);
    lines.push(color(clip('  › ' + value, width), palette.text), '');
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) frame += `\x1b[${row + 1};1H${this.theme.background(palette.background)}${this.theme.foreground(palette.text)}\x1b[2K${lines[row] || ''}\x1b[0m`;
    // Private codes/QRs never enter chat entries, copy regions or frame caches.
    this.hitTargets = []; this.textRegion = null; this.scrollbar = null; this.privateFrame = true; this.lastFrame = []; this.lastBackgrounds = [];
    if (this.resolveInput) frame += `\x1b[${height - 1};${Math.min(width, 5 + cellWidth(value))}H\x1b[?25h`;
    this.writeFrame(frame);
  }
  render({ force = false } = {}) {
    if (this.closed || this.outputBlocked || this.copyMode && !force) return;
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
    const pinned = this.pinned && this.panel !== 'settings' ? wrap(this.pinned, width - 5, maximumPinned + 1) : [];
    const sessionLabel = this.ui.sessionId ? `Session: ${this.ui.sessionId} · ${this.ui.sessionMode}` : 'Setup · no work started';
    const header = this.persistentHeader(width, height);
    if (pinned.length) {
      header.push(color('  YOU ASKED', palette.accent, true));
      for (const [index, line] of pinned.slice(0, maximumPinned).entries()) header.push(color('  │ ' + clip(line + (index === maximumPinned - 1 && pinned.length > maximumPinned ? ' …' : ''), width - 5), palette.accent));
      header.push(edge('─'.repeat(width)));
    }
    const bottom = [edge('─'.repeat(width))];
    if (this.mode === 'delegate') {
      const phase = this.busy ? this.delegationPhase || 'Supervisor planning' : this.goal?.status === 'complete' ? 'Goal complete' : 'Delegation';
      bottom.push(color('  ' + clip(phase + ' · ' + delegationCounters(this.delegationUsage), width - 3), palette.accent));
    }
    const bottomHits = [];
    if (this.busy && (this.currentTool || this.currentActivity)) bottom.push(muted('  ' + clip(this.currentTool || this.currentActivity, width - 3)));
    if (completions.length) {
      const maximum = height < 28 ? 3 : 6, offset = Math.max(0, Math.min(this.completionFocus - Math.floor(maximum / 2), completions.length - maximum));
      bottom.push(muted('  Commands · ↑/↓ choose · Tab complete · Esc close'));
      for (let index = offset; index < Math.min(completions.length, offset + maximum); index++) {
        const item = completions[index];
        bottomHits.push({ type: 'command', choice: item, row: bottom.length, left: 3, right: width - 1 });
        bottom.push(color(`  ${index === this.completionFocus ? '›' : ' '} ${item.command.padEnd(18)}${clip(item.description, width - 25)}`, index === this.completionFocus ? palette.accent : palette.muted, index === this.completionFocus));
      }
    }
    const prompt = this.panel === 'settings' && !this.promptDraft ? 'Settings' : !this.resolveInput || /^(bzzy\b)/.test(this.question || '') ? 'Message' : clip(this.question || 'Message', width - 6);
    bottom.push(edge('╭─ ') + color(prompt, palette.text, true) + edge(' ' + '─'.repeat(Math.max(0, width - cellWidth(prompt) - 5)) + '╮'));
    const visibleValue = this.hidden ? '•'.repeat([...this.value].length) : this.value.replaceAll('\n', ' ↵ ');
    const before = this.hidden ? '•'.repeat(this.cursor) : [...this.value].slice(0, this.cursor).join('').replaceAll('\n', ' ↵ ');
    const inputWidth = width - 5, offset = Math.max(0, cellWidth(before) - inputWidth + 1);
    const cropped = cropLeft(visibleValue, offset);
    const inputText = this.value ? clip(cropped, inputWidth, '') : clip(this.panel === 'settings' && !this.promptDraft ? `↑/↓ choose · Enter opens · Esc ${this.ui.settingsOnly ? 'closes Settings' : 'returns to chat'}` : this.ui.sessionMode === 'VIEW' ? 'Read-only · /tabs or /detach' : this.mode === 'delegate' && !this.goal ? 'Chat, or /goal <objective> for supervised work' : 'Ask something, or /goal an objective', inputWidth);
    bottom.push(edge('│ ') + color(inputText, this.value ? palette.text : palette.muted) + ' '.repeat(Math.max(0, width - 4 - cellWidth(inputText))) + edge(' │'));
    const inputIndex = bottom.length - 1;
    const send = this.canCompose() && !this.selection && !this.copyMode;
    if (send) bottomHits.push({ type: 'confirm', row: bottom.length, left: Math.max(2, width - 10), right: width - 1 });
    bottom.push(edge('╰' + '─'.repeat(Math.max(0, width - (send ? 12 : 2))) + (send ? color(' Send ↵ ', palette.accent) + edge('──╯') : '╯')));
    for (const line of wrap(sessionLabel, width - 2)) bottom.push(muted(' ' + line));
    if (selected && selected.id !== this.ui.sessionId) for (const line of wrap(`Chat: ${selected.id}`, width - 2)) bottom.push(muted(' ' + line));
    // Keep the host header in place; constrained terminals spend their
    // remaining rows on the current screen and composer.
    const overflow = Math.max(0, header.length + bottom.length - height);
    if (overflow) bottom.splice(Math.max(0, bottom.length - overflow), overflow);
    let bodyHeight = Math.max(0, height - header.length - bottom.length);
    this.selectionHeight = bodyHeight;
    const contentWidth = width - 2;
    const roomLabels = this.panel === 'room' ? JSON.stringify([this.peers.map(peer => [peer.sessionId || peer.id, peer.namespace || peer.agent]), this.ui.tabs?.map(tab => [tab.id, tab.agent])]) : '';
    const contentKey = `${contentWidth}:${this.panel}:${this.showTools}:${this.contentRevision || 0}:${roomLabels}`;
    let body;
    if (!this.selection && this.panel !== 'settings' && this.bodyCache?.key === contentKey) body = this.bodyCache.lines;
    else { body = this.content(contentWidth); if (!this.selection) this.bodyCache = { key: contentKey, lines: body }; }
    const opening = this.panel === 'chat' && !this.selection && !this.entries.some(entry => !entry.welcome && entry.kind !== 'tool');
    if (!body.length || opening) {
      const welcome = this.mode === 'delegate' ? ['', accent('  One goal. The brain plans, delegates and verifies.'), color('  Chat normally; /goal starts supervised persistent work.', palette.text), muted('  Example: /goal Solve this CTF using the supplied files.'), muted('  Worker findings are reviewed before the goal can finish.')]
        : ['', accent('  Your next goal starts here.'), color('  /goal <objective>   Keep working until it is resolved', palette.text), muted('  /debate [objective]   Challenge the last reply'), muted('  Type / to browse commands, providers and models.')];
      const mode = this.entries.findLast(entry => /^(Parallel|Debate) mode/.test(entry.text));
      if (mode) welcome.push('', ...wrap(mode.text, width - 5).map(line => muted('  ' + line)));
      body = this.panel === 'chat' ? welcome : this.panel === 'room' ? [accent('  Shared room · waiting for peer messages'), ...wrap('The two besties exchange findings, evidence and reviews here. Their separate chats stay available above. Use /goal <objective> to begin collaboration.', width - 5).map(line => muted('  ' + line))]
        : this.panel === 'http' ? [muted('  No HTTP records yet.'), ...wrap('WebFetch and browser visits appear automatically as backend-reported activity. For measured shell HTTP traffic, start bzzy with --capture-network. The http_request tool always records observed requests.', width - 5).map(line => muted('  ' + line))] : [muted('  No ' + this.panel + ' records yet.')];
    }
    if (this.panel === 'settings' && !this.selection && this.settingsEnsureFocus) {
      const start = Math.max(0, body.length - this.scroll - bodyHeight), focus = this.settingsFocusRow || 0;
      if (focus < start) this.scroll = Math.max(0, body.length - bodyHeight - focus);
      else if (focus >= start + bodyHeight) this.scroll = Math.max(0, body.length - focus - 1);
      this.settingsEnsureFocus = false;
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
      visibleBody[index] = line + ' '.repeat(Math.max(0, width - 1 - cellWidth(line))) + (this.selection ? ' ' : maximum && index >= thumbOffset && index < thumbOffset + thumbHeight ? color('┃', palette.accent) : edge('│'));
    }
    if (['chat', 'room', 'settings'].includes(this.panel) || this.selection) for (const hit of this.contentHits) if (hit.row >= start && hit.row < end) this.hitTargets.push({ ...hit, row: header.length + hit.row - start + 1 });
    for (const hit of bottomHits) this.hitTargets.push({ ...hit, row: header.length + bodyHeight + hit.row + 1 });
    this.composerRow = header.length + bodyHeight + inputIndex + 1; this.composerOffset = offset;
    this.textRegion = !this.selection && bodyHeight ? { top: header.length + 1, bottom: header.length + bodyHeight, left: 1, right: width - 1 } : null;
    const lines = [...header, ...visibleBody, ...bottom].slice(0, height);
    const backgrounds = [];
    let frame = '\x1b[?25l';
    for (let row = 0; row < height; row++) {
      let line = lines[row] || '';
      if (cellWidth(line) > width || /[\r\n\u2028\u2029]/.test(clean(line))) line = color(clip(line, width), palette.text);
      const composerTop = header.length + bodyHeight + inputIndex - 1;
      const background = row >= composerTop && row <= composerTop + 2 ? palette.surface : palette.background;
      backgrounds.push(background);
      if (this.lastFrame[row] !== line || this.lastBackgrounds?.[row] !== background) frame += `\x1b[${row + 1};1H${this.theme.background(background)}${this.theme.foreground(palette.text)}\x1b[2K${line}\x1b[0m`;
      lines[row] = line;
    }
    this.lastFrame = lines; this.lastBackgrounds = backgrounds;
    if (this.canCompose()) {
      const row = header.length + bodyHeight + inputIndex + 1, column = Math.min(width - 1, 3 + cellWidth(before) - offset);
      frame += `\x1b[${Math.min(height, row)};${Math.max(1, column)}H\x1b[?25h`;
    }
    this.writeFrame(frame);
  }
  restore() { if (this.restored) return; this.restored = true; this.input.setRawMode?.(this.wasRaw); this.output.write('\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1049l'); }
  close() {
    if (this.closed) return; this.closed = true; clearTimeout(this.timer); clearTimeout(this.renderTimer); clearTimeout(this.clipboardNoticeTimer);
    this.finish(null); this.finishSelection(null); this.input.removeListener('keypress', this.onKey); this.output.removeListener?.('resize', this.onResize); this.output.removeListener?.('drain', this.onDrain); process.removeListener('exit', this.onExit); this.restore(); this.input.pause();
  }
}
function agentLabel(value) {
  const text = clean(value || 'Agent'), bestie = /^(.*?)-bestie-(\d+)(?:-|$)/.exec(text);
  return bestie ? `${bestie[1]} · ${bestie[2]}` : text.split('-').slice(0, 2).join('-');
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
