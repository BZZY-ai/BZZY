import readline from 'node:readline';
import { TerminalChat } from './tui.js';
import { clean } from './terminal-format.js';
import { AccountStatusMonitor, accountStatusDetails } from './account-status.js';
import { telegramViewState } from './telegram-state.js';
export { clean } from './terminal-format.js';

export class UI {
  constructor({ json = false, pet = true, input = process.stdin, output = process.stdout, error = process.stderr } = {}) {
    this.json = json;
    this.pet = pet;
    this.input = input;
    this.output = output;
    this.error = error;
    this.interactive = Boolean(input.isTTY && output.isTTY && !json);
    this.lineOpen = false;
    this.reader = null;
    this.promptQueue = Promise.resolve();
    this.cursors = new Map();
  }

  openTerminal() { if (this.interactive) this.tui ||= new TerminalChat(this); }

  setSession(id, mode = 'CONTROL') {
    if (this.sessionId !== id) { this.tabs = null; this.activeTab = null; this.tui?.clear(); }
    this.sessionId = id; this.sessionMode = mode;
    if (this.interactive) { this.openTerminal(); this.renderFooter(); }
    else this.event('session', { sessionId: id, message: `Session: ${id} · ${mode}` });
  }
  setTabs(groupId, children, selectedId = groupId) {
    this.tui?.selectTab(this.activeTab || this.sessionId, selectedId);
    this.sessionId = groupId; this.tabs = [{ id: groupId, agent: 'Overview' }, ...children]; this.activeTab = selectedId;
    this.renderFooter();
  }
  clearHistory() { this.tui?.clear(); this.lineOpen = false; }
  redrawPrompt() { if (this.tui) this.tui.schedule(); else if (this.reader && !this.lineOpen) this.reader.prompt(true); }
  updateSession(snapshot) {
    this.tui?.update(snapshot);
    if (this.accountStatusEnabled) {
      this.accountMonitor ||= new AccountStatusMonitor(status => { this.accountStatus = status; this.tui?.schedule(); });
      this.accountMonitor.update(snapshot.session || snapshot);
    }
    if (this.telegramSupportEnabled && Date.now() - (this.telegramRefreshedAt || 0) > 1000) this.refreshTelegramState();
  }
  refreshTelegramState() {
    this.telegramRefreshedAt = Date.now();
    const state = telegramViewState(this.activeTab || this.sessionId);
    if (JSON.stringify(state) !== JSON.stringify(this.telegramState)) { this.telegramState = state; if (this.tui) { this.tui.contentRevision = (this.tui.contentRevision || 0) + 1; this.tui.schedule(); } }
    if (state.attachedSessionId && this.telegramSupportEnabled && !this.telegramRelayStarted) {
      this.telegramRelayStarted = true;
      import('./telegram-bridge.js').then(module => module.ensureTelegramBridge()).catch(error => { this.event('error', { message: error.message }); });
    }
  }
  showAccountStatus() { this.event('info', { message: accountStatusDetails(this.accountStatus) }); }
  async chooseMany(title, choices) {
    if (this.tui) return this.tui.chooseMany(title, choices);
    return choices.filter(choice => choice.selected).map(choice => choice.value);
  }
  async chooseOne(title, choices) {
    if (this.tui) return this.tui.chooseOne(title, choices);
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
    if (type === 'text') { const text = clean(data.text); this.output.write(text); this.lineOpen = !text.endsWith('\n'); return; }
    if (type === 'message.user') { this.newline(); this.output.write(`\nYou${data.kind === 'goal' ? ' /goal' : ''} › ${clean(data.text)}\n\n`); return; }
    if (type === 'question') { this.newline(); this.output.write(`\nAgent asks › ${clean(data.question)}\n`); return; }
    if (type === 'question.answered') { this.newline(); this.output.write(`You › ${clean(data.answer)}\n\n`); return; }
    if (type === 'peer.text') { const text = clean(data.text); this.newline(); this.output.write(`[${clean(data.agent)}] ${text}`); this.lineOpen = !text.endsWith('\n'); return; }
    if (type === 'activity') { this.activity = data.summary; this.renderFooter(); }
    this.newline();
    if (type === 'tool') this.output.write(`  · ${clean(data.name)}${data.detail ? `  ${clean(data.detail).slice(0, 240)}` : ''}\n`);
    else if (type === 'goal') this.output.write(`  goal ${data.status}${data.tokensUsed != null ? ` · ${data.tokensUsed} tokens` : ''}\n`);
    else if (type === 'error') this.error.write(`${clean(data.message)}\n`);
    else if (type === 'worker.progress') this.output.write(`  [${clean(data.agent || data.workerSessionId?.slice(0, 8) || 'worker')}] ${clean(data.name || data.message || data.status || data.type)}\n`);
    else if (type === 'activity') this.output.write(`  ◉ ${clean(data.message || data.summary)}\n`);
    else if (type === 'network.response') this.output.write(`  ↔ ${clean(data.method)} ${clean(data.url)} → ${data.status} · ${data.durationMs}ms\n`);
    else if (data.message) this.output.write(`${clean(data.message)}\n`);
  }

  newline() { if (!this.tui && this.lineOpen) { this.output.write('\n'); this.lineOpen = false; } }

  ask(question) {
    this.beforeOutput?.();
    if (!this.interactive) return Promise.resolve('');
    const operation = this.promptQueue.then(() => {
      if (this.closed) return null;
      if (this.tui) return this.tui.ask(question);
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

  close() {
    this.accountMonitor?.close();
    this.closed = true; this.reader?.close(); this.newline();
    if (this.tui) { this.tui.close(); if (this.sessionId) this.output.write(`Session: ${this.sessionId}\nAttach: bzzy --attach ${this.sessionId}\n`); }
  }
}
