import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { referenceToken, referenceCatalog, insertReference } from '../src/reference-completions.js';
import { createChatSession, startConversationGoal } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { createSkill, setSkillEnabled, skillCatalogInstructions } from '@bzzy/core/engine/skills.js';
import { saveSubagentDefinition, setSubagentEnabled } from '@bzzy/core/engine/subagent-definitions.js';
import { listRecords } from '@bzzy/core/engine/database.js';
import { loadSession } from '@bzzy/core/engine/store.js';

let directory, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-reference-picker-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function terminal({ minimal = false } = {}) {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 24, columns: 80 }); output.resume();
  const ui = new UI({ input, output, error: output, minimal });
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const session = createChatSession(getProvider('codex'), { cwd, model: 'fixture-model' });
  ui.setSession(session.id); ui.updateSession(session);
  return { ui, input, output, session };
}
function skill(session, name, scope = 'project', enabled = true) {
  const options = { session, scope }, created = createSkill({ name, description: 'Write a clear finding report with observed evidence.',
    instructions: 'Describe the observed behavior, impact, evidence and reproduction steps. Preserve uncertainty.' }, options);
  return enabled ? setSkillEnabled(name, true, created.revision, options) : created;
}
const specialist = (cwd, name, scope = 'project') => saveSubagentDefinition({ name, description: 'Review finding reports and evidence.',
  instructions: 'Review the supplied report and identify unsupported claims. Return evidence references and uncertainty.' }, { cwd, scope });

test('reference trigger follows the cursor and leaves escaped dollars, currency and shell syntax literal', () => {
  for (const value of ['cost $100', 'echo $HOME', 'echo ${name}', 'echo $(pwd)', 'escaped \\$report', 'prefix$report'])
    assert.equal(referenceToken(value, [...value].length), null, value);
  const value = '/goal check 🐝 then use \'$how_to_write\' for the report';
  const cursor = [...value.slice(0, value.indexOf("' for"))].length;
  const token = referenceToken(value, cursor);
  assert.equal(token.query, 'how-to-write');
  assert.equal([...value].slice(token.start, token.end).join(''), '$how_to_write');
});

