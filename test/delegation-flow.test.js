import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describeDelegation } from '../src/delegation-setup.js';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';

const project = new URL('../', import.meta.url).pathname;
const source = file => new URL(file, new URL('../', import.meta.url)).href;
const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const delegated = { id: sessionId, mode: 'delegate', provider: 'codex', model: 'strong-model', selectedEffort: 'high', executor: { provider: 'deepseek', model: 'routine-model', effort: 'low' } };

function terminal() {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 32, columns: 100 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession(sessionId);
  return { ui, output, input };
}

test('delegation setup explains ordinary chat and the explicit goal command', () => {
  assert.match(describeDelegation(delegated), /You do not need to create assignments/);
  assert.match(describeDelegation(delegated), /Chat normally/);
  assert.match(describeDelegation(delegated), /\/goal <objective>/);
  assert.match(describeDelegation({ ...delegated, goal: { status: 'paused' } }), /saved goal is retained/);
});

test('delegate handoffs and attributed activity stay readable without exposing raw worker reports', () => {
  const { ui, output } = terminal();
  try {
    ui.updateSession({ ...delegated, cwd: '/challenge', executionState: 'running' });
    ui.event('message.user', { text: 'Solve this CTF', kind: 'goal' });
    ui.event('assignment.created', { id: 'assignment-a', selection: delegated.executor, currentRound: 1, contract: { objective: 'Inspect the supplied archive and record candidate entry points' } });
    assert.equal(ui.tui.delegationPhase, 'Executor running');
    ui.event('activity', { id: 'worker-activity', sessionId: 'worker-chat', agent: 'deepseek', status: 'running', summary: 'Checking archive entry points', details: 'I am mapping the supplied files and recording evidence for the supervisor.' });
    ui.tui.setPanel('activity'); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Hands · deepseek · Checking archive entry points/);
    ui.event('assignment.finished', { id: 'assignment-a', round: 1, state: 'awaiting_review', report: { summary: 'RAW-REPORT-MUST-STAY-OUT', workerClaim: 'complete' } });
    assert.equal(ui.tui.delegationPhase, 'Supervisor reviewing');
    ui.tui.setPanel('chat'); ui.tui.render();
    const text = ui.tui.entries.map(entry => entry.text).join('\n');
    assert.match(text, /Brain → hands · deepseek · routine-model/);
    assert.match(text, /Hands → brain · Evidence is ready for review/);
    assert.doesNotMatch(text, /RAW-REPORT-MUST-STAY-OUT/);
    ui.event('assignment.reviewed', { assignmentId: 'assignment-a', outcome: 'accepted', rationale: 'PRIVATE-REVIEW-DETAIL' });
    assert.equal(ui.tui.delegationPhase, 'Supervisor planning');
    assert.match(ui.tui.entries.at(-1).text, /Brain review · accepted/);
    assert.doesNotMatch(ui.tui.entries.at(-1).text, /PRIVATE-REVIEW-DETAIL/);
    ui.event('assignment.failed', { id: 'assignment-b', error: 'RAW-ERROR-REPORT' });
    assert.match(ui.tui.entries.at(-1).text, /parent goal remains unresolved/);
    for (const [columns, rows] of [[100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /Supervisor reviewing/); assert.match(frame, /╭─ Message/); assert.match(frame, new RegExp(sessionId));
    }
  } finally { ui.close(); }
});

test('delegate fixed counters retain independent usage and explicitly mark incomplete telemetry', () => {
  const { ui, output } = terminal();
  try {
    ui.updateSession({ ...delegated, executionState: 'running', delegationUsage: { supervisorTokens: 1234, delegatedTokens: 5678, totalTokens: 6912, complete: true, agents: [{ tokens: 5678, available: true }] } });
    for (const [columns, rows] of [[100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      assert.match(ui.tui.lastFrame.map(clean).join('\n'), /brain 1,234 · hands 5,678 · total 6,912 tokens/);
    }
    ui.event('delegation.usage', { supervisorTokens: 1234, delegatedTokens: 0, totalTokens: 1234, complete: false, agents: [{ tokens: null, available: false }] }); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /brain 1,234 · hands — · total ≥1,234 tokens/);
    ui.clearHistory(); ui.updateSession({ ...delegated, executionState: 'idle' }); ui.tui.render();
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /brain — · hands — · total — tokens/);
  } finally { ui.close(); }
});

