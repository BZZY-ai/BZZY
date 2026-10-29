import { clean, cellWidth, clip, wrap } from './terminal-format.js';
import { debugExportErrorMessage } from '@bzzy/core/engine/debug-export-errors.js';
import { isStalledGoal } from '@bzzy/core/engine/goal-state.js';
import { costLabel, deepseekSpendingVisible, sessionCostLines } from './session-cost-format.js';
import { debugExportProgressLines, safeDebugExportProgress, debugExportContextNotice, debugExportSummary } from './debug-export-progress.js';

const loadRecordedMetrics = async id => (await import('@bzzy/core/engine/session-metrics.js')).sessionMetrics(id);
const exportRecordedDebug = async id => (await import('@bzzy/core/engine/session-debug.js')).exportSessionDebug(id);
const exportFullRecordedDebug = async (id, options) => (await import('@bzzy/core/engine/session-full-debug.js')).exportFullSessionDebugInWorker(id, options);
const recordedCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
const pad = (value, width) => value + ' '.repeat(Math.max(0, width - cellWidth(value)));
const stalled = goal => ['stalled', 'budget_exhausted'].includes(goal?.status) || isStalledGoal(goal);
const stalledPauseLabels = { turn_limit: 'turn limit', recovery_required: 'recovery required', context_no_progress: 'no progress' };
const statusLabel = (value, reason) => value === 'paused' && isStalledGoal({ status: value, reason })
  ? 'Stalled' + (Object.hasOwn(stalledPauseLabels, reason) ? ' · ' + stalledPauseLabels[reason] : '') : ({ complete: 'Achieved ✓', running: 'Working', active: 'Working', paused: 'Paused',
  stalled: 'Stalled', cancelled: 'Cancelled', failed: 'Failed', awaiting_review: 'Stalled · awaiting review',
  verifying: 'Verifying', blocked: 'Stalled', budget_limited: 'Stalled · budget limit', usage_limited: 'Stalled · usage limit',
  budget_exhausted: 'Stalled · budget limit' })[value] || clean(value || 'Unknown status').replaceAll('_', ' ');
const goalLabel = goal => `${statusLabel(goal.status, goal.reason)} · ${goal.createdAt ? String(goal.createdAt).slice(0, 10) + ' · ' : ''}${String(goal.id).slice(0, 8)}`;

