import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UI } from '../src/ui.js';
import { SessionMetricsPanel, sessionMetricsLayout } from '../src/session-metrics-ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { commandSuggestions } from '../src/terminal-commands.js';
import { goalIndicator } from '../src/goal-indicator.js';
import { createSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { appendEvent, events, putRecord } from '../src/database.js';
import { runtimeInfo, persistOperatorStopIntent, operatorStopRequested } from '../src/runtime.js';

const firstId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', secondId = '11111111-2222-3333-4444-555555555555';
const usage = (skills, agents, workers, name = 'HTTP response analysis') => ({ skillInvocations: skills, subagentInvocations: agents, workerAssignments: workers,
  skillRows: skills ? [{ id: 'http', name, version: 2, count: skills }] : [],
  agentRows: agents ? [{ id: 'analyst', name: 'Response analyst', count: agents }] : [], workerRows: workers ? [{ role: 'executor', count: workers }] : [] });
const snapshot = (id = firstId) => ({ version: 1, sessionId: id, currentGoalId: 'current-goal',
  session: usage(12, 7, 10), chat: usage(2, 1, 1),
  goals: [{ id: 'current-goal', status: 'complete', createdAt: '2026-10-25T12:00:00Z', ...usage(3, 2, 4) },
    { id: 'previous-goal', status: 'paused', createdAt: '2026-10-24T12:00:00Z', ...usage(7, 4, 5) }],
  coverage: { complete: true, legacySkillReads: 0, skills: 'recorded-model-loads', reasons: [] }, updatedAt: '2026-10-25T12:10:00Z' });
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function terminal(load = async id => snapshot(id), dimensions = {}) {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 36, ...dimensions }); output.resume();
  const ui = new UI({ input, output, error: output, pet: false, sessionMetricsLoader: load }); ui.setSession(firstId);
  ui.updateSession({ id: firstId, provider: 'codex', model: 'recorded-model', alias: 'Security review',
    goal: { id: 'current-goal', status: 'complete', objective: 'Check the recorded HTTP responses.' } });
  return { ui, input, output, frame: () => ui.tui.lastFrame.map(clean).join('\n') };
}
const clickAction = (ui, action) => {
  ui.tui.render(); const hit = ui.tui.hitTargets.find(item => item.type === 'metrics-action' && item.action === action);
  assert.ok(hit, `Visible ${action} action`); ui.tui.mouse(0, hit.left, hit.row);
};

test('compactor estimate stays scoped to the whole chat and exposes old unpriced attempts at compact widths', () => {
  const data = snapshot(); data.provider = 'deepseek'; data.currentGoalId = null; data.goals = [];
  data.compactorCost = { complete: false, attempts: 5, summaries: 3, legacyAttempts: 2, incompleteAttempts: 3,
    estimatedUsd: { min: 0.014, max: 0.028 }, pricingVerifiedAt: '2026-10-28',
    models: [{ provider: 'deepseek', model: 'deepseek-flash', attempts: 5, unpricedAttempts: 2, estimatedUsd: { min: 0.014, max: 0.028 } }] };
  const panel = { data, scope: 'goal', actions: () => [], selectedGoalId: null };
  for (const width of [40, 80, 100]) {
    const layout = sessionMetricsLayout(panel, width), text = layout.lines.map(line => line.text.trim()).join(' ');
    assert.match(text, /DeepSeek spending · whole chat/); assert.match(text, /\$0\.0140–\$0\.0280/);
    assert.match(text, /2 older attempts have no billing/); assert.match(text, /unfinished usage/);
    assert.ok(layout.lines.every(line => cellWidth(line.text) <= width));
  }
  data.compactorCost.estimatedUsd = null;
  assert.match(sessionMetricsLayout(panel, 80).lines.map(line => line.text).join('\n'), /Known estimate · partial\s+—/);
});

