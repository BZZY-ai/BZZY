import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { subagentsCommand, subagentRows } from '../src/subagents-ui.js';
import { parseArgs } from '../src/cli.js';
import { commandSuggestions } from '../src/terminal-commands.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { listRecords, putRecord } from '@bzzy/core/engine/database.js';
import { saveSession } from '@bzzy/core/engine/store.js';
import { getSubagentDefinition, saveSubagentDefinition, listSubagentDefinitions } from '@bzzy/core/engine/subagent-definitions.js';

let directory, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-specialist-ui-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function terminal() {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 36, columns: 120 }); output.resume();
  const ui = new UI({ input, output, error: output });
  const session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture-model', effort: 'default' });
  ui.setSession(session.id); ui.updateSession(session);
  const events = [], originalEvent = ui.event.bind(ui);
  ui.event = (type, data) => { events.push({ type, ...data }); originalEvent(type, data); };
  return { ui, session, output, events };
}
const definition = (name = 'http-analyst') => ({ name, description: 'Analyze observed HTTP responses.',
  instructions: 'Inspect supplied responses. Return evidence references and uncertainty. Stay within the task scope.' });
const text = ui => subagentRows(ui).map(row => row.text).join('\n');
async function promptFor(ui, pattern) {
  for (let turn = 0; turn < 30; turn++) {
    if (ui.tui.resolveInput && pattern.test(ui.tui.question)) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`Expected prompt ${pattern}; got ${ui.tui.question}`);
}

