import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { characterSprite, canvasStatus } from '../src/canvas-view.js';
import { characterRaster } from '../src/canvas-characters.js';
import { canvasWorkspace } from '../src/canvas-workspace.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { loadSession, saveSession } from '../src/store.js';
import { openCanvas } from '@bzzy/core/engine/canvas.js';
import { insertCanvasModel } from '@bzzy/core/engine/canvas.js';
import { finishCanvasReviews } from '@bzzy/core/engine/canvas.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { listRecords, events } from '../src/database.js';
import { randomUUID } from 'node:crypto';

function terminal(options = {}) {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 120, rows: 40 }); output.on('data', () => {});
  const ui = new UI({ canvas: true, input, output, error: output, ...options }); ui.openTerminal();
  return { ui, input, output, tui: ui.tui };
}
function view() {
  const nodes = [0, 1].map(i => ({ id: 'node' + i, sessionId: 'session' + i, appearance: i, selection: { provider: 'fixture', model: 'same-model', effort: i ? 'low' : 'high' } }));
  return { canvas: { nodes, groups: [{ id: 'group', lead: 'node0', members: nodes.map(node => node.id), mode: 'delegate' }] },
    focus: 'node0', alias: 'starbucks-japan', bindings: new Map(nodes.map((node, i) => [node.id, { sessionId: node.sessionId, controlId: 'session0', role: i ? 'HANDS' : 'BRAIN' }])),
    snapshots: new Map([['session0', { session: { model: 'same-model', goal: { status: 'complete' } } }], ['session1', { session: { goal: { status: 'paused' } } }]]), bubbles: new Map(), exchanges: new Map() };
}
test('canvas fits normal and compact terminals, keeps identity, exact model-effort, goals and hit targets', () => {
  const { ui, tui, output } = terminal(); ui.canvasView = view();
  try {
    tui.theme = createTerminalTheme(output, { FORCE_COLOR: '3' });
    for (const [columns, rows] of [[160, 50], [120, 40], [80, 24], [48, 20], [24, 12]]) {
      Object.assign(output, { columns, rows }); tui.render();
      assert.equal(tui.lastFrame.length, rows); assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns), `${columns}x${rows}`);
      const text = tui.lastFrame.map(clean).join('\n'); assert.match(text, columns >= 48 ? /starbucks-japan/ : /starbucks-jap/);
      assert.ok(tui.hitTargets.some(hit => hit.type === 'canvas-open'));
      assert.ok(tui.hitTargets.some(hit => hit.type === 'canvas-goal'));
      assert.ok(tui.hitTargets.some(hit => hit.type === 'canvas-model'));
      assert.ok(tui.hitTargets.some(hit => hit.type === 'canvas-effort'));
      assert.match(text, /BRAIN/); assert.ok(tui.hitTargets.some(hit => hit.type === 'canvas-node'));
      if (columns >= 80) { assert.match(text, /HANDS/); assert.match(text, /same-model · high/); assert.match(text, /Goal achieved/); assert.match(text, /Paused/); }
      if (rows >= 46) assert.match(text, /BRAIN ↓ HANDS/, 'the hierarchy label must remain above character surfaces');
      assert.equal(tui.canCompose(), false); assert.equal(tui.dashboardActive, false);
      assert.match(tui.lastFrame.join(''), /\x1b\[38;2;/, 'composition must preserve sprite colors');
    }
  } finally { ui.close(); }
});