test('chat spending and account balance appear only for direct DeepSeek Solo or either Delegate role', async () => {
  const { ui } = terminal(undefined, { columns: 80, rows: 24 });
  ui.openTerminal();
  const spending = { sessionId: firstId, chat: { estimatedUsd: { min: 0.01, max: 0.01 } },
    compactor: { estimatedUsd: { min: 0.002, max: 0.002 } }, total: { estimatedUsd: { min: 0.012, max: 0.012 }, complete: true } };
  ui.accountStatus = { deepseek: { status: 'available', balance: { currency: 'USD', amount: 12.34 }, checkedAt: Date.now(), source: 'provider-api' } };
  try {
    for (const [provider, mode, executor, visible] of [
      ['deepseek', 'solo', null, true], ['codex', 'delegate', { provider: 'deepseek' }, true],
      ['deepseek', 'delegate', { provider: 'claude' }, true], ['codex', 'solo', null, false],
      ['orcarouter', 'solo', null, false], ['experiential', 'delegate', { provider: 'orcarouter' }, false],
      ['deepseek', 'parallel', null, false],
    ]) {
      ui.updateSession({ session: { id: firstId, provider, mode, executor, model: 'deepseek-flash', executionState: 'idle' }, spending });
      ui.tui.render(); const text = ui.tui.lastFrame.map(clean).join('\n');
      assert.equal(/Chat ≈ \$0\.0100/.test(text), visible, `${provider}/${mode} spending`);
      assert.equal(/Balance \$12\.34/.test(text), visible, `${provider}/${mode} balance`);
      if (visible) {
        const row = clean(ui.tui.lastFrame.find(line => clean(line).includes('Balance')) || '');
        assert.match(row, /Balance \$12\.34.*Chat ≈ \$0\.0100.*Compactor ≈ \$0\.0020.*Total ≈ \$0\.0120/);
        assert.doesNotMatch(clean(ui.tui.lastFrame[0]), /Balance|Compactor|\+ New/);
        assert.equal(ui.tui.hitTargets.find(hit => hit.type === 'usage-balance').row, 3);
      }
    }
    ui.minimal = true;
    ui.updateSession({ session: { id: firstId, provider: 'codex', mode: 'delegate', executor: { provider: 'deepseek' }, model: 'gpt-5.6-sol', executionState: 'idle' }, spending });
    ui.tui.render();
    assert.match(clean(ui.tui.lastFrame.find(line => clean(line).includes('Balance')) || ''), /Balance \$12\.34.*Chat.*Compactor.*Total/);
    ui.minimal = false;
    Object.assign(ui.output, { columns: 40, rows: 32 }); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Balance \$12\.34/);
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Total ≈ \$0\.0120/);
    assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < 40));
  } finally { ui.close(); }
});

test('execution health separates routing blockers and native readiness from invocation counts', () => {
  const data = snapshot(); data.health = { available: true, routing: { enforced: true, covered: 1, closed: 2, open: 1, blocked: 1, unmet: 2,
    units: [{ classId: 'idor', state: 'open', specialist: 'idor-agent', missing: ['review'] }] },
    native: { readiness: { tools: { source: 'unknown-legacy-native-thread' } }, refresh: { state: 'pending', reason: 'awaiting-safe-prompt' },
      routingToolCoverage: { known: true, missing: ['declare_work_unit', 'close_work_unit'] } },
    memory: { indexedThroughSeq: 123, pendingNodes: 2 }, taskState: { bytes: 2048, repeatedReads: 3 } };
  const panel = { data, scope: 'goal', actions: () => [], selectedGoalId: null };
  const text = sessionMetricsLayout(panel, 100).lines.map(line => clean(line.text)).join('\n');
  assert.match(text, /1 covered.*1 open.*1 blocked/); assert.match(text, /unknown for this retained native thread/);
  assert.match(text, /Workflow tools missing from native thread/); assert.match(text, /declare_work_unit/);
  assert.match(text, /indexed through event 123/); assert.match(text, /Skill model loads\s+3/);
  panel.selectedGoalId = 'previous-goal';
  assert.doesNotMatch(sessionMetricsLayout(panel, 100).lines.map(line => clean(line.text)).join('\n'), /BZZY execution health/);
});