// Reads durable Core counters only. Opening this panel never starts Core,
// launches a model, acquires an input lease or changes the selected session.
export class SessionMetricsPanel {
  constructor(ui, { load = loadRecordedMetrics, exportDebug = ui.sessionDebugExporter || exportRecordedDebug,
    exportFullDebug = ui.sessionFullDebugExporter || exportFullRecordedDebug, intervalMs = 1000 } = {}) {
    this.ui = ui; this.load = load; this.exportDebug = exportDebug; this.exportFullDebug = exportFullDebug; this.intervalMs = intervalMs;
    this.scope = 'goal'; this.revision = 0; this.epoch = 0;
  }
  changed() { this.revision++; this.ui.tui?.schedule(); }
  open(id) {
    if (this.closed) return;
    if (this.active && this.sessionId === id) return;
    this.stop(); this.active = true;
    if (this.sessionId !== id) {
      this.sessionId = id; this.data = null; this.error = null; this.exportResult = null; this.exportError = null; this.scope = 'goal'; this.selectedGoalId = null;
    }
    if (this.exportJob?.sessionId === id) {
      this.exportResult = this.exportJob.result || null; this.exportError = this.exportJob.error || null;
    }
    this.changed(); void this.refresh();
  }
  stop() { this.active = false; this.epoch++; clearTimeout(this.timer); this.timer = null; this.loading = false; }
  close() { this.stop(); clearInterval(this.exportTimer); this.exportTimer = null; this.closed = true; this.data = null; this.error = null; this.sessionId = null; }
  async refresh() {
    if (!this.active || this.loading || this.closed) return;
    // Metrics also reads saved history synchronously. Avoid competing with the
    // background export and blocking its visible progress on the UI thread.
    if (this.exportJob?.running && this.exportJob.full) return;
    const epoch = this.epoch, id = this.sessionId;
    clearTimeout(this.timer); this.loading = true; this.changed();
    try {
      if (!id) throw new Error('No selected session.');
      const data = await this.load(id);
      if (!this.active || this.closed || epoch !== this.epoch || id !== this.sessionId) return;
      if (!data || data.sessionId !== id) throw new Error('Metrics do not belong to this session.');
      this.data = data; this.error = null;
      if (this.selectedGoalId && !data.goals?.some(goal => goal.id === this.selectedGoalId)) this.selectedGoalId = null;
    } catch {
      if (this.active && !this.closed && epoch === this.epoch) this.error = 'Metrics are unavailable for this saved chat. Retry to read its recorded history.';
    } finally {
      if (this.active && !this.closed && epoch === this.epoch) {
        this.loading = false; this.changed();
        this.timer = setTimeout(() => { void this.refresh(); }, this.intervalMs); this.timer.unref?.();
      }
    }
  }
  actions() {
    return [
      { action: 'goal', text: this.selectedGoalId ? 'Selected goal' : 'Current goal', selected: this.scope === 'goal' },
      { action: 'session', text: 'Chat totals', selected: this.scope === 'session' },
      { action: 'chat', text: 'Outside goals', selected: this.scope === 'chat' },
      { action: 'history', text: 'Choose goal ▾', disabled: !this.data?.goals?.length },
      { action: 'refresh', text: this.loading ? 'Reading…' : 'Refresh' },
      { action: 'export', text: this.exporting && !this.exportJob?.full ? 'Exporting…' : 'Export debug', disabled: this.exporting || !this.sessionId || this.data?.available === false },
      { action: 'full-export', text: this.exporting && this.exportJob?.full ? 'Exporting ZIP…' : 'Full debug ZIP', disabled: this.exporting || !this.sessionId || this.data?.available === false },
    ];
  }
  async activate(action, { captureMode = 'complete' } = {}) {
    if (!this.active || this.closed) return;
    if (['goal', 'session', 'chat'].includes(action)) {
      this.scope = action;
      if (action === 'goal') this.selectedGoalId = null;
      this.changed(); return;
    }
    if (action === 'refresh') { await this.refresh(); return; }
    if (action === 'export' || action === 'full-export') {
      if (this.exporting || !this.sessionId || this.data?.available === false) return;
      const id = this.sessionId, full = action === 'full-export';
      const job = { sessionId: id, full, captureMode, running: true, startedAt: Date.now(), updatedAt: Date.now(), progress: { phase: 'session' } };
      this.exportJob = job;
      this.exporting = true; this.exportError = null; this.exportResult = null; this.changed();
      if (full) {
        clearTimeout(this.timer); this.timer = null;
        this.exportTimer = setInterval(() => {
          if (!this.closed && this.active && this.exportJob === job) this.changed();
        }, 1000); this.exportTimer.unref?.();
      }
      try {
        // Paint the initial state before the worker starts collecting data.
        await new Promise(resolve => setImmediate(resolve));
        const onProgress = value => {
          if (this.closed || this.exportJob !== job || !job.running) return;
          const progress = safeDebugExportProgress(value); if (!progress) return;
          job.progress = progress; job.updatedAt = Date.now();
          if (this.active && id === this.sessionId) this.changed();
        };
        const result = await (full ? this.exportFullDebug(id, { onProgress, captureMode }) : this.exportDebug(id));
        job.result = result;
        if (!this.closed && id === this.sessionId) this.exportResult = result;
      } catch (error) {
        job.error = debugExportErrorMessage(error, { full });
        if (!this.closed && id === this.sessionId) this.exportError = job.error;
      } finally {
        job.running = false; this.exporting = false; clearInterval(this.exportTimer); this.exportTimer = null;
        if (!this.closed) { this.changed(); if (full) void this.refresh(); }
      }
      return;
    }
    if (action !== 'history' || !this.data?.goals?.length) return;
    const id = this.sessionId, epoch = this.epoch, reader = this.ui.reader, input = this.ui.tui?.resolveInput;
    let selected;
    try {
      selected = await this.ui.chooseOne('Recorded goals', this.data.goals.map(goal => ({ value: goal.id,
        label: `${goal.id === this.data.currentGoalId ? 'Current · ' : ''}${goalLabel(goal)}`,
        description: goal.id === this.data.currentGoalId ? 'The current goal in this chat.' : 'Recorded usage for this earlier goal.',
        selected: goal.id === (this.selectedGoalId || this.data.currentGoalId),
      })));
    } finally {
      if (!this.closed && !this.ui.reader && input && input === this.ui.tui?.resolveInput) this.ui.reader = reader;
    }
    if (!selected || !this.active || this.closed || epoch !== this.epoch || id !== this.sessionId || !this.data?.goals?.some(goal => goal.id === selected)) return;
    this.selectedGoalId = selected === this.data.currentGoalId ? null : selected; this.scope = 'goal'; this.changed();
  }
}

