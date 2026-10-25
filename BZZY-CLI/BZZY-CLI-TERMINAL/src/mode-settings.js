import { modeDefault, saveModeDefault } from './providers.js';
import { chooseUnifiedModel, chooseEffort } from './model-controls.js';

export const modeSettings = Object.freeze({
  debate: { title: 'Debate', icon: '◇', description: 'A main agent answers independent challenges.', roles: ['Main agent', 'Challenger 1', 'Challenger 2'] },
  parallel: { title: 'Parallel', icon: '▥', description: 'Independent agents work on the same goal.', roles: ['Agent 1', 'Agent 2', 'Agent 3'] },
  besties: { title: 'Besties', icon: '◎', description: 'Equal collaborators share findings and review evidence.', roles: ['Bestie 1', 'Bestie 2', 'Bestie 3'] },
  delegate: { title: 'Delegate', icon: '◈', description: 'A supervisor plans and reviews an executor’s work.', roles: ['Supervisor · brain', 'Executor · hands'] },
});

// Presentation only: Core's existing preset API owns validation/persistence.
// Editing never creates sessions, authenticates providers or starts model work.
export class ModeSettings {
  constructor(ui, { read = modeDefault, save = saveModeDefault, modelPicker = chooseUnifiedModel, effortPicker = chooseEffort } = {}) {
    Object.assign(this, { ui, read, save, modelPicker, effortPicker }); this.drafts = new Map();
  }
  open(mode) {
    if (!modeSettings[mode]) throw new Error('Choose a supported chat mode.');
    if (!this.drafts.has(mode)) {
      const saved = this.read(mode);
      this.drafts.set(mode, { count: saved?.length || 2, agents: structuredClone(saved || [null, null]), dirty: false, base: JSON.stringify(saved || null) });
    }
    this.mode = mode;
  }
  get draft() { return this.drafts.get(this.mode); }
  homeRows() {
    return Object.entries(modeSettings).map(([mode, info]) => {
      const saved = this.read(mode), dirty = this.drafts.get(mode)?.dirty;
      return { text: info.title, action: `mode:${mode}`, icon: info.icon, card: true,
        detail: info.description, value: dirty ? 'Unsaved changes' : saved ? `${saved.length} agents saved` : 'Set up', tone: 'accent' };
    });
  }
  rows() {
    const info = modeSettings[this.mode], draft = this.draft, rows = [];
    rows.push({ text: info.description, tone: 'muted' });
    rows.push({ text: 'Number of agents', value: String(draft.count) + (this.mode === 'delegate' ? '' : ' ▾'), action: this.mode === 'delegate' ? undefined : 'preset-count',
      detail: this.mode === 'delegate' ? 'Two fixed roles: one supervisor and one executor.' : 'Choose two or three agents.', tone: 'accent', control: true });
    for (let index = 0; index < draft.count; index++) {
      const agent = draft.agents[index];
      rows.push({ text: info.roles[index], tone: 'muted', section: true });
      rows.push({ text: 'Model', value: agent ? `${agent.provider} · ${agent.model || 'Provider default'} ▾` : 'Choose a model ▾',
        action: `preset-model:${index}`, inline: `agent-${index}`, tone: 'accent', control: true });
      rows.push({ text: 'Effort', value: agent ? (agent.effort || 'default') + ' ▾' : 'Model first', action: `preset-effort:${index}`,
        inline: `agent-${index}`, tone: 'accent', control: true });
    }
    rows.push({ text: 'Save ' + info.title + ' default', action: 'preset-save', primary: true, tone: 'accent' });
    if (draft.dirty) rows.push({ text: 'Reload saved setup · discard edits', action: 'preset-reload', tone: 'muted' });
    rows.push({ text: draft.dirty ? 'Unsaved · your current conversations are unchanged.' : 'Used on the next launch of this mode. Core’s assistant stays independent.', tone: 'muted' });
    return rows;
  }
  async run(action) {
    const draft = this.draft;
    if (action === 'preset-reload') { this.drafts.delete(this.mode); this.open(this.mode); }
    else if (action === 'preset-count') {
      if (this.mode === 'delegate') return;
      const selected = await this.ui.chooseOne('Number of agents', [2, 3].map(count => ({ value: String(count), label: `${count} agents`, selected: count === draft.count })),
        { presentation: 'dropdown', kind: 'count', scope: 'preset-count' });
      if (selected != null) {
        if (!['2', '3'].includes(selected)) throw Object.assign(new Error(), { code: 'MODE_COUNT_INVALID' });
        draft.count = Number(selected); while (draft.agents.length < draft.count) draft.agents.push(null); draft.dirty = true;
      }
    } else if (action === 'preset-save') {
      const agents = draft.agents.slice(0, draft.count);
      if (agents.some(agent => !agent)) throw Object.assign(new Error(), { code: 'MODE_INCOMPLETE' });
      if (JSON.stringify(this.read(this.mode) || null) !== draft.base) throw Object.assign(new Error(), { code: 'CONFLICT' });
      this.save(this.mode, agents); draft.base = JSON.stringify(this.read(this.mode) || null); draft.dirty = false;
      return `${modeSettings[this.mode].title} default saved · ${agents.length} agents. Ready for the next launch.`;
    } else {
      const match = /^preset-(model|effort):(\d)$/.exec(action), index = Number(match?.[2]);
      if (!match || index >= draft.count) return;
      const prior = draft.agents[index];
      if (match[1] === 'effort' && !prior) throw Object.assign(new Error(), { code: 'MODE_MODEL_REQUIRED' });
      const current = { ...prior, cwd: this.ui.tui.cwd || process.cwd(), selectedEffort: prior?.effort || 'default', modelCapabilities: prior?.capabilities };
      const selection = match[1] === 'model'
        ? await this.modelPicker(current, this.ui, { title: modeSettings[this.mode].roles[index] + ' · Model', scope: `preset:${index}` })
        : await this.effortPicker(current, this.ui, { scope: `preset:${index}` });
      if (selection) { draft.agents[index] = { ...prior, ...selection }; draft.dirty = true; }
    }
  }
}
