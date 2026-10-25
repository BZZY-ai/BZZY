import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import readline from 'node:readline';
import { UI } from '../src/ui.js';
import { escapeInputKind, TerminalKeyInput } from '../src/terminal-keys.js';
import { clean } from '../src/terminal-format.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 100));
function terminal(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-escape-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 120, rows: 36 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  ui.updateSession({ id: ui.sessionId, alias: 'Escape test', cwd: directory, provider: 'codex', model: 'test' });
  ui.tui.value = 'an unsent draft'; ui.tui.cursor = 5;
  t.after(() => { ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { ui, input, tui: ui.tui };
}

test('actual Escape bytes return every menu to chat and preserve the draft', async t => {
  const { ui, input, tui } = terminal(t); tui.mode = 'besties';
  for (const panel of tui.panels().filter(panel => panel !== 'chat')) {
    tui.setPanel(panel); assert.equal(tui.panel, panel);
    input.write('\x1b'); await settle();
    assert.equal(tui.panel, 'chat', panel); assert.equal(tui.value, 'an unsent draft', panel); assert.equal(tui.cursor, 5, panel);
  }
  for (const page of ['main', 'core', 'modes', 'pair', 'approve']) {
    ui.openSettings(); ui.settings.page = page; ui.settings.qrView = true;
    input.write('\x1b[27u'); await settle();
    assert.equal(tui.panel, 'chat', page); assert.equal(ui.settings.qrView, false); assert.equal(tui.value, 'an unsent draft');
  }
});

test('one modern Escape cancels only the picker, including split packets and press/release batches', async t => {
  const { ui, input, tui } = terminal(t);
  const packets = [ ['\x1b[27u'], ['\x1b[27;1:1u'], ['\x1b[27;3;27~'], ['\x1b[', '27;1:1u'], ['\x1b[27;1:1u\x1b[27;1:2u\x1b[27;1:3u'] ];
  for (const chunks of packets) {
    ui.openSettings();
    const picked = ui.chooseOne('Choose model', { choices: [{ value: 'one', label: 'One' }] }, { kind: 'model', presentation: 'dropdown' });
    await Promise.resolve();
    for (const chunk of chunks) { input.write(chunk); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(await picked, null); await settle();
    assert.equal(tui.panel, 'settings', JSON.stringify(chunks)); assert.equal(tui.value, ''); assert.equal(tui.inputQueue.length, 0);
    input.write('\x1b'); await settle(); assert.equal(tui.value, 'an unsent draft');
  }
});

test('Escape cancels private and menu prompts without leaking modern packet tails', async t => {
  const { ui, input, tui } = terminal(t);
  for (const panel of ['settings', 'skills', 'agents']) {
    tui.setPanel(panel);
    const draft = tui.value;
    const question = ui.ask('Describe the definition to create: '); await Promise.resolve();
    input.write('discarded description'); tui.render();
    assert.match(tui.lastFrame.map(clean).join('\n'), /Describe the definition to create/);
    assert.ok(tui.hitTargets.some(hit => hit.type === 'confirm'));
    input.write('\x1b[27;1:1u'); assert.equal(await question, null); await settle();
    assert.equal(tui.panel, panel); assert.equal(tui.value, draft); assert.equal(tui.inputQueue.length, 0);
    tui.setPanel('chat');
  }
  const secret = ui.secret('API key: '); await Promise.resolve(); input.write('discarded-private-fixture');
  input.write('\x1b[27;1:1u'); assert.equal(await secret, null); await settle();
  assert.equal(tui.value, 'an unsent draft'); assert.equal(tui.cursor, 5);
  assert.equal(tui.entries.some(entry => /discarded/.test(entry.text)), false);
  assert.equal(tui.history.some(entry => /discarded/.test(entry)), false);
});

test('Escape cancels generation and previews before leaving the library', async t => {
  const { ui, input, tui } = terminal(t);
  tui.setPanel('agents'); let cancelled = 0;
  ui.cancelDefinitionAuthoring = () => { cancelled++; delete ui.cancelDefinitionAuthoring; };
  input.write('\x1b[27u'); await settle(); assert.equal(cancelled, 1); assert.equal(tui.panel, 'agents');
  ui.subagentCreatorDraft = { id: 'unsaved' }; ui.subagentPreview = { id: 'unsaved' };
  input.write('\x1b[27u'); await settle(); assert.equal(tui.panel, 'agents'); assert.equal(ui.subagentCreatorDraft, null); assert.equal(ui.subagentPreview, null);
  input.write('\x1b[27u'); await settle(); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'an unsent draft');
  tui.setPanel('skills'); ui.skillPreview = { id: 'fixture' };
  input.write('\x1b[27u'); await settle(); assert.equal(tui.panel, 'skills'); assert.equal(ui.skillPreview, null);
  input.write('\x1b[27u'); await settle(); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'an unsent draft');
});

test('arrows, Alt chords, mouse packets and UTF-8 remain normal input; releases never navigate', async t => {
  const { ui, input, tui } = terminal(t); ui.openSettings();
  const originalFocus = ui.settings.focus;
  input.write('\x1b[B'); assert.notEqual(ui.settings.focus, originalFocus);
  input.write('\x1bx'); input.write('\x1b[27;1:2u'); input.write('\x1b[27;1:3u');
  for (let index = 0; index < 100; index++) input.write('\x1b[<35;1;1M');
  await settle(); assert.equal(tui.panel, 'settings'); assert.equal(tui.keyInput.pending, '');
  input.write('\x1b[<'); assert.equal(tui.mouseReport, '');
  input.write('\x1b'); await settle(); assert.equal(tui.panel, 'chat'); assert.equal(tui.mouseReport, null);
  tui.value = ''; tui.cursor = 0;
  const unicode = Buffer.from('🐝你'); input.write(unicode.subarray(0, 2)); input.write(unicode.subarray(2));
  assert.equal(tui.value, '🐝你');
});

test('raw normalization consumes each extended packet once and preserves other terminal events', async () => {
  const keys = [], escapes = [];
  const decoder = new TerminalKeyInput((text, key) => keys.push([text, key.name, key.meta]), (_text, key) => escapes.push(key.sequence));
  try {
    decoder.write('before\x1b[27;1:1uafter\x1b[27;1:3u\x1b[A\x1bx');
    await settle();
    assert.deepEqual(escapes, ['\x1b[27;1:1u']);
    assert.equal(keys.filter(([text]) => text).map(([text]) => text).join(''), 'beforeafter');
    assert.ok(keys.some(([_text, name]) => name === 'up'));
    assert.ok(keys.some(([_text, name, meta]) => name === 'x' && meta));
    for (const sequence of ['\x1b[27;1:2u', '\x1b[27;1:3u']) assert.equal(escapeInputKind('', { sequence }), 'ignore');
  } finally { decoder.close(); }
});

test('a setup readline left on stdin cannot duplicate typing or Escape', async t => {
  const { ui, input, tui } = terminal(t);
  // Authentication/setup can create readline on stdin before the full TUI.
  const previousReader = readline.createInterface({ input, terminal: false }); previousReader.close();
  readline.emitKeypressEvents(input, { escapeCodeTimeout: 50 });
  input.on('keypress', () => {}); input.resume();
  tui.value = ''; tui.cursor = 0; input.write('once'); assert.equal(tui.value, 'once');
  ui.openSettings();
  const picked = ui.chooseOne('Model', { choices: [{ value: 'one', label: 'One' }] }, { kind: 'model' }); await Promise.resolve();
  input.write('\x1b[27;1:1u'); assert.equal(await picked, null); await settle();
  assert.equal(tui.panel, 'settings'); assert.equal(tui.value, '');
  input.write('\x1b'); await settle(); assert.equal(tui.panel, 'chat'); assert.equal(tui.value, 'once');
});
