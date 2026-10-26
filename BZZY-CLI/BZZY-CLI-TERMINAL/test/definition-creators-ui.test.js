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
import { createDefinitionCommand } from '../src/definition-creator-ui.js';
import { commandSuggestions, privateChatCommand } from '../src/terminal-commands.js';

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
    assert.ok(!skillRows(ui).some(row => row.action === 'creator'));
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
    assert.equal(ui.tui.panel, 'skills'); assert.ok(!skillRows(ui).some(row => row.action === 'creator'));
  } finally { ui.close(); }
});

for (const kind of ['skill', 'agent']) test(`/create-${kind} asks only for a name and publishes an immediately available global definition`, async () => {
  const { ui, session, events } = terminal();
  try {
    ui.tui.value = 'keep unsent text'; ui.tui.cursor = 4;
    let prompts = 0;
    ui.ask = async question => { prompts++; assert.match(question, /name/); return definition.name; };
    assert.equal(await createDefinitionCommand(`/create-${kind} quiero revisar respuestas HTTP con evidencia`, ui, { generate }), true);
    assert.equal(prompts, 1);
    const saved = kind === 'skill' ? listSkills({ scope: 'global', enabledOnly: true }).skills[0]
      : listSubagentDefinitions({ scope: 'global', enabledOnly: true }).subagents[0];
    assert.equal(saved.name, definition.name); assert.equal(saved.enabled, true); assert.equal(saved.scope, 'global');
    assert.equal(saved.provider, undefined); assert.equal(saved.model, undefined);
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
    assert.equal(ui.tui.value, 'keep unsent text'); assert.equal(ui.tui.cursor, 4);
    assert.ok(events.some(event => event.message?.includes('BZZY Core · ON')));
    assert.equal(events.filter(event => event.type === 'error').length, 0);
    assert.equal(ui.definitionAuthoring, null); assert.equal(ui.cancelDefinitionAuthoring, undefined);
    assert.equal(listSkills({ session }).total, kind === 'skill' ? 1 : 0);
  } finally { ui.close(); }
});

test('native creation commands are private, discoverable with hyphens, and routed by the real chat UI without starting inference on cancel', async () => {
  assert.deepEqual(commandSuggestions('/create-').map(item => item.command), ['/create-skill', '/create-agent']);
  for (const command of ['/create-skill', '/create-agent']) {
    assert.equal(privateChatCommand(command + ' private requirements'), true);
    const { ui } = terminal();
    try {
      const sessionsBefore = listRecords('session').length;
      const pending = ui.settingsCommand(command + ' revisar headers');
      await until(() => ui.tui.promptDraft && /Creator.*name/.test(ui.tui.question));
      ui.tui.render(); assert.match(clean(ui.tui.lastFrame.join('\n')), /Creator.*name/);
      ui.tui.key('', { name: 'escape' }); assert.equal(await pending, true);
      assert.equal(listRecords('session').length, sessionsBefore); assert.equal(listRecords('execution').length, 0);
      assert.equal(ui.tui.history.some(value => value.includes('private requirements')), false);
    } finally { ui.close(); }
  }
});

test('native creator cancellation and terminal navigation discard a completed model document before publication', async () => {
  for (const mode of ['cancel', 'navigation', 'closed']) {
    const { ui, session } = terminal();
    try {
      ui.ask = async () => definition.name;
      let complete;
      const pending = createDefinitionCommand('/create-skill revisar headers HTTP', ui, { generate: async input => {
        const draft = await generate(input);
        await new Promise(resolve => { complete = resolve; }); return draft;
      } });
      await until(() => complete);
      if (mode === 'cancel') ui.tui.key('', { name: 'escape' });
      else if (mode === 'navigation') ui.nextSession = { id: 'different-chat' };
      else ui.closed = true;
      complete(); await pending;
      assert.equal(listSkills({ session }).total, 0); assert.equal(listSubagentDefinitions({ scope: 'global' }).total, 0);
      assert.equal(ui.cancelDefinitionAuthoring, undefined);
      ui.closed = false;
    } finally { ui.close(); }
  }
});

test('native creator rejects unsafe requirements before inference, never overwrites names, and rejects stale model selections', async () => {
  const { ui, session, events } = terminal();
  try {
    ui.ask = async () => definition.name;
    let calls = 0;
    const checkedGenerate = input => authorDefinition({ ...input, runModel: async () => { calls++; return { text: JSON.stringify(definition) }; } });
    await createDefinitionCommand('/create-skill password=fixture-private-value', ui, { generate: checkedGenerate });
    assert.equal(calls, 0); assert.equal(listSkills({ session }).total, 0);
    await createDefinitionCommand('/create-skill revisar headers', ui, { generate: checkedGenerate });
    assert.equal(calls, 1); const before = listSkills({ scope: 'global' }).skills[0];
    await createDefinitionCommand('/create-skill revisar otros headers', ui, { generate: checkedGenerate });
    assert.equal(calls, 1); assert.deepEqual(listSkills({ scope: 'global' }).skills[0], before);
    ui.ask = async () => { session.model = 'changed-model'; saveSession(session); return 'different-name'; };
    await createDefinitionCommand('/create-agent revisar Android', ui, { generate: checkedGenerate });
    assert.equal(calls, 1); assert.equal(listSubagentDefinitions({ scope: 'global' }).total, 0);
    assert.ok(events.some(event => event.type === 'error' && /selected model changed/.test(event.message)));
    assert.equal(JSON.stringify(events).includes('fixture-private-value'), false);
  } finally { ui.close(); }
});
