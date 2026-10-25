import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { saveSubagentDefinition } from '@bzzy/core/engine/subagent-definitions.js';
import { listRecords } from '@bzzy/core/engine/database.js';

let directory, previousHome, session, terminals;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-invocation-chat-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); terminals = [];
  session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture-model', effort: 'default' });
});
test.afterEach(() => {
  for (const term of terminals) term.ui.close();
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function terminal({ tty = true, minimal = false, json = false } = {}) {
  const input = new PassThrough(); Object.assign(input, { isTTY: tty, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: tty, columns: 100, rows: 40 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output, minimal, json, pet: false });
  ui.setSession(session.id); ui.updateSession(session);
  if (ui.tui) { ui.tui.value = 'Keep my unsent investigation draft'; ui.tui.cursor = 7; }
  const term = { ui, output, get written() { return written; } }; terminals.push(term); return term;
}
const frame = ui => ui.tui.lastFrame.map(clean).join('\n');
const cards = ui => ui.tui.entries.filter(entry => entry.kind === 'invocation');
function skill(overrides = {}) {
  return { id: 'a'.repeat(64), version: 1, kind: 'skill', sessionId: session.id, runId: randomUUID(), goalId: null,
    skillId: 'b'.repeat(64), name: 'http-response-review', skillVersion: 'c'.repeat(64), scope: 'project', projectId: null,
    rootSessionId: session.id, rootGoalId: null, attribution: 'chat', createdAt: new Date().toISOString(), ...overrides };
}
function agent(name = 'http-analyst') {
  const definition = saveSubagentDefinition({ name, description: 'Inspect supplied responses.', instructions: 'Compare supplied observations and preserve uncertainty.' }, { cwd: directory });
  return { id: randomUUID(), parentSessionId: session.id, goalId: null, subagentDefinition: definition,
    selection: { provider: 'deepseek', model: 'same-fixture-model' }, role: 'executor', closure: 'open', currentRound: 1,
    contract: { objective: 'PRIVATE_OBJECTIVE_MUST_NOT_APPEAR', context: 'PRIVATE_CONTEXT_MUST_NOT_APPEAR' }, createdAt: new Date().toISOString() };
}
function snapshot(job, state, extra = {}) {
  return { session, execution: null, invocations: { version: 1, truncated: false, agents: [{ id: job.id, parentSessionId: session.id,
    name: job.subagentDefinition.name, specialist: true, provider: job.selection.provider, model: job.selection.model,
    round: 1, state, closure: state === 'accepted' ? 'accepted' : 'open', ...extra }] } };
}

test('named agents update one visible chat card through review without claiming goal completion', () => {
  const { ui } = terminal(), job = agent(); ui.tui.showTools = false;
  ui.event('assignment.created', { ...job, seq: 10, eventSessionId: session.id }); ui.tui.render();
  assert.match(frame(ui), /Agent.*http-analyst.*Starting/i);
  ui.event('assignment.started', { id: job.id, round: 1, seq: 11, eventSessionId: session.id }); ui.tui.render();
  assert.match(frame(ui), /Agent.*http-analyst.*Running/i);
  ui.event('assignment.finished', { id: job.id, round: 1, state: 'awaiting_review', seq: 12, eventSessionId: session.id,
    report: { summary: 'PRIVATE_REPORT_MUST_NOT_APPEAR', workerClaim: 'complete' } }); ui.tui.render();
  assert.match(frame(ui), /Awaiting review/i); assert.doesNotMatch(frame(ui), /Goal achieved|Validated|PRIVATE_(?:OBJECTIVE|CONTEXT|REPORT)/);
  ui.event('assignment.reviewed', { assignmentId: job.id, round: 1, outcome: 'accepted', seq: 13, eventSessionId: session.id }); ui.tui.render();
  assert.match(frame(ui), /Accepted/i); assert.equal(cards(ui).length, 1); assert.equal(ui.tui.goal, null);
  assert.equal(ui.tui.value, 'Keep my unsent investigation draft'); assert.equal(ui.tui.cursor, 7);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('skill loads and two same-model specialists stay visible, distinctly colored and within ordinary/minimal chat widths', () => {
  const { ui, output } = terminal(), first = agent(), second = agent('idor-reviewer');
  ui.tui.theme = createTerminalTheme(output, { FORCE_COLOR: '3' }); ui.tui.showTools = false;
  ui.event('core.usage', skill()); ui.event('assignment.created', first); ui.event('assignment.created', second);
  const agents = cards(ui).filter(entry => /Agent/.test(entry.text)); assert.equal(agents.length, 2);
  const firstTone = entry => ui.tui.entryLayout(entry, 99).lines.join('').match(/\x1b\[38;2;[\d;]+m/)?.[0];
  assert.ok(firstTone(agents[0])); assert.notEqual(firstTone(agents[0]), firstTone(agents[1]));
  for (const minimal of [false, true]) {
    ui.minimal = minimal;
    for (const columns of [40, 80, 140]) {
      output.columns = columns; ui.tui.render();
      assert.match(frame(ui), columns < 80 ? /http-response-r/ : /http-response-review/);
      assert.match(frame(ui), /http-analyst/); assert.match(frame(ui), /idor-reviewer/); assert.match(frame(ui), /Loaded/i);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(clean(line)) < columns));
      assert.equal(ui.tui.value, 'Keep my unsent investigation draft'); assert.equal(ui.tui.cursor, 7);
    }
  }
});

test('actual skill receipts deduplicate while names mentioned in chat and foreign-session events do not create calls', () => {
  const { ui } = terminal(), receipt = skill();
  ui.event('text', { text: 'We could use a skill named http-response-review later.' }); assert.equal(cards(ui).length, 0);
  ui.event('core.usage', receipt); ui.event('core.usage', { ...receipt, seq: 900 }); assert.equal(cards(ui).length, 1);
  const worker = skill({ id: 'd'.repeat(64), sessionId: randomUUID(), name: 'negative-control', scope: 'global' });
  ui.event('core.usage', { ...worker, eventSessionId: session.id }); assert.equal(cards(ui).length, 2);
  const foreignId = randomUUID();
  ui.event('core.usage', skill({ id: 'e'.repeat(64), sessionId: foreignId, rootSessionId: foreignId, name: 'foreign-private-skill' }));
  ui.event('core.usage', skill({ id: 'f'.repeat(64), name: 'wrong-envelope-skill', eventSessionId: foreignId }));
  ui.tui.render(); assert.equal(cards(ui).length, 2); assert.doesNotMatch(frame(ui), /foreign-private-skill|wrong-envelope-skill/);
  assert.match(frame(ui), /Skill.*http-response-review.*Loaded/i); assert.match(frame(ui), /negative-control/);
});

test('current snapshots settle restored running cards and cached rendering without stale replay or cross-session leakage', () => {
  const { ui } = terminal(), job = agent();
  ui.event('assignment.created', { ...job, seq: 1 }); ui.event('assignment.started', { id: job.id, round: 1, seq: 2 }); ui.tui.render();
  assert.match(frame(ui), /Running/i);
  ui.updateSession(snapshot(job, 'paused')); ui.tui.render(); assert.match(frame(ui), /Paused/i); assert.doesNotMatch(frame(ui), /Running/i);
  ui.event('assignment.started', { id: job.id, round: 1, seq: 2 }); ui.tui.render(); assert.match(frame(ui), /Paused/i);
  ui.updateSession(snapshot(job, 'accepted')); ui.tui.render(); assert.match(frame(ui), /Accepted/i);
  const neighbor = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture-model', effort: 'default' });
  ui.setSession(neighbor.id); ui.updateSession(neighbor); ui.tui.render(); assert.equal(cards(ui).length, 0); assert.doesNotMatch(frame(ui), /http-analyst/);
  ui.event('core.usage', skill()); ui.tui.render(); assert.equal(cards(ui).length, 0);
});

test('inline invocation metadata preserves a complete structured assistant response and its Copy response action', async () => {
  const { ui } = terminal(), body = '<message version="1"><p>First observed control.</p><p>Final conclusion remains uncertain.</p></message>';
  const offset = body.indexOf('Final'); let copied;
  ui.clipboard = { copyText: async text => { copied = text; return { copied: true, method: 'fixture' }; } };
  ui.event('text', { itemId: 'rich-reply', turnId: 'turn-1', text: body.slice(0, offset) });
  ui.event('core.usage', skill()); ui.event('text', { itemId: 'rich-reply', turnId: 'turn-1', text: body.slice(offset) });
  const responses = ui.tui.entries.filter(entry => entry.kind === 'assistant'); assert.equal(responses.length, 1); assert.equal(responses[0].text, body);
  ui.tui.render(); assert.match(frame(ui), /First observed control/); assert.match(frame(ui), /Final conclusion remains uncertain/);
  const hit = ui.tui.hitTargets.find(item => item.type === 'response'); assert.ok(hit);
  ui.tui.mouse(2, hit.left, hit.row); assert.equal(ui.tui.selection?.scope, 'response-menu');
  ui.tui.finishSelection('copy'); await ui.tui.clipboardTask;
  assert.equal(copied, 'First observed control.\n\nFinal conclusion remains uncertain.');
});

test('plain output leaves structured reply buffering intact and JSON emits the original event payload', () => {
  const plain = terminal({ tty: false }), json = terminal({ tty: false, json: true }), receipt = skill();
  const body = '<message version="1"><p>One complete structured answer.</p></message>', split = body.indexOf('structured');
  plain.ui.event('text', { itemId: 'plain-rich', text: body.slice(0, split) });
  plain.ui.event('core.usage', receipt); assert.doesNotMatch(plain.written, /<message|One complete/);
  plain.ui.event('text', { itemId: 'plain-rich', text: body.slice(split) }); plain.ui.newline();
  assert.match(plain.written, /Skill.*http-response-review.*Loaded/i); assert.match(plain.written, /One complete structured answer\./); assert.doesNotMatch(plain.written, /<message/);
  json.ui.event('core.usage', receipt); json.ui.event('text', { itemId: 'json-rich', text: body });
  const events = json.written.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.find(event => event.type === 'core.usage'), { type: 'core.usage', ...receipt });
  assert.deepEqual(events.find(event => event.type === 'text'), { type: 'text', itemId: 'json-rich', text: body });
});
