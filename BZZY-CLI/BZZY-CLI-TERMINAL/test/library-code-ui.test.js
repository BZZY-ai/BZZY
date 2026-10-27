import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { shareLibraryBundle } from '../src/share-ui.js';
import { transferLibraryTab, transferLibrary } from '../src/library-ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createSession } from '@bzzy/core/engine/store.js';
import { libraryImportEntryIndexes } from '@bzzy/core/engine/definition-bundle.js';
import { listRecords } from '@bzzy/core/engine/database.js';

const code = 'BZZY-LIBRARY-2.' + Array(4).fill(Buffer.alloc(32, 11).toString('base64url')).join('.');
const sender = Buffer.alloc(32, 12).toString('base64url');
let directory, cwd, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-code-ui-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Expected private transfer state did not appear');
}
function terminal(columns = 80, rows = 24) {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns, rows }); output.resume();
  const ui = new UI({ input, output, error: output });
  const session = createSession({ id: 'codex', backend: 'codex' }, cwd, 'offline-fixture'); ui.setSession(session.id);
  Object.assign(ui.tui, { value: 'Keep the existing draft', cursor: 5 });
  const frames = []; ui.tui.writeFrame = frame => { frames.push(frame); };
  return { ui, input, output, frames, close() { ui.reader?.close(); ui.close(); input.destroy(); output.destroy(); } };
}
function transport(calls) {
  return { CoreTerminalSharing: class {
    async start() {}
    async createLibraryShare(input) { calls.push(input); return { shareId: randomUUID(), code, approval: 'code', senderFingerprint: sender, expiresAt: Date.now() + 60000 }; }
    async status() { return { state: 'open', pending: [] }; }
    async revokeShare() { calls.push('revoked'); }
    async close() {}
  } };
}

for (const result of [{ copied: true, method: 'native' }, { copied: true, method: 'osc52' }, { copied: false }]) {
  test(`Copy code button and immediate C report ${result.method || 'failure'} honestly without exposing the code`, async () => {
    const screen = terminal(), { ui, input, frames } = screen, calls = []; let copies = 0, task;
    try {
      task = shareLibraryBundle(cwd, { entries: [{}], sourceDigest: 'a'.repeat(64), kinds: ['skill'] }, ui, {
        relayLoader: async () => transport(calls), copy: async (value, output) => { assert.equal(value, code); assert.equal(output, ui.output); copies++; return result; },
      });
      await until(() => ui.privateView?.actionMode && ui.tui.resolveInput); ui.tui.render();
      let frame = clean(frames.at(-1)); assert.match(frame, /EXPORT CODE/); assert.match(frame, /\[ Copy code \]/);
      assert.doesNotMatch(frame, /Sender fingerprint|Verification|Enter refresh/);
      const copy = ui.tui.hitTargets.find(hit => hit.type === 'private-action' && hit.action === 'c'); assert.ok(copy);
      ui.tui.mouse(0, copy.left, copy.row);
      await until(() => copies === 1 && ui.privateView?.actionMode && ui.tui.resolveInput); ui.tui.render(); frame = clean(frames.at(-1));
      if (!result.copied) { assert.match(frame, /Could not copy/); assert.doesNotMatch(frame, /Code copied/); }
      else assert.match(frame, result.method === 'osc52' ? /Copy request sent/ : /Code copied/);
      input.write('c'); await until(() => copies === 2 && ui.privateView?.actionMode && ui.tui.resolveInput);
      assert.ok(!JSON.stringify(ui.tui.entries).includes(code)); assert.ok(!JSON.stringify(ui.tui.history).includes(code));
      assert.equal(ui.tui.lastFrame.length, 0); assert.equal(ui.tui.lastCopiedText, undefined);
      ui.tui.key('', { name: 'escape' }); await task;
      assert.ok(!calls.includes('revoked'), 'Back leaves this single-use offer owned by Core until expiry');
      assert.equal(ui.privateView, undefined); assert.equal(ui.tui.value, 'Keep the existing draft'); assert.equal(ui.tui.cursor, 5);
    } finally { screen.close(); await task?.catch(() => {}); }
  });
}

test('Revoke code is a clickable action and cannot run just from typing into an import prompt', async () => {
  const screen = terminal(50, 20), { ui } = screen, calls = []; let task;
  try {
    task = shareLibraryBundle(cwd, { entries: [{}], sourceDigest: 'a'.repeat(64), kinds: ['agent'] }, ui, { relayLoader: async () => transport(calls) });
    await until(() => ui.privateView?.actionMode && ui.tui.resolveInput); ui.tui.render();
    const hit = ui.tui.hitTargets.find(hit => hit.type === 'private-action' && hit.action === '/cancel'); assert.ok(hit);
    assert.ok(hit.row <= 20 && hit.right < 50); ui.tui.mouse(0, hit.left, hit.row); await task;
    assert.equal(calls.filter(item => item === 'revoked').length, 1);
  } finally { screen.close(); await task?.catch(() => {}); }
});