test('top Agents action opens a keyboard-accessible library and preserves the unsent chat draft', async () => {
  const { ui, output } = terminal();
  try {
    ui.tui.value = 'keep this draft'; ui.tui.cursor = 4;
    ui.hostMetrics = { host: { cpuPercent: 27, memory: { usedBytes: 5.4 * 1024 ** 3, totalBytes: 32 * 1024 ** 3 } } };
    for (const columns of [80, 100, 120, 140]) {
      output.columns = columns; ui.tui.render();
      assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'top-agents'), `Agents missing at ${columns}`);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) <= columns - 1));
      assert.match(clean(ui.tui.lastFrame[0]), /CPU.*5\.4\/32G/);
    }
    const input = ui.ask('bzzy › '); await Promise.resolve();
    const target = ui.tui.hitTargets.find(hit => hit.type === 'top-agents');
    ui.tui.mouse(0, target.left, target.row);
    assert.equal(await input, '/agents');
    await ui.settingsCommand('/agents'); ui.tui.render();
    assert.equal(ui.tui.panel, 'agents'); assert.equal(ui.tui.canCompose(), false);
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /AGENTS.*reusable specialists/);
    assert.equal(ui.tui.value, 'keep this draft');
    ui.tui.key('', { name: 'escape' });
    assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'keep this draft');
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('specialist editor shows its question and Confirm action, accepts multiline instructions and restores the chat draft', async () => {
  const { ui, output } = terminal();
  try {
    Object.assign(output, { columns: 80, rows: 24 });
    ui.tui.value = 'Keep my typed investigation context'; ui.tui.cursor = 5;
    const choices = ['project', 'inherit']; ui.chooseOne = async () => choices.shift();
    const creating = subagentsCommand('/agents create', ui);
    await promptFor(ui, /^Specialist name/);
    ui.tui.key('multiline-specialist', {}); ui.tui.key('', { name: 'return' });
    await promptFor(ui, /^When should/);
    ui.tui.key('Inspect supplied evidence.', {}); ui.tui.key('', { name: 'return' });
    await promptFor(ui, /^Specialist instructions/);
    ui.tui.key('Inspect the supplied responses.', {}); ui.tui.key('', { name: 'return', shift: true });
    ui.tui.key('Return uncertain findings with references.', {}); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Specialist instructions/);
    assert.match(ui.tui.value, /responses\.\nReturn/);
    const confirm = ui.tui.hitTargets.find(hit => hit.type === 'confirm'); assert.ok(confirm);
    ui.tui.mouse(0, confirm.left, confirm.row);
    await creating;
    assert.equal(getSubagentDefinition('multiline-specialist', { cwd: directory }).instructions,
      'Inspect the supplied responses.\nReturn uncertain findings with references.');
    assert.equal(ui.tui.value, 'Keep my typed investigation context'); assert.equal(ui.tui.cursor, 5);
    const cancelled = subagentsCommand('/agents create', ui);
    await promptFor(ui, /^Specialist name/);
    ui.tui.key('discard-me', {}); ui.tui.key('', { name: 'escape' }); await cancelled;
    assert.equal(ui.tui.value, 'Keep my typed investigation context'); assert.equal(ui.tui.cursor, 5);
    assert.equal(listSubagentDefinitions({ cwd: directory }).total, 1);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('Use in chat while a response is active creates only an editable draft', async () => {
  const { ui } = terminal();
  try {
    saveSubagentDefinition(definition(), { cwd: directory });
    await subagentsCommand('/agents view:project:http-analyst', ui);
    ui.tui.busy = true; ui.tui.value = 'Keep existing text'; ui.tui.cursor = [...ui.tui.value].length;
    const runningInput = ui.ask('bzzy (running) › '); await promptFor(ui, /^bzzy/); ui.tui.render();
    const action = ui.tui.hitTargets.find(hit => hit.type === 'agent-action' && hit.action === 'use'); assert.ok(action);
    ui.tui.mouse(0, action.left, action.row);
    assert.equal(await runningInput, '/agents use');
    const using = ui.settingsCommand('/agents use'); await promptFor(ui, /^Task for http-analyst/);
    ui.tui.key('Inspect the captured response artifacts.', {}); ui.tui.key('', { name: 'return' }); await using;
    assert.equal(ui.tui.panel, 'chat');
    assert.equal(ui.tui.value, 'Keep existing text\n\nUse subagent http-analyst for this task: Inspect the captured response artifacts.');
    assert.equal(ui.tui.inputQueue.length, 0); assert.equal(ui.pendingChatInputs?.length || 0, 0);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('create and use a specialist without starting inference or binding it to the current provider', async () => {
  const { ui, session, events } = terminal();
  try {
    const answers = ['http-analyst', 'Analyze observed HTTP responses.', 'Inspect supplied responses and record uncertain findings.'];
    const choices = ['project', 'inherit'];
    ui.ask = async () => answers.shift(); ui.chooseOne = async () => choices.shift();
    await subagentsCommand('/agents create', ui);
    const saved = getSubagentDefinition('http-analyst', { cwd: directory });
    assert.equal(saved.provider, undefined); assert.equal(saved.model, undefined); assert.equal(saved.effort, undefined);
    assert.equal(saved.scope, 'project'); assert.match(text(ui), /Inherit the invoking chat/);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
    ui.tui.value = 'Existing typed context';
    ui.ask = async () => 'Inspect the recorded response artifacts.';
    await subagentsCommand('/agents use', ui);
    assert.equal(ui.tui.panel, 'chat');
    assert.equal(ui.tui.value, 'Existing typed context\n\nUse subagent http-analyst for this task: Inspect the recorded response artifacts.');
    assert.equal(listRecords('execution').length, 0);
    session.provider = 'deepseek'; session.model = 'fixture-alternative'; saveSession(session); ui.updateSession(session);
    await subagentsCommand('/agents', ui);
    assert.match(text(ui), /http-analyst/); assert.match(text(ui), /Inherit the invoking chat/);
  } finally { ui.close(); }
});

test('editing preserves narrowed policies, uses a displayed revision, and rejects a stale detail action', async () => {
  const { ui, events } = terminal();
  try {
    const saved = saveSubagentDefinition({ ...definition(), policy: { mode: 'read-only', network: 'disabled' }, limits: { runtimeSeconds: 45 } }, { cwd: directory });
    await subagentsCommand('/agents view:project:http-analyst', ui);
    const answers = ['A reviewed HTTP specialist.', 'Inspect evidence, distinguish hypotheses and return references.'];
    ui.ask = async (_question, options) => { assert.ok(options.initialValue); return answers.shift(); };
    ui.chooseOne = async () => 'inherit';
    await subagentsCommand('/agents edit', ui);
    const edited = getSubagentDefinition(saved.name, { cwd: directory });
    assert.equal(edited.revision, 2); assert.deepEqual(edited.policy, saved.policy); assert.deepEqual(edited.limits, saved.limits);
    saveSubagentDefinition({ ...definition(), description: 'Changed independently.' }, { cwd: directory, expectedRevision: edited.revision });
    let asked = false; ui.ask = async () => { asked = true; return 'task'; };
    await subagentsCommand('/agents use', ui);
    assert.equal(asked, false); assert.match(events.at(-1).message, /changed.*Reopen/);
  } finally { ui.close(); }
});

test('conversation changes during creation cannot save specialist instructions into another project', async () => {
  const { ui, events } = terminal();
  try {
    const other = path.join(directory, 'other'); fs.mkdirSync(other);
    ui.ask = async () => {
      const second = createChatSession(getProvider('codex'), { cwd: other, model: 'other-model' });
      ui.setSession(second.id); ui.updateSession(second);
      return 'cross-project-specialist';
    };
    await subagentsCommand('/agents create', ui);
    assert.match(events.at(-1).message, /Conversation changed/);
    assert.equal(listSubagentDefinitions({ cwd: other }).total, 0);
    assert.equal(listSubagentDefinitions({ cwd: directory }).total, 0);
  } finally { ui.close(); }
});

test('fixed provider/model selection comes from existing selectors while management stays idle', async () => {
  const { ui, events } = terminal();
  try {
    const answers = ['response-reviewer', 'Review HTTP responses.', 'Inspect the supplied evidence.'];
    const choices = ['global', 'fixed'];
    ui.ask = async () => answers.shift(); ui.chooseOne = async () => choices.shift();
    ui.chooseProvider = async () => getProvider('claude');
    ui.chooseModel = async selected => { assert.equal(selected.provider, 'claude'); return { model: 'fixture-claude', effort: 'high' }; };
    await subagentsCommand('/agents create', ui);
    const saved = getSubagentDefinition('response-reviewer', { cwd: directory, scope: 'global' });
    assert.equal(saved.provider, 'claude'); assert.equal(saved.model, 'fixture-claude'); assert.equal(saved.effort, 'high');
    assert.equal(events.filter(event => event.type === 'error').length, 0); assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('deletion is explicit and revision checked, and CLI-specific flags reach the Core command', async () => {
  const { ui } = terminal();
  try {
    saveSubagentDefinition(definition(), { cwd: directory });
    await subagentsCommand('/subagents view:project:http-analyst', ui);
    ui.chooseOne = async () => 'cancel'; await subagentsCommand('/agents delete', ui);
    assert.equal(getSubagentDefinition('http-analyst', { cwd: directory }).revision, 1);
    ui.chooseOne = async () => 'delete'; await subagentsCommand('/agents delete', ui);
    assert.throws(() => getSubagentDefinition('http-analyst', { cwd: directory }), /removed/);
    const parsed = parseArgs(['--cwd', directory, 'subagents', 'update', 'specialist.json', '--revision', '3', '--global', '--json']);
    assert.deepEqual(parsed.args, ['subagents', 'update', 'specialist.json', '--revision', '3', '--global']);
    assert.equal(parsed.options.json, true);
    assert.ok(commandSuggestions('/ag').some(choice => choice.command === '/agents'));
  } finally { ui.close(); }
});

test('invocation views and chat notices retain specialist identity and scope results to the current conversation', async () => {
  const { ui, session } = terminal();
  try {
    const saved = saveSubagentDefinition(definition(), { cwd: directory }), id = randomUUID();
    const job = { id, parentSessionId: session.id, goalId: null, subagentDefinition: saved, createdAt: new Date().toISOString(),
      closure: 'open', currentRound: 1, contract: { objective: 'Inspect the recorded response.' }, selection: { provider: 'codex', model: 'fixture-model' } };
    putRecord('assignment', id, job);
    putRecord('round', `${id}:1`, { assignmentId: id, number: 1, state: 'awaiting_review', summary: 'Candidate requires an independent check.',
      report: { status: 'partial', uncertainties: ['Rendering behavior remains untested.'] } });
    ui.event('assignment.created', job); ui.event('assignment.started', { id, round: 1 });
    ui.event('assignment.finished', { id, round: 1, state: 'awaiting_review', report: { summary: 'Candidate requires an independent check.' } });
    assert.ok(ui.tui.entries.some(entry => /Subagent http-analyst/.test(entry.text)));
    await subagentsCommand('/agents runs', ui);
    assert.match(text(ui), /http-analyst.*awaiting_review/); assert.match(text(ui), /claims until/);
    await subagentsCommand('/agents run:' + id, ui);
    assert.match(text(ui), /Rendering behavior remains untested/); assert.match(text(ui), /do not establish verified completion/);
    const unrelated = randomUUID(); putRecord('assignment', unrelated, { ...job, id: unrelated, parentSessionId: randomUUID() });
    putRecord('round', `${unrelated}:1`, { number: 1, state: 'awaiting_review', summary: 'PRIVATE_OTHER_CHAT_RESULT' });
    await subagentsCommand('/agents run:' + unrelated, ui);
    assert.doesNotMatch(text(ui), /PRIVATE_OTHER_CHAT_RESULT/); assert.match(text(ui), /no longer available/);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('the actual CLI routes definition creation and revision updates without starting Core or a model', () => {
  const filename = path.join(directory, 'specialist.json'); fs.writeFileSync(filename, JSON.stringify(definition()));
  const invoke = args => {
    const result = spawnSync(process.execPath, ['bin/bzzy.js', '--json', '--cwd', directory, 'subagents', ...args],
      { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, BZZY_HOME: process.env.BZZY_HOME }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  assert.match(invoke(['create', filename, '--global']), /http-analyst/);
  fs.writeFileSync(filename, JSON.stringify({ ...definition(), description: 'Updated HTTP specialist.' }));
  assert.match(invoke(['update', filename, '--revision', '1', '--global']), /Updated HTTP specialist/);
  assert.equal(getSubagentDefinition('http-analyst', { cwd: directory, scope: 'global' }).revision, 2);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});