test('live canvas pauses and links real Core sessions, runs delegate work, opens evidence, and unlinks without replay', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-canvas-live-'));
  const values = { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'),
    BZZY_CODEX_BIN: path.resolve('test/fixtures/advanced-agent.mjs'), BZZY_CLAUDE_BIN: path.resolve('test/fixtures/advanced-agent.mjs'),
    BZZY_TEST_LOG: path.join(directory, 'backend.jsonl'), BZZY_TEST_ADVANCED: 'canvas' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  const { ui, tui } = terminal({ pet: false }); let running;
  async function ready(predicate) { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Live canvas timed out: ' + tui.actionNotice?.message); }
  const command = async text => { await ready(() => tui.resolveInput && /^bzzy/.test(tui.question)); tui.finish(text); };
  try {
    fs.writeFileSync(path.join(directory, 'source.txt'), 'Supplied evidence');
    const session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture-brain', alias: 'live-canvas' });
    let canvas = openCanvas(session.id); canvas = insertCanvasModel(session.id, canvas.revision, { provider: 'codex', model: 'fixture-hands', effort: 'default' }, randomUUID());
    const [brain, hands] = canvas.nodes;
    running = canvasWorkspace({ cwd: directory }, ui, session);
    await ready(() => tui.resolveInput && ui.canvasView.canvas);
    const clickControl = type => { tui.render(); const hit = tui.hitTargets.find(hit => hit.type === type && hit.id === brain.id); assert.ok(hit); tui.mouse(0, hit.left, hit.row); return hit; };
    const clickChoice = value => { tui.render(); const index = tui.selection.choices.findIndex(choice => choice.value === value); assert.ok(index >= 0); const hit = tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === index); assert.ok(hit); tui.mouse(0, hit.left + 1, hit.row); };
    const anchor = clickControl('canvas-effort');
    await ready(() => tui.selection && !tui.selection.loading);
    assert.equal(tui.selection.anchor.row, anchor.row); clickChoice('high');
    await ready(() => tui.resolveInput && loadSession(session.id).selectedEffort === 'high');
    assert.equal(loadSession(session.id).executionState, 'paused');
    clickControl('canvas-model'); await ready(() => tui.selection && !tui.selection.loading);
    clickChoice(JSON.stringify(['codex', 'fixture-light']));
    await ready(() => tui.resolveInput && loadSession(session.id).model === 'fixture-light');
    clickControl('canvas-effort'); await ready(() => tui.selection && !tui.selection.loading);
    assert.deepEqual(tui.selection.choices.map(choice => choice.value), ['default', 'low']);
    tui.key('', { name: 'escape' }); await ready(() => tui.resolveInput && !tui.selection);
    assert.equal(loadSession(session.id).selectedEffort, 'default', 'cancelling a direct effort change keeps its selection');
    clickControl('canvas-model'); await ready(() => tui.selection && !tui.selection.loading);
    clickChoice(JSON.stringify(['codex', 'fixture-brain']));
    await ready(() => tui.resolveInput && loadSession(session.id).model === 'fixture-brain');
    assert.equal(listRecords('execution').length, 0, 'model/effort controls cannot start work');
    await command('/canvas link'); await ready(() => ui.canvasView.linkFrom === brain.id);
    await command('/canvas connect ' + hands.id); await ready(() => tui.selection?.title?.startsWith('Link'));
    tui.finishSelection('delegate');
    await ready(() => ui.canvasView.canvas.groups.length === 1 && tui.resolveInput);
    assert.equal(loadSession(session.id).executionState, 'paused'); assert.equal(loadSession(hands.sessionId).executionState, 'paused'); assert.equal(listRecords('execution').length, 0);
    tui.render(); const character = tui.hitTargets.find(hit => hit.type === 'canvas-node' && hit.id === brain.id);
    tui.mouse(0, character.left + 4, character.row); tui.mouse(0, character.left + 4, character.row);
    assert.equal(ui.canvasView.drawer, false, 'repeated character clicks only select; opening a conversation is explicit');
    tui.mouse(2, character.left + 4, character.row);
    await ready(() => tui.selection && !tui.selection.loading); tui.render();
    const goalIndex = tui.selection.choices.findIndex(choice => choice.value === 'goal'), goalChoice = tui.hitTargets.find(hit => hit.type === 'choice' && hit.index === goalIndex);
    assert.ok(goalChoice); tui.mouse(0, goalChoice.left + 2, goalChoice.row);
    await ready(() => tui.promptDraft && /Goal/.test(tui.question)); tui.render(); assert.equal(tui.canvasOverlay.kind, 'prompt');
    tui.key('', { name: 'escape' }); await ready(() => tui.resolveInput && !tui.promptDraft);
    tui.render(); const inlineGoal = tui.hitTargets.find(hit => hit.type === 'canvas-goal');
    tui.mouse(0, inlineGoal.left + 8, inlineGoal.row);
    assert.equal(ui.canvasView.editingGoal, undefined, 'a single goal click cannot start or edit work');
    tui.mouse(0, inlineGoal.left + 8, inlineGoal.row);
    await ready(() => ui.canvasView.editingGoal && tui.promptDraft); tui.render();
    assert.equal(tui.composerRow, tui.canvasGoalRow, 'editing happens in the visible goal row');
    tui.value = 'Assess supplied evidence'; tui.cursor = [...tui.value].length; tui.render();
    tui.key('', { name: 'return' });
    await ready(() => loadSession(session.id).goal?.status === 'complete');
    await ready(() => ui.canvasView.bindings.get(hands.id).sessionId && ui.canvasView.bindings.get(hands.id).sessionId !== hands.sessionId);
    const executions = listRecords('execution').length;
    await command('/canvas chat'); await ready(() => ui.canvasView.drawer && tui.resolveInput);
    assert.ok(tui.entries.some(entry => entry.kind === 'assistant'));
    await command('/canvas back'); await command('/canvas unlink');
    await ready(() => !ui.canvasView.canvas.groups.length && tui.resolveInput);
    assert.equal(loadSession(session.id).goal.status, 'complete'); assert.equal(loadSession(session.id).mode, 'solo'); assert.equal(loadSession(session.id).executionState, 'paused');
    assert.equal(listRecords('execution').length, executions); assert.ok(ui.canvasView.canvas.nodes[1].threads.length);
    const originalGoalId = loadSession(session.id).goal.id;
    await command('/canvas link'); await ready(() => ui.canvasView.linkFrom === brain.id);
    await command('/canvas connect ' + hands.id); await ready(() => tui.selection?.title?.startsWith('Link')); tui.finishSelection('debate');
    await ready(() => ui.canvasView.canvas.groups[0]?.mode === 'debate' && tui.resolveInput);
    await command('/canvas review'); await ready(() => ui.canvasView.canvas.groups[0]?.reviewSessionId);
    const reviewId = ui.canvasView.canvas.groups[0].reviewSessionId;
    await ready(() => ['complete', 'awaiting_review'].includes(loadSession(reviewId).goal?.status));
    assert.equal(loadSession(reviewId).reviewSource.goalId, originalGoalId);
    assert.equal(loadSession(session.id).goal.id, originalGoalId); assert.equal(loadSession(session.id).goal.status, 'complete');
    await ready(() => ui.canvasView.canvas.groups[0]?.reviewFinished);
    finishCanvasReviews(session.id); finishCanvasReviews(session.id);
    assert.equal(events(session.id).filter(event => event.type === 'debate.result').length, 1, 'review finalization is idempotent across observers');
    await command('/quit'); assert.equal(await running, 0); running = null;
  } catch (error) {
    console.error('Canvas interaction failed:', error.message, 'picker:', tui.selection?.title, 'prompt:', tui.question);
    throw error;
  } finally {
    if (running) { tui.finishSelection(null); if (tui.promptDraft) tui.finish(null); tui.localCommand('/canvas quit'); await running.catch(() => {}); }
    ui.close(); const info = runtimeInfo();
    if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let i = 0; i < 100 && info && identityAlive(info.identity); i++) await new Promise(resolve => setTimeout(resolve, 20));
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('matching square pixel characters render in every color mode and respect reduced motion', () => {
  for (const level of ['0', '1', '2', '3']) {
    const theme = createTerminalTheme({ isTTY: true }, { FORCE_COLOR: level }, 'blue');
    for (let i = 0; i < 12; i++) {
      const a = characterSprite(i, 'working', 0, theme, { animate: false }), b = characterSprite(i, 'working', 4, theme, { animate: false });
      assert.deepEqual(a, b); assert.equal(a.length, 12); assert.ok(a.every(line => cellWidth(line) === 28));
      assert.doesNotMatch(a.map(clean).join(''), /\x1b/);
      assert.doesNotMatch(a.map(clean).join(''), /[\u2800-\u28ff]/, 'characters use filled pixels, not Braille dots');
      if (level === '0') assert.match(a.map(clean).join(''), /[█▀▄]/);
    }
  }
  const theme = createTerminalTheme({ isTTY: true }, { FORCE_COLOR: '3' });
  assert.notDeepEqual(characterSprite(0, 'working', 0, theme), characterSprite(0, 'working', 2, theme));
  assert.notDeepEqual(characterSprite(0, 'working', 0, theme), characterSprite(1, 'working', 0, theme));
  const mask = appearance => {
    const { pixels } = characterRaster(appearance, 'idle', theme);
    return Array.from({ length: pixels.length / 3 }, (_, i) => {
      const [r, g, b] = pixels.subarray(i * 3, i * 3 + 3);
      return r === 3 && g === 9 && b === 15 ? 0 : r === 237 && g === 245 && b === 242 ? 2 : 1;
    });
  };
  for (let i = 1; i < 12; i++) assert.deepEqual(mask(i), mask(0), 'all coats share exactly the same outline and eyes');
});

test('state expressions use authoritative lifecycle and pending questions, with achieved distinct from stalled', () => {
  assert.equal(canvasStatus({ session: { goal: { status: 'complete' } } }).state, 'achieved');
  assert.equal(canvasStatus({ session: { goal: { status: 'awaiting_review' } } }).state, 'stalled');
  assert.equal(canvasStatus({ session: {}, execution: { state: 'running' }, questions: [{ id: 'q' }] }).state, 'waiting');
  assert.equal(canvasStatus({ session: {}, execution: { state: 'running' } }).state, 'working');
  assert.equal(canvasStatus(null).state, 'idle');
});

test('canvas mouse and keyboard never enter chat drafts; private prompts, overlays and minimal retain their input path', async () => {
  const { ui, tui } = terminal(); ui.canvasView = view(); const keys = [], clicks = [];
  ui.canvasView.onKey = key => { keys.push(key.name); return true; }; ui.canvasView.onMouse = (...values) => clicks.push(values);
  try {
    const input = ui.ask('bzzy › '); await new Promise(resolve => setImmediate(resolve));
    tui.value = 'retained draft'; tui.cursor = 4;
    tui.key('x', { name: 'x' }); tui.key('', { name: 'f10' }); tui.mouse(2, 20, 14);
    assert.deepEqual(keys, ['x', 'f10']); assert.equal(clicks.length, 1); assert.equal(tui.value, 'retained draft');
    tui.finish(''); await input;
    const secret = ui.ask('API key', { hidden: true }); await new Promise(resolve => setImmediate(resolve));
    tui.key('s', { name: 's' }); assert.equal(tui.value, 's'); assert.equal(keys.length, 2);
    tui.finish(null); await secret;
    ui.canvasView.drawer = true;
    const chat = ui.ask('bzzy › '); await new Promise(resolve => setImmediate(resolve));
    tui.setCopyMode(true); tui.key('', { name: 'escape' });
    assert.equal(tui.copyMode, false); assert.ok(tui.resolveInput, 'Esc exits copy mode before closing the conversation');
    tui.key('', { name: 'escape' }); assert.equal(await chat, '/canvas back');
  } finally { ui.close(); }
  const minimal = terminal({ minimal: true });
  try { minimal.ui.canvasView = view(); minimal.tui.render(); assert.equal(minimal.tui.canvasVisible(), false); assert.doesNotMatch(minimal.tui.lastFrame.map(clean).join('\n'), /BRAIN|starbucks-japan|F10/); }
  finally { minimal.ui.close(); }
});

test('workspace restores without claiming input, executing, replaying animations or losing drafts across drawer transitions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-canvas-ui-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private'); const { ui, tui } = terminal();
  try {
    const session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture', alias: 'saved-chat' });
    const otherCwd = path.join(directory, 'other-project'); fs.mkdirSync(otherCwd);
    const other = createChatSession(getProvider('codex'), { cwd: otherCwd, model: 'other-model', alias: 'other-chat' });
    const unnamed = createChatSession(getProvider('codex'), { cwd: otherCwd, model: 'unnamed-model' });
    const calls = [];
    const request = async (_, method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (endpoint.includes('/events?')) {
        if (endpoint.includes('after=0&')) await new Promise(resolve => setTimeout(resolve, 450));
        return { events: endpoint.includes('after=0&') ? [{ seq: 1, type: 'text', data: { text: 'Recorded answer' }, createdAt: new Date().toISOString() }] : [], hasMore: false };
      }
      assert.equal(method, 'GET', 'restoration and view changes cannot take ownership or execute');
      return { session: loadSession(endpoint.split('/')[2]), execution: null, questions: [], children: [], capabilities: { activeSteering: false } };
    };
    const running = canvasWorkspace({ cwd: directory }, ui, session, null, { connect: async () => ({}), request });
    async function ready(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('UI did not become ready.'); }
    await ready(() => tui.resolveInput);
    assert.equal(ui.canvasView.canvas.nodes.length, 1); assert.equal(ui.canvasView.bubbles.size, 0);
    tui.localCommand('/canvas chat'); await ready(() => ui.canvasView.drawer && tui.resolveInput);
    assert.equal(tui.entries.filter(entry => entry.text === 'Recorded answer').length, 1, 'a polling tick during history loading cannot duplicate the transcript');
    tui.value = 'Unsent'; tui.cursor = 3;
    tui.key('', { name: 'escape' }); await ready(() => !ui.canvasView.drawer && tui.resolveInput);
    tui.localCommand('/canvas chat'); await ready(() => ui.canvasView.drawer && tui.resolveInput);
    assert.equal(tui.value, 'Unsent'); assert.equal(tui.cursor, 3);
    tui.key('', { name: 'escape' }); await ready(() => !ui.canvasView.drawer && tui.resolveInput);
    const openSessions = async () => {
      tui.render(); const open = tui.hitTargets.find(hit => hit.type === 'canvas-open'); assert.ok(open);
      tui.mouse(0, open.left, open.row); await ready(() => tui.selection && !tui.selection.loading);
    };
    await openSessions();
    assert.ok(tui.selection.choices.some(choice => choice.value === other.id));
    assert.ok(!tui.selection.choices.some(choice => [session.id, unnamed.id].includes(choice.value)), 'the top picker lists only other aliased terminals');
    tui.key('', { name: 'escape' }); await ready(() => !tui.selection && tui.resolveInput);
    assert.equal(ui.canvasView.canvas.id, session.id); assert.equal(tui.value, 'Unsent');
    await openSessions(); tui.finishSelection(other.id);
    await ready(() => ui.canvasView.canvas.id === other.id && tui.resolveInput);
    assert.equal(tui.cwd, otherCwd); assert.equal(ui.canvasView.alias, 'other-chat');
    await openSessions(); tui.finishSelection(session.id);
    await ready(() => ui.canvasView.canvas.id === session.id && tui.resolveInput);
    assert.equal(tui.cwd, directory); assert.equal(tui.value, 'Unsent'); assert.equal(tui.cursor, 3);
    tui.finish('/quit'); assert.equal(await running, 0);
    assert.ok(calls.every(call => call.method === 'GET'));
    assert.equal(openCanvas(session.id).nodes.length, 1);
  } finally { ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a reply completing during pause is durably paused before a canvas edit can proceed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-canvas-pause-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private'); const { ui, tui } = terminal(); let running;
  try {
    const session = createChatSession(getProvider('codex'), { cwd: directory, model: 'fixture', alias: 'pause-race' }); let controls = 0;
    const request = async (_, method, endpoint, body) => {
      if (method === 'POST') {
        if (endpoint.endsWith('/release')) return {};
        assert.equal(body.operation, 'control'); assert.equal(body.action, 'pause');
        if (++controls > 1) { const saved = loadSession(session.id); saved.executionState = 'paused'; saveSession(saved); }
        return {};
      }
      if (endpoint.includes('/events?')) return { events: [], hasMore: false };
      return { session: loadSession(session.id), questions: [], children: [], capabilities: {}, execution: { state: 'finished' } };
    };
    running = canvasWorkspace({ cwd: directory }, ui, session, null, { connect: async () => ({}), request });
    async function ready(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Pause did not settle.'); }
    await ready(() => tui.resolveInput); tui.finish('/pause');
    await ready(() => controls === 2 && tui.resolveInput);
    assert.equal(loadSession(session.id).executionState, 'paused');
    tui.finish('/quit'); assert.equal(await running, 0); running = null;
  } finally {
    if (running) { tui.finish('/quit'); await running.catch(() => {}); }
    ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true });
  }
});