test('picker matches Core enabled catalogs, project overrides and execution scope without enabling anything', () => {
  const { ui, session } = terminal();
  try {
    skill(session, 'write-report', 'global');
    skill(session, 'write-report', 'project', false);
    const usable = skill(session, 'how-to-write-a-report');
    skill(session, 'unreviewed-report', 'global', false);
    specialist(session.cwd, 'report-reviewer', 'global');
    const local = specialist(session.cwd, 'report-reviewer');
    setSubagentEnabled(local.name, false, { cwd: session.cwd, scope: 'project', expectedRevision: local.revision });
    const agent = specialist(session.cwd, 'evidence-reviewer');
    const items = referenceCatalog(ui, 'report').choices;
    assert.deepEqual(items.map(item => [item.referenceKind, item.name]), [['agent', agent.name], ['skill', usable.name]]);
    assert.match(skillCatalogInstructions({ session }), /how-to-write-a-report/);
    assert.equal(items.find(item => item.id === usable.id).insertText, '$how-to-write-a-report');
    assert.equal(items.find(item => item.id === agent.id).insertText, 'subagent evidence-reviewer');
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

for (const minimal of [false, true]) test(`Enter inserts a filtered skill into the full goal draft without submitting (${minimal ? 'minimal' : 'ordinary'})`, async () => {
  const { ui, input, output, session } = terminal({ minimal });
  try {
    skill(session, 'how-to-write-a-report'); specialist(session.cwd, 'report-reviewer');
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    input.write('/goal find a real vuln; then use $how_to');
    for (const [columns, rows] of [[80, 24], [60, 18], [120, 36]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /Skills & agents/); assert.match(frame, /\$how-to-write-a-report/);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
      const hit = ui.tui.hitTargets.find(item => item.type === 'command' && item.choice.kind === 'reference');
      assert.ok(hit); assert.ok(hit.row < ui.tui.composerRow);
    }
    input.write('\r');
    assert.equal(ui.tui.value, '/goal find a real vuln; then use $how-to-write-a-report ');
    assert.ok(ui.tui.resolveInput, 'selecting never starts the goal');
    assert.equal(listRecords('execution').length, 0);
    input.write('to write the report\r');
    const submitted = await answer;
    assert.equal(submitted, '/goal find a real vuln; then use $how-to-write-a-report to write the report');
    const saved = startConversationGoal(session, {}, submitted.slice(6));
    assert.equal(saved.goal.objective, submitted.slice(6));
    assert.equal(loadSession(session.id).goal.objective, submitted.slice(6));
  } finally { ui.close(); }
});

test('mouse and Tab insert references at the cursor, preserving Unicode, quotes, later text and Escape dismissal', async () => {
  const { ui, input, session } = terminal();
  try {
    const report = skill(session, 'write-report'); specialist(session.cwd, 'report-reviewer');
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    ui.tui.value = "/goal inspect 🐝 with '$rep' and keep the suffix";
    ui.tui.cursor = [...ui.tui.value.slice(0, ui.tui.value.indexOf("' and"))].length;
    ui.tui.render();
    const hit = ui.tui.hitTargets.find(item => item.type === 'command' && item.choice.referenceKind === 'agent');
    assert.ok(hit); ui.tui.mouse(0, hit.left, hit.row);
    assert.equal(ui.tui.value, "/goal inspect 🐝 with 'subagent report-reviewer' and keep the suffix");
    assert.equal(ui.tui.cursor, [..."/goal inspect 🐝 with 'subagent report-reviewer"].length);
    assert.ok(ui.tui.resolveInput);
    ui.tui.value += ' $write'; ui.tui.cursor = [...ui.tui.value].length;
    input.write('\t');
    assert.ok(ui.tui.value.endsWith('$write-report '));
    input.write('$write'); ui.tui.key('', { name: 'escape' });
    const draft = ui.tui.value; assert.deepEqual(ui.tui.completions(), []);
    assert.equal(ui.tui.value, draft); assert.ok(ui.tui.resolveInput);
    assert.equal(report.enabled, true); ui.tui.finish(null); assert.equal(await answer, null);
  } finally { ui.close(); }
});

test('selection rechecks availability and the current conversation before changing the draft', () => {
  const { ui, session } = terminal();
  try {
    const report = skill(session, 'write-report');
    const choice = referenceCatalog(ui, 'write').choices[0], draft = '/goal use $write';
    setSkillEnabled(report.name, false, report.revision, { session });
    assert.throws(() => insertReference(ui, draft, [...draft].length, choice), /unavailable/);
    setSkillEnabled(report.name, true, report.revision + 1, { session });
    const other = path.join(directory, 'other'); fs.mkdirSync(other);
    const next = createChatSession(getProvider('codex'), { cwd: other, model: 'fixture-model' });
    ui.setSession(next.id); ui.updateSession(next);
    assert.throws(() => insertReference(ui, draft, [...draft].length, choice), /unavailable/);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('a draft composed during background work supports the picker without submitting or interrupting work', () => {
  const { ui, input, session } = terminal();
  try {
    skill(session, 'write-report'); specialist(session.cwd, 'report-reviewer');
    ui.tui.busy = true;
    input.write('/goal use $');
    const items = ui.tui.completions(); assert.equal(items.length, 2);
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
    assert.equal(ui.tui.value, '/goal use $write-report ');
    assert.equal(ui.tui.busy, true); assert.deepEqual(ui.tui.inputQueue, []);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

for (const kind of ['skill', 'agent']) test(`${kind === 'agent' ? 'an agent' : 'a skill'} found by description remains selectable beyond the first name-search page`, async () => {
  const { ui, input, session } = terminal();
  try {
    for (let index = 0; index < 100; index++) {
      const name = `a${String(index).padStart(3, '0')}-write-report`;
      if (kind === 'skill') skill(session, name, 'global');
      else specialist(session.cwd, name, 'global');
    }
    if (kind === 'skill') {
      const created = createSkill({ name: 'write-report', description: 'Unique description keyword: end-of-catalog.',
        instructions: 'Write the report using the provided observations and uncertainty.' }, { scope: 'global' });
      setSkillEnabled(created.name, true, created.revision, { scope: 'global' });
    } else saveSubagentDefinition({ name: 'write-report', description: 'Unique description keyword: end-of-catalog.',
      instructions: 'Review the provided report and identify unsupported statements.' }, { scope: 'global' });
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    input.write('/goal use $'); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /100\/101 · type to filter/);
    input.write('end-of-catalog');
    assert.equal(ui.tui.completions()[0].name, 'write-report');
    input.write('\r');
    assert.equal(ui.tui.value, '/goal use ' + (kind === 'skill' ? '$write-report ' : 'subagent write-report '));
    assert.ok(ui.tui.resolveInput); ui.tui.finish(null); await answer;
  } finally { ui.close(); }
});
