const loadBudget = () => import('@bzzy/core/engine/worker-budget.js');
const fail = code => { throw Object.assign(new Error(), { code }); };
const whole = value => Number.isSafeInteger(value) && value > 0;
const number = value => Number(value).toLocaleString('en-US');
const fields = ['mode', 'initialTokenBudget', 'initialRuntimeSeconds', 'maxTokenBudget', 'maxRuntimeSeconds', 'reportReserveTokens', 'supervisorReserveTokens'];
const policy = value => Object.fromEntries(fields.map(field => [field, value[field]]));

// Local owner Settings only. Policy saves start no work and never alter a
// running worker's allowance, permissions, scope or the parent's overall cap.
export class WorkerBudgetSettings {
  constructor(ui, { loader = loadBudget, capture, check, isCurrent } = {}) {
    Object.assign(this, { ui, loader, capture, check, isCurrent });
  }
  assert() {
    if (!this.isCurrent()) fail('WORKER_BUDGET_CONTEXT'); this.check(this.context);
    if (this.capture().goalId !== this.context.goalId) fail('WORKER_BUDGET_CONTEXT');
  }
  async open() {
    this.context = this.capture();
    this.backend = await this.loader(); this.assert();
    this.saved = this.backend.getWorkerBudgetSettings();
    this.draft = policy(this.saved); this.dirty = false;
  }
  leave() { this.draft = null; this.saved = null; this.context = null; }
  rows() {
    if (!this.draft) return [{ text: 'Agent execution settings unavailable.', tone: 'warning' }];
    const row = (text, value, action) => ({ text, value, action: `worker-budget:${action}`, card: true, tone: 'accent' });
    const p = this.draft, rows = [
      { text: 'Applies to new goals. Existing goals keep their saved policy.', tone: 'muted' },
      row('Allocation mode', p.mode === 'adaptive' ? 'Adaptive' : 'Fixed', 'mode'),
      row('Initial tokens', number(p.initialTokenBudget), 'initialTokenBudget'),
      row('Initial runtime', `${number(p.initialRuntimeSeconds)} seconds`, 'initialRuntimeSeconds'),
      row('Maximum tokens', p.maxTokenBudget == null ? 'Unlimited host ceiling' : number(p.maxTokenBudget), 'maxTokenBudget'),
      row('Maximum runtime', p.maxRuntimeSeconds == null ? 'Unlimited host ceiling' : `${number(p.maxRuntimeSeconds)} seconds`, 'maxRuntimeSeconds'),
      { text: p.mode === 'adaptive' ? 'Adaptive workers may request extensions within owner ceilings and the parent budget.' : 'Fixed workers keep their initial allocation; no adaptive extensions.', tone: 'muted' },
      { text: 'Unlimited removes this host ceiling. Parent budgets and explicit definition limits still apply.', tone: 'muted' },
      { text: this.dirty ? 'Save changes for new goals' : 'Saved settings', action: 'worker-budget:save', tone: 'accent' },
    ];
    let target;
    try { this.assert(); target = this.capture(); }
    catch { return [{ text: 'The host, terminal or goal changed. Reopen Agent execution settings.', tone: 'warning' }]; }
    if (target.canApplyCurrentGoal && target.goalId && !['complete', 'cancelled'].includes(target.goalStatus) && ['paused', 'idle'].includes(target.executionState)) {
      if (this.dirty) rows.push({ text: 'Save before applying to the current goal.', tone: 'muted' });
      else rows.push({ text: 'Apply saved settings to current goal', action: 'worker-budget:apply', tone: 'warning' });
    }
    return rows;
  }
  async run(action) {
    this.assert();
    const field = action.slice('worker-budget:'.length);
    if (field === 'save') {
      this.saved = this.backend.setWorkerBudgetSettings(this.draft, { expectedRevision: this.saved.revision });
      this.draft = policy(this.saved); this.dirty = false;
      return 'Agent execution settings saved for new goals. Existing goals were unchanged.';
    }
    if (field === 'apply') {
      if (this.dirty) fail('WORKER_BUDGET_INVALID');
      const target = this.capture();
      if (!target.canApplyCurrentGoal || !target.goalId || !['paused', 'idle'].includes(target.executionState)) fail('WORKER_BUDGET_CONTEXT');
      const confirmed = await this.ui.chooseOne('Apply to the current paused goal?', [
        { value: 'keep', label: 'Keep the current goal policy', selected: true },
        { value: 'apply', label: 'Apply to future workers', description: 'Existing worker allowances, permissions, scope and the goal’s overall budget stay unchanged.' },
      ]);
      this.assert();
      const current = this.capture();
      if (!current.canApplyCurrentGoal || current.goalId !== target.goalId || !['paused', 'idle'].includes(current.executionState)) fail('WORKER_BUDGET_CONTEXT');
      if (confirmed !== 'apply') return;
      this.backend.applyWorkerBudgetSettingsToGoal(target.session, { expectedGoalId: target.goalId, expectedRevision: this.saved.revision });
      return 'Saved policy applied to future workers in this goal. Existing allowances, scope and overall budget were unchanged.';
    }
    if (field === 'mode') {
      const selected = await this.ui.chooseOne('Worker allocation mode', [
        { value: 'adaptive', label: 'Adaptive', selected: this.draft.mode === 'adaptive', description: 'Workers may request bounded extensions within owner ceilings and the parent budget.' },
        { value: 'fixed', label: 'Fixed', selected: this.draft.mode === 'fixed', description: 'Workers keep the initial allocation without adaptive extensions.' },
      ]);
      this.assert(); if (selected == null) return;
      if (!['adaptive', 'fixed'].includes(selected)) fail('WORKER_BUDGET_INVALID');
      this.draft.mode = selected;
    } else if (['initialTokenBudget', 'initialRuntimeSeconds', 'maxTokenBudget', 'maxRuntimeSeconds'].includes(field)) {
      const ceiling = field.startsWith('max'), seconds = field.endsWith('Seconds');
      const value = await this.ui.ask(`${ceiling ? 'Maximum' : 'Initial'} worker ${seconds ? 'runtime in seconds' : 'tokens'}${ceiling ? ' · enter unlimited for no host ceiling' : ''} · Enter keeps this value · Esc cancels`, {
        initialValue: this.draft[field] == null ? 'unlimited' : String(this.draft[field]),
      });
      this.assert(); if (value == null || !value.trim()) return;
      const input = value.trim(), parsed = ceiling && /^unlimited$/i.test(input) ? null : /^\d+$/.test(input) ? Number(input) : NaN;
      if (parsed !== null && !whole(parsed)) fail('WORKER_BUDGET_INVALID');
      this.draft[field] = parsed;
    } else return;
    this.dirty = JSON.stringify(this.draft) !== JSON.stringify(policy(this.saved));
  }
}