test('Metrics scopes use Core counters and real input/clicks preserve the chat draft and header', async () => {
  let reads = 0;
  const { ui, input, output, frame } = terminal(async id => { reads++; return snapshot(id); }, { columns: 80, rows: 24 });
  try {
    const pending = ui.ask('bzzy › '); await settle();
    ui.tui.value = 'Unsent private draft'; ui.tui.cursor = 6; ui.tui.render();
    const hit = ui.tui.hitTargets.find(item => item.type === 'top-metrics'); assert.ok(hit);
    ui.tui.mouse(0, hit.left, hit.row); await settle(); ui.tui.render();
    assert.equal(ui.tui.panel, 'metrics'); assert.match(frame(), /Current goal.*Achieved ✓/);
    assert.match(frame(), /Check the recorded HTTP responses/); assert.match(frame(), /Skill model loads\s+3/);
    assert.match(frame(), /Specialist agents invoked\s+2/); assert.match(frame(), /Worker assignments\s+4/);
    assert.match(frame(), /recorded-model/); assert.match(frame().split('\n')[0], /Metrics.*Settings/);
    assert.doesNotMatch(frame(), /Unsent private draft/); assert.equal(ui.tui.value, 'Unsent private draft');
    input.write('\x1b[C\r'); await settle(); ui.tui.render();
    assert.equal(ui.sessionMetrics.scope, 'session'); assert.match(frame(), /Whole chat/); assert.match(frame(), /Skill model loads\s+12/);
    clickAction(ui, 'chat'); await settle(); ui.tui.render();
    assert.match(frame(), /Outside goals/); assert.match(frame(), /Skill model loads\s+2/);
    assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < output.columns));
    input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'Unsent private draft'); assert.equal(ui.tui.cursor, 6);
    assert.equal(ui.sessionMetrics.active, false); assert.equal(reads, 1);
    ui.tui.finish(null); await pending;
  } finally { ui.close(); }
});

test('recorded-goal picker cancels innermost on Back, restores the live reader, and selects earlier goal metrics', async () => {
  const { ui, frame } = terminal();
  try {
    const pending = ui.ask('bzzy › '); await settle();
    ui.tui.value = 'Keep draft'; ui.tui.cursor = 3; const originalReader = ui.reader;
    await ui.settingsCommand('/metrics'); await settle();
    clickAction(ui, 'history'); await settle(); ui.tui.render();
    assert.equal(ui.tui.selection.title, 'Recorded goals');
    const back = ui.tui.hitTargets.find(item => item.type === 'cancel' && item.back); assert.ok(back);
    ui.tui.mouse(0, back.left, back.row); await ui.tui.metricsTask;
    assert.equal(ui.tui.selection, null); assert.equal(ui.tui.panel, 'metrics'); assert.equal(ui.reader, originalReader);
    assert.equal(ui.sessionMetrics.selectedGoalId, null); assert.equal(ui.tui.value, 'Keep draft');
    clickAction(ui, 'history'); await settle();
    ui.tui.selection.focus = 1; ui.tui.key('', { name: 'return' }); await ui.tui.metricsTask; ui.tui.render();
    assert.match(frame(), /Earlier goal.*Paused/); assert.match(frame(), /Skill model loads\s+7/);
    assert.doesNotMatch(frame(), /Current goal · Achieved/);
    const panelBack = ui.tui.hitTargets.find(item => item.type === 'back'); assert.ok(panelBack);
    ui.tui.mouse(0, panelBack.left, panelBack.row);
    assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'Keep draft'); assert.equal(ui.tui.cursor, 3);
    ui.tui.finish(null); await pending;
  } finally { ui.close(); }
});

test('Metrics ignores stale session reads, refreshes only while open, and reads saved stats when Core is stopped', async () => {
  const requests = [];
  const { ui } = terminal(id => new Promise(resolve => requests.push({ id, resolve })));
  try {
    ui.coreLifecycleInterrupted = true;
    ui.tui.setPanel('metrics'); assert.equal(requests[0].id, firstId);
    ui.activeTab = secondId; ui.tui.render(); assert.equal(requests[1].id, secondId);
    assert.equal(ui.sessionMetrics.data, null, 'A changed active tab cannot briefly display the prior session');
    requests[0].resolve(snapshot(firstId)); await settle(); assert.equal(ui.sessionMetrics.data, null);
    requests[1].resolve(snapshot(secondId)); await settle(); assert.equal(ui.sessionMetrics.data.sessionId, secondId);
    assert.equal(ui.tui.entries.length, 0, 'Metrics reads do not become chat or model commands');
    ui.tui.goBack(); assert.equal(ui.tui.panel, 'chat', 'Back still returns to the saved chat while Core is stopped');
    assert.equal(ui.sessionMetrics.timer, null); assert.equal(ui.sessionMetrics.active, false);
    assert.equal(ui.permissionConnection, undefined);
  } finally { ui.close(); assert.equal(ui.sessionMetrics.data, null); }
});