test('terminal navigation keeps the views, session ID and composer without persistent shortcut clutter', () => {
  const { ui, output } = terminal();
  try {
    ui.updateSession({ id: sessionId, provider: 'codex', model: 'fixture-brain', executionState: 'idle' });
    for (const [columns, rows] of [[100, 32], [80, 24]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /CHAT\s+ACTIVITY\s+HTTP\s+TELEGRAM/);
      assert.match(frame, /╭─ Message/); assert.match(frame, new RegExp(sessionId));
      assert.doesNotMatch(frame, /Ctrl\+G|Ctrl\+S|Wheel\/PgUp|COPY/);
      assert.equal(ui.tui.hitTargets.some(hit => hit.type === 'copy'), false);
    }
  } finally { ui.close(); }
});

test('mouse phrase selection copies Unicode screen cells without interrupting work or losing the draft', async () => {
  const { ui, input } = terminal(), copied = []; let interrupted = 0;
  const interrupt = () => { interrupted++; }; process.on('SIGINT', interrupt);
  ui.clipboard = { async copyText(text) { copied.push(text); return { copied: true, method: 'native' }; } };
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.key('Keep this draft', {});
    ui.event('text', { text: 'alpha naïve 世界 omega', itemId: 'reply' }); ui.tui.render();
    const row = ui.tui.lastFrame.findIndex(line => clean(line).includes('alpha naïve 世界 omega')) + 1;
    const left = cellWidth('  alpha ') + 1, right = left + cellWidth('naïve 世界') - 1;
    input.write(`\x1b[<0;${left};${row}M`); input.write(`\x1b[<32;${right};${row}M`); input.write(`\x1b[<0;${right};${row}m`); ui.tui.render();
    assert.equal(ui.tui.selectedText(), 'naïve 世界');
    assert.ok(ui.tui.lastFrame[row - 1].includes('\x1b[48;5;24m'));
    ui.event('text', { text: '\nA reply arrived while selecting.', itemId: 'reply' }); ui.tui.render();
    assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /arrived while selecting/);
    input.write('\x03'); await ui.tui.clipboardTask; ui.tui.render();
    assert.deepEqual(copied, ['naïve 世界']); assert.equal(interrupted, 0); assert.equal(ui.tui.value, 'Keep this draft');
    assert.match(ui.tui.lastFrame.map(clean).join('\n'), /arrived while selecting/);
    ui.reader.close(); await answer;
  } finally { process.removeListener('SIGINT', interrupt); ui.close(); }
});

test('each assistant copy icon copies its full latest response in read-only views, even beyond visible wrapping', async () => {
  const { ui } = terminal(), copied = [];
  ui.clipboard = { async copyText(text) { copied.push(text); return { copied: true, method: 'osc52' }; } };
  try {
    ui.setSession(sessionId, 'VIEW');
    const full = '**Supported conclusion**\n' + Array.from({ length: 40 }, (_, index) => `Evidence line ${index} with original markdown.`).join('\n');
    ui.event('text', { text: full, itemId: 'long-answer' }); ui.tui.render();
    ui.tui.scroll = ui.tui.scrollbar.maximum; ui.tui.render();
    let icon = ui.tui.hitTargets.find(hit => hit.type === 'copy-response'); assert.ok(icon);
    assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /Evidence line 39/);
    ui.event('text', { text: '\nLast streaming addition.', itemId: 'long-answer' });
    ui.tui.mouse(0, icon.left, icon.row); await ui.tui.clipboardTask;
    assert.deepEqual(copied, [full + '\nLast streaming addition.']);
    ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Copy request sent/);
  } finally { ui.close(); }
});

test('Ctrl+V inserts clipboard text at the cursor and uses the last bzzy copy when remote clipboard reading is unavailable', async () => {
  const { ui } = terminal(); let reads = 0;
  ui.clipboard = {
    async copyText() { return { copied: true, method: 'osc52' }; },
    async readClipboard() { reads++; return reads === 1 ? { text: 'pasted\ntext' } : { text: null, reason: 'Clipboard reading unavailable' }; },
  };
  try {
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    assert.equal(reads, 0, 'clipboard is only read on explicit paste');
    ui.tui.key('start end', {}); ui.tui.cursor = 6;
    ui.tui.key('\x16', { name: 'v', ctrl: true }); await ui.tui.clipboardTask;
    assert.equal(ui.tui.value, 'start pasted\ntextend');
    assert.equal(ui.tui.resolveInput != null, true, 'paste does not submit a multiline message');
    await ui.tui.copySelection('copied phrase');
    ui.tui.key('\x16', { name: 'v', ctrl: true }); await ui.tui.clipboardTask;
    assert.equal(ui.tui.value, 'start pasted\ntextcopied phraseend');
    assert.match(ui.tui.clipboardStatus, /last bzzy copy/);
    delete ui.tui.lastCopiedText; const before = ui.tui.value;
    ui.tui.key('\x16', { name: 'v', ctrl: true }); await ui.tui.clipboardTask; assert.equal(ui.tui.value, before);
    assert.match(ui.tui.clipboardStatus, /unavailable/);
    ui.reader.close(); await answer;
  } finally { ui.close(); }
});