export function sessionMetricsLayout(panel, width, { currentGoal, alias, focus = 0, selection } = {}) {
  const lines = [], hits = [], actions = panel.actions();
  const put = (text = '', tone = 'text', bold = false) => lines.push({ text, tone, bold });
  const prose = (text, tone = 'text', maximum) => {
    for (const line of wrap(clean(text), Math.max(8, width - 4), maximum)) put('  ' + line, tone);
  };
  let buttons = '  ';
  for (const [index, action] of actions.entries()) {
    const label = ` ${index === focus ? '›' : action.selected ? '●' : ' '} ${action.text} `;
    if (cellWidth(buttons) + cellWidth(label) > width - 1 && buttons.trim()) { put(buttons, 'accent', true); buttons = '  '; }
    const left = cellWidth(buttons) + 1;
    hits.push({ type: 'metrics-action', action: action.action, disabled: action.disabled, row: lines.length, left, right: left + cellWidth(label) - 1 });
    buttons += label;
  }
  put(buttons, 'accent', true); put();
  const data = panel.data;
  if (panel.exportJob?.running && panel.exportJob.full) {
    if (panel.exportJob.sessionId === panel.sessionId) {
      for (const line of debugExportProgressLines(panel.exportJob.progress, {
        elapsedMs: Date.now() - panel.exportJob.startedAt, quietMs: Date.now() - panel.exportJob.updatedAt, captureMode: panel.exportJob.captureMode,
      })) prose(line, 'accent');
    } else prose('A full debug export for another chat is still in progress.', 'muted');
    put();
  }
  if (panel.exportResult) {
    prose((panel.exportResult.full ? 'Full debug ZIP exported · ' : 'Debug exported · ') + panel.exportResult.outputPath, 'goalSuccess');
    const summary = debugExportSummary(panel.exportResult);
    if (summary) prose(summary, 'muted');
    const contextNotice = debugExportContextNotice(panel.exportResult);
    if (contextNotice) prose(contextNotice, 'warning');
    if (panel.exportResult.full && Number.isSafeInteger(panel.exportResult.exclusions) && panel.exportResult.exclusions > 0)
      prose(`${panel.exportResult.exclusions.toLocaleString()} capture omissions. Check manifest.exclusions inside the ZIP.`, 'warning');
    prose('Includes session history and skill/agent definitions. Review this private task content before sharing.', 'muted');
    put();
  }
  if (panel.exportError) { prose(panel.exportError, 'warning'); put(); }
  if (!data) {
    prose(panel.error || (panel.sessionId ? 'Reading this chat’s recorded usage…' : 'Open a saved chat to view its recorded usage.'), panel.error ? 'warning' : 'muted');
    return { lines, hits, actions };
  }
  if (data.available === false) {
    prose('Recorded metrics are unavailable for this chat. Open an existing saved chat, then refresh.', 'warning');
    return { lines, hits, actions };
  }
  const goalId = panel.selectedGoalId || data.currentGoalId;
  const goal = data.goals?.find(item => item.id === goalId);
  const usage = panel.scope === 'session' ? data.session : panel.scope === 'chat' ? data.chat : goal;
  if (panel.scope === 'goal') {
    put('  ' + (panel.selectedGoalId ? 'Earlier goal' : 'Current goal') + (goal ? ' · ' + statusLabel(goal.status, goal.reason) : ''), goal?.status === 'complete' ? 'goalSuccess' : stalled(goal) ? 'danger' : goal?.status === 'paused' ? 'warning' : 'accent', true);
    if (goal && (goal.objective || currentGoal?.id === goal.id && currentGoal.objective)) prose(goal.objective || currentGoal.objective, 'text', 3);
    else if (goal) prose(goalLabel(goal), 'muted');
    else prose('No current goal is recorded. Chat totals include work outside goals.', 'muted');
    if (stalled(goal) && goal.reason) prose('Reason: ' + clean(goal.reason).replaceAll('_', ' '), 'warning', 2);
  } else {
    put('  ' + (panel.scope === 'session' ? 'Whole chat' : 'Outside goals') + (alias ? ' · ' + clip(clean(alias), Math.max(8, width - 24)) : ''), 'accent', true);
    prose(panel.scope === 'session' ? 'All recorded work in this chat, including its workers and linked validation.' : 'Only work explicitly recorded without a goal. Earlier ambiguous history is not assigned here.', 'muted', 2);
  }
  if (panel.error) prose(panel.error + ' Showing the last recorded snapshot.', 'warning');
  if (data.coverage?.complete === false) prose('Partial history · some older usage cannot be attributed reliably.', 'warning');
  if (data.coverage?.reasons?.includes('imported_history')) prose('Imported historical use is excluded from these counts.', 'muted');
  if (data.coverage?.reasons?.includes('unknown_goal_attribution')) prose('Uses without reliable goal attribution appear only in chat totals.', 'muted');
  if (data.coverage?.reasons?.includes('followup_attribution_unavailable')) prose('Some older follow-ups lack their assignment record and are excluded.', 'muted');
  if (data.coverage?.reasons?.some(reason => ['session_limit', 'goal_limit', 'event_backfill_pending', 'invocation_limit', 'row_limit'].includes(reason)))
    prose('This snapshot reached a recorded-history limit; totals are partial.', 'warning');
  const legacy = data.coverage?.legacySkillReads;
  if (Number.isSafeInteger(legacy) && legacy > 0) prose(`${legacy.toLocaleString()} older skill reads lack a confirmed model-use record; they are excluded.`, 'muted', 2);
  const compactor = data.spending?.compactor || data.compactorCost;
  if (compactor && deepseekSpendingVisible(selection || data)) {
    put(); put('  DeepSeek spending · whole chat', 'accent', true);
    if (data.spending) for (const line of sessionCostLines(data.spending, width - 4)) prose(line, data.spending.total.complete ? 'text' : 'warning');
    else { prose('Memory compactor', 'muted'); }
    prose(data.spending ? compactor.complete ? 'Compactor estimate' : 'Compactor known estimate · partial'
      : compactor.complete ? 'Estimated cost' : 'Known estimate · partial', compactor.complete ? 'text' : 'warning');
    prose(costLabel(compactor.estimatedUsd), compactor.complete ? 'text' : 'warning');
    prose(`${recordedCount(compactor.attempts)} attempts · ${recordedCount(compactor.summaries)} summaries`, 'muted');
    for (const model of compactor.models || []) prose(`${model.provider || 'Unknown provider'} / ${model.model || 'unknown model'} · ${costLabel(model.estimatedUsd)} · ${recordedCount(model.attempts)} attempts${model.unpricedAttempts ? ` · ${recordedCount(model.unpricedAttempts)} unpriced` : ''}`, 'muted');
    if (compactor.legacyAttempts) prose(`${recordedCount(compactor.legacyAttempts)} older attempts have no billing breakdown; their cost is unknown.`, 'warning');
    if (compactor.incompleteAttempts > compactor.legacyAttempts) prose('Some attempts have unfinished usage. The known estimate can increase.', 'warning');
    if (data.spending?.chat.historical) prose('Older DeepSeek chat usage is unpriced. Tracking continues in this saved session.', 'warning');
    prose('Chat includes linked DeepSeek workers. Compactor counts background summaries. The account balance is separate.', 'muted');
    if (compactor.attempts) prose(`DeepSeek rates verified ${compactor.pricingVerifiedAt}; peak/holiday or cache uncertainty uses a range. Other providers remain unpriced.`, 'muted');
  }
  if (!usage) return { lines, hits, actions };
  put();
  const wide = width >= 76, countColumn = Math.min(width - 18, 42);
  if (wide) put('  ' + 'Recorded usage'.padEnd(countColumn) + 'Count', 'muted', true);
  const metric = (name, value) => put('  ' + (wide ? name.padEnd(countColumn) + recordedCount(value) : `${name}: ${recordedCount(value)}`));
  metric('Skill model loads', usage.skillInvocations);
  metric('Specialist agents invoked', usage.subagentInvocations);
  if (Object.hasOwn(usage, 'subagentFollowups')) metric('Specialist follow-ups', usage.subagentFollowups);
  metric('Worker assignments', usage.workerAssignments);
  if (Object.hasOwn(usage, 'workerFollowups')) metric('Worker follow-ups', usage.workerFollowups);
  const health = data.health;
  if (health?.available && (!panel.selectedGoalId || panel.selectedGoalId === data.currentGoalId)) {
    put(); put('  BZZY execution health · current session', 'accent', true);
    const routing = health.routing;
    if (routing?.enforced) {
      prose(`Workflow consultation · ${recordedCount(routing.covered ?? routing.closed)} covered · ${recordedCount(routing.open)} open · ${recordedCount(routing.blocked)} blocked`, routing.unmet ? 'warning' : 'text');
      for (const unit of routing.units || []) prose(`${unit.classId} · ${unit.outcome || unit.state}${unit.specialist ? ' · ' + unit.specialist : ''}${unit.missing?.length ? ' · ' + unit.missing.join(', ') : ''}`, 'muted', 2);
    } else if (data.currentGoalId) prose('Workflow consultation · no structured routing contract on this goal.', 'muted');
    const native = health.native, readiness = native?.readiness;
    if (native?.routingToolCoverage?.missing?.length) prose(`Workflow tools missing from native thread: ${native.routingToolCoverage.missing.join(', ')}. Pause, update and resume so Core can refresh its tool schemas.`, 'warning');
    if (readiness?.tools?.source === 'unknown-legacy-native-thread') prose('Core tool delivery · unknown for this retained native thread.', 'warning');
    else if (readiness) prose(`Core tool delivery · ${recordedCount(readiness.tools?.count)} schemas · ${clean(readiness.phase || 'unknown').replaceAll('-', ' ')}`, 'muted');
    if (native?.contextBudget?.tokens) prose(`Context planning · ${recordedCount(native.contextBudget.tokens)} tokens · ${clean(native.contextBudget.source).replaceAll('-', ' ')}`, 'muted');
    if (native?.compaction) prose(`Native compactions · ${recordedCount(native.compaction.modernCompleted)} completed · ${Math.round((native.compaction.completedDurationMs || 0) / 1000).toLocaleString()}s lifecycle time`, 'muted');
    if (native?.refresh && !['consumed', 'acknowledged'].includes(native.refresh.state)) prose('Context refresh · ' + clean(native.refresh.state) + ' · ' + clean(native.refresh.reason || 'awaiting a safe boundary').replaceAll('_', ' '), 'warning', 2);
    if (health.memory) prose(`Session memory · indexed through event ${recordedCount(health.memory.indexedThroughSeq)} · ${recordedCount(health.memory.pendingNodes)} summaries pending`, 'muted');
    if (health.episode) prose(`Automatic capture · ${recordedCount(health.episode.counts?.attempts)} closed attempts · ${recordedCount(health.episode.counts?.failed)} failures · ${recordedCount(health.episode.counts?.workerReviews)} worker reviews · through event ${recordedCount(health.episode.observedThroughSeq)}`, 'muted');
    const waiting = [...(health.retention?.jobs || []), ...(health.learning?.jobs || [])].filter(job => job.reason);
    for (const job of waiting.slice(0, 3)) prose(`Background review · ${recordedCount(job.count)} ${clean(job.state)} · ${clean(job.reason).replaceAll('_', ' ')}`, 'muted');
    if (health.taskState) prose(`Task state · ${recordedCount(health.taskState.bytes)} bytes · ${recordedCount(health.taskState.repeatedReads)} consecutive identical reads`, 'muted');
  }
  const breakdown = (title, rows, empty, label, detail) => {
    put(); put('  ' + title, 'accent', true);
    if (!rows?.length) { prose(empty, 'muted'); return; }
    for (const item of rows) {
      const name = clean(label(item));
      const followups = Number.isSafeInteger(item.followups) && item.followups > 0 ? ` · ${recordedCount(item.followups)} follow-up${item.followups === 1 ? '' : 's'}` : '';
      if (wide) put('  ' + pad(clip(name, countColumn - 2), countColumn) + recordedCount(item.count) + followups);
      else prose(`${name} · ${recordedCount(item.count)} use${item.count === 1 ? '' : 's'}${followups}`);
      if (detail) prose(detail(item), 'muted');
    }
  };
  breakdown('Skills', usage.skillRows, 'No recorded skill use.', item => item.name || item.id || 'Unnamed skill', item => {
    const scope = item.scope === 'global' ? 'BZZY Core / global' : item.scope === 'project' ? 'This project' : 'Scope unknown';
    const version = item.version ? `version ${String(item.version).slice(0, 8)}` : 'Version unknown';
    return `${scope} · ${version}`;
  });
  breakdown('Specialist agents', usage.agentRows, 'No recorded specialist invocation.', item => item.name || item.id || 'Unnamed specialist');
  if (usage.workerRows?.length) breakdown('Worker roles · Delegate / Validate', usage.workerRows, '', item => ({ investigation: 'Independent validation check', final_review: 'Final evidence review',
    executor: 'Executor', supervisor: 'Supervisor', reviewer: 'Reviewer', peer: 'Collaborating worker' })[item.role] || clean(item.role || 'Worker').replaceAll('_', ' '));
  put(); prose('Counts come from saved Core records. Skills count confirmed model loads; agents count specialist assignments. Browsing definitions does not count as use.', 'muted');
  if (data.updatedAt) prose('Last recorded use · ' + String(data.updatedAt).replace('T', ' ').replace(/\.\d+Z$/, ' UTC'), 'muted');
  return { lines, hits, actions };
}