test('Metrics debug export uses the selected saved chat, preserves the draft and shows the file path with real keyboard controls', async () => {
  const { ui, input, frame } = terminal();
  const exported = []; let complete;
  ui.sessionDebugExporter = id => { exported.push(id); return new Promise(resolve => { complete = resolve; }); };
  try {
    const pending = ui.ask('bzzy › '); await settle(); ui.tui.value = 'Unsent draft stays here'; ui.tui.cursor = 4;
    await ui.settingsCommand('/metrics'); await settle();
    input.write('e'); await settle(); ui.tui.render();
    assert.equal(ui.sessionMetrics.exporting, true); assert.match(frame(), /Exporting/);
    input.write('e'); await settle(); assert.deepEqual(exported, [firstId]);
    complete({ outputPath: '/project/Security-review_debug_26102026.md' }); await ui.tui.metricsTask; await settle(); ui.tui.render();
    assert.match(frame(), /Debug exported/); assert.match(frame(), /Security-review_debug_26102026.md/);
    assert.equal(ui.tui.value, 'Unsent draft stays here'); assert.equal(ui.tui.cursor, 4);
    assert.equal(ui.tui.entries.length, 0); assert.equal(ui.permissionConnection, undefined);
    assert.equal(commandSuggestions('/deb')[0].command, '/debug');
    ui.tui.finish(null); await pending;
  } finally { ui.close(); }
});

test('/debug stays local and stale exports cannot appear in another chat', async () => {
  const { ui } = terminal();
  let complete; ui.sessionDebugExporter = () => new Promise(resolve => { complete = resolve; });
  try {
    const exporting = ui.settingsCommand('/debug'); await settle();
    assert.equal(ui.tui.panel, 'metrics');
    ui.activeTab = secondId; ui.tui.render(); await settle();
    complete({ outputPath: '/project/old-chat_debug_26102026.md' }); await exporting;
    assert.equal(ui.sessionMetrics.sessionId, secondId); assert.equal(ui.sessionMetrics.exportResult, null);
    assert.equal(ui.tui.entries.length, 0);
  } finally { ui.close(); }
});

test('Full debug ZIP and /full_debug_export route to the full exporter without model input or draft changes', async () => {
  const { ui, input, frame } = terminal(); const exported = [];
  ui.sessionFullDebugExporter = async id => { exported.push(id); return { outputPath: '/project/chat_full_debug_26102026.zip', full: true }; };
  try {
    const pending = ui.ask('bzzy › '); await settle(); ui.tui.value = 'Keep this draft';
    await ui.settingsCommand('/metrics'); await settle(); input.write('f'); await settle(); await ui.tui.metricsTask; ui.tui.render();
    assert.deepEqual(exported, [firstId]); assert.match(frame(), /Full debug ZIP exported/); assert.match(frame(), /chat_full_debug_26102026.zip/);
    ui.tui.goBack(); await ui.settingsCommand('/full_debug_export'); assert.deepEqual(exported, [firstId, firstId]);
    assert.equal(ui.tui.value, 'Keep this draft'); assert.equal(ui.tui.entries.length, 0); assert.equal(ui.permissionConnection, undefined);
    assert.ok(commandSuggestions('/full_debug').some(item => item.command === '/full_debug_export'));
    ui.tui.finish(null); await pending;
  } finally { ui.close(); }
});