test('Import is one hidden paste, actual download progress, install stage and only newly installed names', async () => {
  const screen = terminal(), { ui, input, frames } = screen; let task, reviews = 0;
  try {
    ui.chooseMany = async () => assert.fail('The recipient does not select the source entries again');
    ui.chooseOne = async () => assert.fail('The recipient does not confirm an additional review menu');
    task = transferLibraryTab('import', 'skill', cwd, ui, { loadBundle: async () => ({ libraryImportEntryIndexes }), relayLoader: async () => ({
      importLibraryShare: async request => {
        assert.equal(request.code, code); assert.equal(request.expectedSenderFingerprint, undefined);
        request.onPhase('connecting'); request.onIdentity({ recipientFingerprint: sender }); request.onPhase('downloading');
        request.onProgress({ received: 1024, total: 4096 });
        await new Promise(resolve => setTimeout(resolve, 25));
        request.onProgress({ received: 9999, total: 4096 });
        request.onPhase('checking');
        const decision = await request.onReview({ entries: [{ kind: 'skill', name: 'new-controls', scope: 'global' }, { kind: 'skill', name: 'already-there', scope: 'global' }], conflicts: [{ kind: 'skill', name: 'already-there', scope: 'global' }] });
        reviews++; assert.deepEqual(decision, { approved: true, enable: true, entryIndexes: [0, 1] });
        request.onPhase('installing');
        return { skills: [{ name: 'new-controls' }], skipped: [{ kind: 'skill', name: 'already-there' }], alreadyImported: false };
      },
    }) });
    await until(() => ui.tui.hidden && ui.tui.resolveInput); ui.tui.render();
    assert.match(clean(frames.at(-1)), /ENTER CODE/); assert.doesNotMatch(clean(frames.at(-1)), /fingerprint/);
    input.write('\x1b[200~' + code + '\x1b[201~\r'); await task;
    const rendered = frames.map(clean).join('\n');
    assert.match(rendered, /25% · 1.0 KiB \/ 4.0 KiB/); assert.match(rendered, /Checking package integrity/); assert.match(rendered, /Installing new entries/);
    assert.equal(reviews, 1); assert.equal(ui.privateView, undefined);
    const complete = ui.tui.entries.map(entry => entry.text).join('\n');
    assert.match(complete, /Installed:[\s\S]*Skill · new-controls/); assert.doesNotMatch(complete, /already-there/); assert.ok(!complete.includes(code));
    assert.equal(ui.tui.value, 'Keep the existing draft'); assert.equal(ui.tui.cursor, 5);
  } finally { screen.close(); await task?.catch(() => {}); }
});

test('whole Library import keeps Settings behind private progress and restores its saved chat draft', async () => {
  const screen = terminal(), { ui, input, frames } = screen; let task;
  const version = '7'.repeat(64), goalText = 'Review the supplied evidence and write the report.';
  const entries = [
    { kind: 'skill', name: 'new-controls', scope: 'project' },
    { kind: 'agent', name: 'new-reviewer', scope: 'global' },
    { kind: 'workflow', name: 'new-process', scope: 'project' },
    { kind: 'goal', name: 'goal-' + version.slice(0, 48), scope: 'global', version, description: goalText },
    { kind: 'skill', name: 'already-there', scope: 'global' },
  ];
  try {
    ui.openSettings(); ui.settings.page = 'core'; ui.settings.busy = true;
    ui.chooseMany = async () => assert.fail('The recipient should not select the entries again');
    ui.chooseOne = async () => assert.fail('The recipient should not review another menu');
    task = transferLibrary('import', cwd, ui, { loadBundle: async () => ({ libraryImportEntryIndexes }), relayLoader: async () => ({
      importLibraryShare: async request => {
        assert.equal(request.code, code); assert.equal(request.expectedSenderFingerprint, undefined);
        request.onIdentity({ recipientFingerprint: sender }); request.onPhase('downloading');
        request.onProgress({ received: 2048, total: 4096 });
        ui.tui.render();
        assert.equal(ui.tui.panel, 'settings'); assert.equal(ui.settings.page, 'core');
        assert.ok(!ui.tui.hitTargets.some(hit => hit.type === 'settings'), 'private transfer has no live Settings actions');
        request.onPhase('checking');
        assert.deepEqual(await request.onReview({ entries, conflicts: [entries[4]] }),
          { approved: true, enable: true, entryIndexes: [0, 1, 2, 3, 4] });
        request.onPhase('installing');
        return { skills: [{ name: 'new-controls' }], agents: [{ name: 'new-reviewer' }], workflows: [{ name: 'new-process' }],
          goals: [{ id: 'template:' + version, version }], skipped: [{ kind: 'skill', name: 'already-there' }] };
      },
    }) });
    await until(() => ui.tui.hidden && ui.tui.resolveInput); ui.tui.render();
    assert.match(clean(frames.at(-1)), /ENTER CODE/);
    assert.doesNotMatch(clean(frames.at(-1)), /Background service|Update BZZY|Keep the existing draft/);
    input.write('\x1b[200~' + code + '\x1b[201~\r'); await task;
    const rendered = frames.map(clean).join('\n');
    assert.match(rendered, /50% · 2.0 KiB \/ 4.0 KiB/);
    assert.match(rendered, /Checking package integrity/); assert.match(rendered, /Installing new entries/);
    assert.equal(ui.privateView, undefined); assert.equal(ui.tui.panel, 'settings'); assert.equal(ui.settings.page, 'core');
    const complete = ui.tui.entries.map(entry => entry.text).join('\n');
    for (const label of ['Skill · new-controls', 'Specialist agent · new-reviewer', 'Workflow · new-process', 'Goal · ' + goalText]) assert.ok(complete.includes(label));
    assert.doesNotMatch(complete, /already-there|goal-777|template:/); assert.ok(!complete.includes(code));
    assert.ok(!JSON.stringify(ui.tui.history).includes(code));
    ui.settings.busy = false; ui.tui.setPanel('chat');
    assert.equal(ui.tui.value, 'Keep the existing draft'); assert.equal(ui.tui.cursor, 5);
    assert.equal(listRecords('execution').length, 0);
  } finally { screen.close(); await task?.catch(() => {}); }
});
