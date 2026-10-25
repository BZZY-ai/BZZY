import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean } from '../src/terminal-format.js';
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { subagentsCommand, subagentRows } from '../src/subagents-ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { saveSession } from '@bzzy/core/engine/store.js';
import { authorDefinition } from '@bzzy/core/engine/definition-authoring.js';
import { listSkills } from '@bzzy/core/engine/skills.js';
import { listSubagentDefinitions } from '@bzzy/core/engine/subagent-definitions.js';
import { listRecords } from '@bzzy/core/engine/database.js';

let root, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-creator-ui-')));
  process.env.BZZY_HOME = path.join(root, 'private');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
function terminal() {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 36, columns: 120 }); output.resume();
  const ui = new UI({ input, output, error: output });
  const session = createChatSession(getProvider('claude'), { cwd: root, model: 'current-selected-model', effort: 'low' });
  ui.setSession(session.id); ui.updateSession(session); ui.openTerminal();
  const events = []; ui.event = (type, data) => events.push({ type, ...data });
  return { ui, session, events };
}
const definition = { name: 'http-reviewer', description: 'Analyze supplied HTTP responses.',
  instructions: 'Inspect the supplied response text. Compare controlled baselines and return a concise set of observations with evidence references, confidence, missing inputs and uncertainty. Do not treat unverified claims as a confirmed result.' };
const answerForm = ui => {
  const answers = ['http-reviewer', 'Analyze HTTP responses.', 'Input: supplied text. Output: observations with evidence.'];
  ui.ask = async () => answers.shift(); ui.chooseOne = async () => 'project';
};
const generate = async input => authorDefinition({ ...input, runModel: async args => {
  assert.equal(args.selection.provider, 'claude'); assert.equal(args.selection.model, 'current-selected-model'); assert.equal(args.selection.effort, 'low');
  return { text: JSON.stringify(definition), tokens: 100 };
} });
async function until(condition) {
  for (let turn = 0; turn < 40; turn++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Expected creator state was not reached.');
}

test('Skill Creator is accessible, reviews the selected-model draft and saves only on Save', async () => {
  const { ui, session, events } = terminal();
  try {
    ui.tui.value = 'unsent chat draft'; ui.tui.cursor = 5;
    await skillsCommand('/skills', ui);
    assert.ok(skillRows(ui).some(row => row.action === 'creator'));
    answerForm(ui);
    await skillsCommand('/skills creator', ui, { generateDefinition: generate });
    const rows = skillRows(ui);
    assert.ok(rows.some(row => row.action === 'creator-save')); assert.match(rows.map(row => row.text).join('\n'), /claude · current-selected-model · low effort/);
    assert.equal(listSkills({ session }).total, 0);
    await skillsCommand('/skills creator-save', ui);
    assert.equal(listSkills({ session }).total, 1); assert.equal(listSkills({ session }).skills[0].enabled, false);
    ui.tui.setPanel('chat'); assert.equal(ui.tui.value, 'unsent chat draft'); assert.equal(ui.tui.cursor, 5);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('Agent Creator draft is reviewable, discarded by Esc, and saves inherited-model specialists', async () => {
  const { ui, events } = terminal();
  try {
    answerForm(ui); await subagentsCommand('/agents creator', ui, { generateDefinition: generate });
    assert.ok(subagentRows(ui).some(row => row.action === 'creator-save'));
    assert.equal(listSubagentDefinitions({ cwd: root }).total, 0);
    ui.tui.key('', { name: 'escape' });
    assert.equal(ui.subagentCreatorDraft, null); assert.equal(ui.tui.panel, 'agents');
    answerForm(ui); await subagentsCommand('/agents creator', ui, { generateDefinition: generate });
    await subagentsCommand('/agents creator-save', ui);
    const saved = listSubagentDefinitions({ cwd: root }).subagents[0];
    assert.equal(saved.name, 'http-reviewer'); assert.equal(saved.model, undefined); assert.equal(saved.provider, undefined);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
  } finally { ui.close(); }
});

test('Escape during generation aborts it, preserves the chat draft and writes no artifacts', async () => {
  for (const [command, prefix] of [[skillsCommand, '/skills'], [subagentsCommand, '/agents']]) {
    const { ui, session } = terminal();
    try {
      ui.tui.value = 'keep draft'; ui.tui.cursor = 3; answerForm(ui);
      let signal;
      const pending = command(prefix + ' creator', ui, { generateDefinition: async input => {
        signal = input.signal;
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } });
      await until(() => ui.cancelDefinitionAuthoring);
      const key = { name: 'escape' }; ui.tui.key('', key); await pending;
      assert.equal(signal.aborted, true); assert.equal(key.bzzyHandled, true); assert.equal(ui.cancelDefinitionAuthoring, undefined);
      assert.ok(!ui.skillCreatorDraft && !ui.subagentCreatorDraft);
      assert.equal(listSkills({ session }).total, 0); assert.equal(listSubagentDefinitions({ cwd: root }).total, 0);
      ui.tui.setPanel('chat'); assert.equal(ui.tui.value, 'keep draft'); assert.equal(ui.tui.cursor, 3);
    } finally { ui.close(); }
  }
});

test('a model change during the input form prevents any generation and preview Save rejects a changed model', async () => {
  const { ui, session, events } = terminal();
  try {
    let calls = 0;
    ui.ask = async () => { session.model = 'new-selection'; saveSession(session); return 'http-reviewer'; };
    await skillsCommand('/skills creator', ui, { generateDefinition: async () => { calls++; } });
    assert.equal(calls, 0); assert.match(events.at(-1).message, /selected model changed/);
    session.model = 'current-selected-model'; saveSession(session); answerForm(ui);
    await subagentsCommand('/agents creator', ui, { generateDefinition: generate });
    session.selectedEffort = 'high'; saveSession(session);
    await subagentsCommand('/agents creator-save', ui);
    assert.equal(listSubagentDefinitions({ cwd: root }).total, 0); assert.match(events.at(-1).message, /selected model changed/);
  } finally { ui.close(); }
});

test('Skills creator prompts render their question and Escape restores the library', async () => {
  const { ui } = terminal();
  try {
    const pending = skillsCommand('/skills creator', ui, { generateDefinition: generate });
    await until(() => ui.tui.promptDraft && /Skill Creator/.test(ui.tui.question));
    ui.tui.render(); const frame = clean(ui.tui.lastFrame.join('\n'));
    assert.match(frame, /Skill Creator.*name/); assert.match(frame, /Confirm/);
    ui.tui.key('', { name: 'escape' }); await pending;
    assert.equal(ui.tui.panel, 'skills'); assert.ok(skillRows(ui).some(row => row.action === 'creator'));
  } finally { ui.close(); }
});