test('full-export progress survives panel navigation without leaking to other chats or starting duplicates', async () => {
  let report, complete, calls = 0, loads = 0;
  const panel = new SessionMetricsPanel({}, { load: async id => { loads++; return snapshot(id); },
    exportFullDebug: (id, { onProgress }) => { calls++; report = onProgress; return new Promise(resolve => { complete = resolve; }); } });
  const text = () => sessionMetricsLayout(panel, 100).lines.map(line => line.text).join('\n');
  try {
    panel.open(firstId); await settle();
    const task = panel.activate('full-export'); await settle();
    assert.ok(panel.exportTimer); assert.equal(panel.exporting, true);
    report({ phase: 'history', records: 1234, events: 5678, files: 3, bytes: 1024 ** 2, path: 'PRIVATE_PATH', message: 'PRIVATE_TEXT' });
    assert.match(text(), /Reading saved history/); assert.match(text(), /1,234 records/); assert.match(text(), /1\.0 MiB captured/);
    assert.doesNotMatch(text(), /PRIVATE_PATH|PRIVATE_TEXT|%/);
    const before = loads; await panel.refresh(); assert.equal(loads, before, 'Heavy Metrics reads wait for export completion.');
    panel.exportJob.startedAt -= 65000; panel.exportJob.updatedAt -= 12000;
    assert.match(text(), /1m 05s elapsed/); assert.match(text(), /Last progress update 12s ago/);
    assert.ok(sessionMetricsLayout(panel, 40).lines.every(line => cellWidth(line.text) <= 40));
    panel.stop(); report({ phase: 'workspace', files: 12, bytes: 2 * 1024 ** 2 });
    panel.open(firstId); await panel.activate('full-export'); assert.equal(calls, 1);
    assert.match(text(), /Capturing project files/); assert.match(text(), /12 files/);
    panel.open(secondId); report({ phase: 'packaging', packagedFiles: 12, packagedBytes: 2 * 1024 ** 2 });
    assert.match(text(), /another chat/); assert.doesNotMatch(text(), /12 files|Packaging ZIP/);
    complete({ full: true, outputPath: '/project/first-chat.zip' }); await task; await settle();
    assert.equal(panel.exportResult, null); assert.equal(panel.exportTimer, null); assert.equal(panel.exporting, false);
    const revision = panel.revision; report({ phase: 'history', records: 999999 }); assert.equal(panel.revision, revision);
    panel.open(firstId); await settle(); assert.equal(panel.exportResult.outputPath, '/project/first-chat.zip');
  } finally { panel.close(); }
});

test('closing Metrics clears the export timer and ignores late progress without interrupting file creation', async () => {
  let report, complete;
  const panel = new SessionMetricsPanel({}, { load: async id => snapshot(id),
    exportFullDebug: (id, { onProgress }) => { report = onProgress; return new Promise(resolve => { complete = resolve; }); } });
  panel.open(firstId); await settle(); const task = panel.activate('full-export'); await settle();
  panel.close(); const revision = panel.revision;
  report({ phase: 'packaging', packagedFiles: 5 });
  assert.equal(panel.exportTimer, null); assert.equal(panel.revision, revision);
  complete({ full: true, outputPath: '/project/finished.zip' }); await task;
  assert.equal(panel.exportResult, null); assert.equal(panel.exporting, false);
});

test('export failures show safe cause categories and the matching ZIP or Markdown retry command', async () => {
  for (const [action, code, message] of [['full-export', 'SESSION_DEBUG_PYTHON', /Python/], ['full-export', 'ENOSPC', /space/],
    ['full-export', 'EACCES', /Access/], ['export', 'toString', /could not be collected safely/]]) {
    const fail = async () => { throw Object.assign(new Error('api_key=PRIVATE_DIAGNOSTIC_DO_NOT_SHOW /root/private-account'), { code, exportPhase: 'packaging' }); };
    const panel = new SessionMetricsPanel({}, { load: async id => snapshot(id), exportDebug: fail, exportFullDebug: fail });
    try {
      panel.open(firstId); await settle(); await panel.activate(action);
      assert.match(panel.exportError, message);
      assert.match(panel.exportError, action === 'full-export' ? /bzzy debug full NAME FILE\.zip/ : /bzzy debug export NAME FILE\.md/);
      assert.doesNotMatch(panel.exportError, /PRIVATE_DIAGNOSTIC_DO_NOT_SHOW|private-account|original folder/);
      if (action === 'full-export') assert.doesNotMatch(panel.exportError, /FILE\.md/);
      assert.equal(panel.exporting, false);
      assert.equal(panel.exportTimer, null);
    } finally { panel.close(); }
  }
  const panel = new SessionMetricsPanel({});
  panel.exportResult = { full: true, outputPath: '/project/debug.zip', exclusions: 3 };
  assert.match(sessionMetricsLayout(panel, 90).lines.map(line => line.text).join('\n'), /3 context paths omitted/);
});

