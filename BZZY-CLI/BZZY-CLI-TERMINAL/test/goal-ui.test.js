import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { UI } from '../src/ui.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { putRecord, getRecord, listRecords } from '../src/database.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { goalIndicator } from '../src/goal-indicator.js';
import { palette } from '../src/terminal-theme.js';
import { initializeLaunchYolo } from '../src/permission-controls.js';

let directory, previous, session, ui, output;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-goal-ui-')); process.env.BZZY_HOME = path.join(directory, 'private');
  putRecord('core.update.preferences', 'default', { monitoringEnabled: false });
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 140, rows: 40 }); output.resume();
  session = createSession(BUILTINS.codex, directory, 'fixture-model', 'TestSession');
  ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id); ui.updateSession(session);
});
test.afterEach(async () => {
  ui.close(); const info = runtimeInfo();
  if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
  for (let index = 0; info && identityAlive(info.identity) && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 20));
  if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { force: true, recursive: true });
});
async function connection() {
  const info = await ensureRuntime(), owner = randomUUID();
  await runtimeRequest(info, 'POST', `/sessions/${session.id}/claim`, { owner }); ui.permissionConnection = { info, owner, sessionId: session.id };
  ui.onAnswerApproval = (question, answer) => runtimeRequest(info, 'POST', `/sessions/${session.id}/answer`, { owner, questionId: question.id, answer }, randomUUID());
}
function pending() {
  const question = { id: randomUUID(), sessionId: session.id, kind: 'approval', state: 'pending', question: '/bin/zsh -lc "fixture command"\nAllow once? [y/N] ', expiresAt: Date.now() + 60000 };
  putRecord('question', question.id, question); ui.event('question', question); return question;
}
test('clicking YOLO toggles Core permissions, accepts the pending approval and preserves the unsent draft', async () => {
  await connection(); const input = ui.ask('bzzy › '); await Promise.resolve(); ui.tui.value = 'Unsent draft'; ui.tui.cursor = 12;
  const question = pending(); ui.tui.render();
  const toggle = ui.tui.hitTargets.find(hit => hit.type === 'yolo'); assert.ok(toggle);
  ui.tui.mouse(0, toggle.left, toggle.row); await ui.tui.permissionTask;
  assert.equal(ui.yoloEnabled(), true); assert.equal(getRecord('question', question.id).answer, 'yes');
  assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.inputQueue.length, 0); assert.equal(listRecords('execution').length, 0);
  assert.equal(await ui.settingsCommand('/yolo'), true); assert.equal(ui.yoloEnabled(), false);
  ui.sessionMode = 'VIEW'; assert.equal(await ui.toggleYolo(), false); assert.equal(ui.yoloEnabled(), false);
  ui.reader.close(); await input;
});
test('approval cards expose command details and check/cross actions send exactly yes/no through Core ownership', async () => {
  await connection();
  for (const answer of ['yes', 'no']) {
    const question = pending(); ui.tui.render();
    const details = ui.tui.hitTargets.find(hit => hit.type === 'approval-details' && hit.id === question.id);
    assert.ok(details); ui.tui.mouse(0, details.left, details.row); assert.equal(ui.tui.entries.at(-1).expanded, true);
    ui.tui.render(); const button = ui.tui.hitTargets.find(hit => hit.type === 'approval' && hit.answer === answer); assert.ok(button);
    ui.tui.mouse(0, button.left, button.row); await ui.tui.approvalTask;
    assert.equal(getRecord('question', question.id).answer, answer); assert.equal(ui.tui.inputQueue.length, 0);
    ui.tui.event('question.answered', { id: question.id, answer });
  }
  assert.equal(listRecords('execution').length, 0);
});
test('turning off an explicit --yolo launch before sending cannot silently re-enable it on execution', async () => {
  await connection(); ui.launchYolo = true; assert.equal(ui.yoloEnabled(), true);
  assert.equal(await ui.toggleYolo(), true); assert.equal(ui.yoloEnabled(), false);
  initializeLaunchYolo(ui, session.id, ui.permissionConnection.owner);
  assert.equal(ui.executionOptions({ yolo: true }, session).yolo, false);
});
test('goal colors follow authoritative lifecycle states and animated dots fit compact and wide composers', () => {
  const tones = { active: palette.goalActive, verifying: palette.goalActive, complete: palette.goalSuccess, blocked: palette.danger, budget_limited: palette.danger };
  for (const [status, tone] of Object.entries(tones)) {
    ui.updateSession({ ...session, goal: { id: 'goal-fixture', objective: 'Tell me Messi age', status } });
    assert.equal(goalIndicator(ui.tui.goal).tone, tone);
    for (const [columns, rows] of [[80, 24], [140, 40]]) {
      Object.assign(output, { columns, rows }); ui.tui.render();
      const frame = ui.tui.lastFrame.map(clean).join('\n');
      assert.match(frame, /YOLO OFF/); assert.match(frame, status === 'complete' ? /Goal achieved/ : ['active', 'verifying'].includes(status) ? /goal\.\.\./ : /Goal stalled/);
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
    }
  }
  ui.updateSession({ ...session, goal: { id: 'goal-clock', objective: 'Keep time', status: 'paused', runtimeUsedSeconds: 3661 } });
  ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /01:01:01/);
  assert.notEqual(goalIndicator({ status: 'active' }, 0).label, goalIndicator({ status: 'active' }, 1).label);
});