test('the --delegate wizard starts an explicit goal and saves independent brain/hands choices', { timeout: 30000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-delegate-flow-'));
  const script = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { main } from ${JSON.stringify(source('src/cli.js'))};
    import { UI } from ${JSON.stringify(source('src/ui.js'))};
    import { sessions } from ${JSON.stringify(source('src/store.js'))};
    import { BUILTINS, saveConfig } from ${JSON.stringify(source('src/providers.js'))};
    import { listRecords } from ${JSON.stringify(source('src/database.js'))};
    import { runtimeInfo, runtimeRequest } from ${JSON.stringify(source('src/runtime.js'))};
    import { identityAlive } from ${JSON.stringify(source('src/recovery.js'))};
    import { delay } from ${JSON.stringify(source('src/delegation.js'))};
    const server = http.createServer((request, response) => {
      assert.equal(request.url, '/models');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'routine-model', effort: { supported_levels: ['low', 'high'], default_level: 'low' } }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    saveConfig({ version: 1, defaultProvider: 'codex', providers: { deepseek: { ...BUILTINS.deepseek, model: 'routine-model', baseUrl: 'http://127.0.0.1:' + server.address().port } } });
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    const seen = []; let entered = false;
    UI.prototype.openTerminal = function () {};
    UI.prototype.updateSession = function () {};
    UI.prototype.event = function (type, data) { seen.push({ type, data }); };
    UI.prototype.chooseOne = async function (title, options) {
      await options;
      if (title.includes('Choose provider')) return title.startsWith('Supervisor') ? 'codex' : 'deepseek';
      return title.startsWith('Supervisor') ? { value: 'fixture-brain', effort: 'xhigh' } : { value: 'routine-model', effort: 'low' };
    };
    UI.prototype.ask = async function (question) {
      assert.equal(question, 'bzzy › ');
      if (entered) return '/exit';
      entered = true; return '/goal Solve this CTF using the supplied files';
    };
    try {
      assert.equal(await main(['--delegate', '--no-pet', '--detach', '--cwd', process.env.FLOW_DIRECTORY]), 0);
      const saved = sessions()[0];
      assert.equal(saved.mode, 'delegate'); assert.equal(saved.provider, 'codex'); assert.equal(saved.model, 'fixture-brain'); assert.equal(saved.selectedEffort, 'xhigh');
      assert.equal(saved.executor.provider, 'deepseek'); assert.equal(saved.executor.model, 'routine-model'); assert.equal(saved.executor.effort, 'low');
      assert.equal(saved.goal.objective, 'Solve this CTF using the supplied files');
      const job = listRecords('execution').find(item => item.sessionId === saved.id);
      assert.ok(job, JSON.stringify(seen)); assert.equal(job.goal, true); assert.equal(job.prompt, saved.goal.objective);
      const info = runtimeInfo(), owner = 'flow-test-control';
      await runtimeRequest(info, 'POST', '/sessions/' + saved.id + '/claim', { owner, takeover: true });
      await runtimeRequest(info, 'POST', '/sessions/' + saved.id + '/control', { owner, action: 'cancel' }, 'flow-test-cancel');
      for (let attempt = 0; attempt < 120; attempt++) {
        const current = listRecords('execution').find(item => item.id === job.id);
        if (!['queued', 'launching', 'running'].includes(current.state)) break;
        await delay(50);
      }
    } finally {
      const info = runtimeInfo();
      if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
      for (let attempt = 0; attempt < 100 && info && identityAlive(info.identity); attempt++) await delay(20);
      await new Promise(resolve => server.close(resolve));
    }
  `;
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: project,
      env: { ...process.env, BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_CODEX_BIN: path.join(project, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_ADVANCED: 'conversation', DEEPSEEK_API_KEY: 'fixture-not-real', FLOW_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const kill = setTimeout(() => child.kill('SIGKILL'), 25000);
    try { assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0, output); }
    finally { clearTimeout(kill); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