test('the production Metrics loader refreshes real durable Core receipts without restarting stopped Core or adding model work', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-metrics-read-')), before = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const { ui, frame } = terminal();
  try {
    const session = createSession(BUILTINS.codex, directory, 'saved-metrics-model', 'Saved metrics');
    session.goal = { id: randomUUID(), objective: 'Inspect the saved controls.', status: 'complete', createdAt: new Date().toISOString() }; saveSession(session);
    const recordUse = () => {
      const receipt = { id: randomUUID(), version: 1, kind: 'skill', sessionId: session.id, runId: randomUUID(), goalId: session.goal.id,
        skillId: 'response-review', name: 'response-review', skillVersion: 'a'.repeat(64), scope: 'project', createdAt: new Date().toISOString() };
      putRecord('core.usage', receipt.id, receipt); appendEvent(session.id, 'core.usage', receipt);
    };
    recordUse(); persistOperatorStopIntent();
    ui.sessionMetricsLoader = undefined; ui.setSession(session.id); ui.updateSession(session);
    await ui.settingsCommand('/metrics');
    for (let attempts = 0; !ui.sessionMetrics.data && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
    ui.tui.render(); assert.match(frame(), /Skill model loads\s+1/);
    assert.match(ui.tui.content(98).map(clean).join('\n'), /This project · version aaaaaaaa/);
    recordUse(); const eventCount = events(session.id).length;
    await ui.sessionMetrics.refresh(); ui.tui.render();
    assert.match(frame(), /Skill model loads\s+2/);
    assert.equal(events(session.id).length, eventCount, 'Opening and refreshing metrics creates no events');
    assert.equal(runtimeInfo(), null); assert.equal(operatorStopRequested(), true);
    assert.equal(ui.tui.entries.length, 0); assert.equal(ui.permissionConnection, undefined);
  } finally {
    ui.close();
    if (before === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = before;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('compact and legacy Metrics show honest missing/partial counts without attributing unknown reads', async () => {
  const panel = new SessionMetricsPanel({}, { load: async id => ({ ...snapshot(id), currentGoalId: null, goals: [],
    session: { ...usage(0, 0, 0), workerAssignments: undefined }, coverage: { complete: false, legacySkillReads: 8 } }) });
  try {
    panel.open(firstId); await settle();
    assert.match(sessionMetricsLayout(panel, 42).lines.map(line => line.text).join('\n'), /No current goal/);
    await panel.activate('session');
    for (const width of [42, 78, 120]) {
      const layout = sessionMetricsLayout(panel, width), text = layout.lines.map(line => line.text).join('\n');
      assert.match(text, /Partial history/); assert.match(text, /8 older skill reads/);
      assert.match(text, /Skill model loads[: ]+0/); assert.match(text, /Worker assignments[: ]+—/);
      assert.match(text, /No recorded skill use/); assert.ok(layout.lines.every(line => cellWidth(line.text) <= width));
    }
    assert.ok(commandSuggestions('/metr').some(item => item.command === '/metrics'));
  } finally { panel.close(); }
});

test('Metrics separates follow-ups, distinguishes same-name skill scopes and versions, and preserves stalled goal reasons', async () => {
  const data = snapshot();
  Object.assign(data.session, { subagentFollowups: 2, workerFollowups: 1,
    skillRows: [{ id: 'project-skill', name: 'http-review', scope: 'project', version: 'a'.repeat(64), count: 2 },
      { id: 'global-skill', name: 'http-review', scope: 'global', version: 'b'.repeat(64), count: 1 }],
    agentRows: [{ id: 'analyst', name: 'Response analyst', count: 7, followups: 2 }],
    workerRows: [{ role: 'reviewer', count: 10, followups: 1 }] });
  const panel = new SessionMetricsPanel({}, { load: async () => data });
  try {
    panel.open(firstId); await settle(); await panel.activate('session');
    const text = sessionMetricsLayout(panel, 78).lines.map(line => line.text).join('\n');
    assert.match(text, /Specialist agents invoked\s+7/); assert.match(text, /Specialist follow-ups\s+2/);
    assert.match(text, /Worker assignments\s+10/); assert.match(text, /Worker follow-ups\s+1/);
    assert.match(text, /Response analyst\s+7 · 2 follow-ups/); assert.match(text, /Reviewer\s+10 · 1 follow-up/);
    assert.match(text, /This project · version aaaaaaaa/); assert.match(text, /BZZY Core \/ global · version bbbbbbbb/);
    await panel.activate('goal');
    for (const [status, reason, expected] of [['paused', 'turn_limit', /Current goal · Stalled · turn limit/],
      ['awaiting_review', 'evidence_missing', /Current goal · Stalled · awaiting review/], ['paused', 'manual', /Current goal · Paused/]]) {
      Object.assign(data.goals[0], { status, reason });
      const goalText = sessionMetricsLayout(panel, 78).lines.map(line => line.text).join('\n');
      assert.match(goalText, expected);
      if (reason === 'evidence_missing') assert.match(goalText, /Reason: evidence missing/);
    }
  } finally { panel.close(); }
});

test('Metrics labels compaction and recovery pauses as stalled in the current goal and recorded-goal picker', async () => {
  const data = snapshot(); let options;
  const panel = new SessionMetricsPanel({ chooseOne: async (_title, entries) => { options = entries; return null; } }, { load: async () => data });
  try {
    panel.open(firstId); await settle();
    for (const [reason, label] of [['context_no_progress', 'no progress'], ['recovery_required', 'recovery required']]) {
      Object.assign(data.goals[0], { status: 'paused', reason });
      const layout = sessionMetricsLayout(panel, 78), heading = layout.lines.find(line => line.text.includes('Current goal ·'));
      assert.equal(heading.text.trim(), 'Current goal · Stalled · ' + label); assert.equal(heading.tone, 'danger');
      assert.ok(layout.lines.some(line => line.text.includes('Reason: ' + reason.replaceAll('_', ' '))));
      await panel.activate('history'); assert.match(options[0].label, new RegExp('Stalled · ' + label));
      assert.equal(data.goals[0].status, 'paused'); assert.equal(data.goals[0].reason, reason);
    }
    Object.assign(data.goals[0], { reason: 'user_pause' });
    const heading = sessionMetricsLayout(panel, 78).lines.find(line => line.text.includes('Current goal ·'));
    assert.equal(heading.text.trim(), 'Current goal · Paused'); assert.equal(heading.tone, 'warning');
  } finally { panel.close(); }
});

test('active Validate footer says Validating throughout checks and consensus while other goal states retain meaning', () => {
  const { ui, frame } = terminal();
  try {
    for (const phase of ['independent_check', 'missing_evidence', 'final_review', 'consensus']) {
      ui.updateSession({ session: { id: firstId, provider: 'codex', model: 'review-model', mode: 'debate', goal: { id: 'review', status: 'active' } }, execution: { state: 'running' } });
      ui.event('debate.phase', { debateId: 'review', phase }); ui.tui.render();
      assert.match(frame(), /Validating…/); assert.doesNotMatch(frame(), /Pursuing goal/);
    }
    for (const [status, pattern] of [['paused', /Goal paused/], ['blocked', /Goal stalled/], ['complete', /Goal achieved/]]) {
      ui.updateSession({ session: { id: firstId, mode: 'debate', goal: { id: 'review', status } }, execution: { state: 'finished' } }); ui.tui.render();
      assert.match(frame(), pattern); assert.doesNotMatch(frame(), /Validating…/);
    }
    assert.match(goalIndicator({ status: 'active' }).label, /Pursuing goal/);
    assert.match(goalIndicator({ status: 'verifying' }).label, /Verifying goal/);
    ui.updateSession({ id: firstId, mode: 'solo', goal: { id: 'source', status: 'complete' }, goalValidation: { state: 'pending', sourceGoalId: 'source', sourceSessionId: firstId, revision: 1, reviewSessionId: 'review' } });
    ui.tui.render(); assert.match(frame(), /Goal achieved ✓.*Validating…/);
  } finally { ui.close(); }
});
