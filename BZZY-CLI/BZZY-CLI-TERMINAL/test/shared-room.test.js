import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean } from '../src/terminal-format.js';
import { createSession, saveSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { newGoal } from '../src/goals.js';
import { appendEvent, putRecord, getRecord, listRecords } from '../src/database.js';
import { viewSession } from '../src/runtime-client.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/recovery.js';
import { delay } from '../src/delegation.js';

test('a read-only child TUI receives the full live group room, deduplicates mirrored messages and filters unrelated parent chat', { timeout: 15000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-room-live-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 32 }); output.resume();
  const ui = new UI({ input, output, error: output }); let publish, timeout;
  try {
    const parent = createSession(BUILTINS.codex, directory), first = createSession(BUILTINS.codex, directory), second = createSession(BUILTINS.claude, directory);
    Object.assign(parent, { mode: 'besties', goal: newGoal('Verify the supplied challenge solution') }); saveSession(parent);
    const peers = [{ sessionId: first.id, namespace: 'codex-bestie-1-proof' }, { sessionId: second.id, namespace: 'claude-bestie-2-proof' }];
    for (const child of [first, second]) { Object.assign(child, { role: 'bestie', parentSessionId: parent.id, bestiesSessionId: parent.id, peers }); saveSession(child); }
    putRecord('besties', parent.id, { goalId: parent.goal.id, peers });
    const message = { id: 'room-proof', groupId: parent.id, from: first.id, to: second.id, text: 'Please independently inspect the recorded local proof.', evidence: ['proof-evidence'], createdAt: '2026-10-21T12:00:00.000Z' };
    appendEvent(parent.id, 'peer.message', message); appendEvent(first.id, 'peer.sent', message);
    appendEvent(parent.id, 'text', { text: 'UNRELATED-PARENT-CHAT-MUST-NOT-ENTER-CHILD' });
    await ensureRuntime();
    const seen = [], emit = ui.event.bind(ui);
    ui.event = (type, data) => {
      emit(type, data); seen.push({ type, data });
      if (type === 'peer.review' && data.id === 'live-review') setImmediate(() => input.write('/detach\r'));
    };
    publish = setTimeout(() => {
      appendEvent(parent.id, 'peer.message', { id: 'live-reply', groupId: parent.id, from: second.id, to: first.id, text: 'I inspected the artifact and reproduced the decisive behavior.', evidence: [], createdAt: '2026-10-21T12:01:00.000Z' });
      appendEvent(parent.id, 'peer.review', { id: 'live-review', groupId: parent.id, reviewer: second.id, peerSessionId: first.id, messageId: message.id, assessment: 'supported', rationale: 'The independent local control matches the recorded proof.', evidence: message.evidence, createdAt: '2026-10-21T12:02:00.000Z' });
    }, 300);
    timeout = setTimeout(() => { input.write('/detach\r'); }, 8000);
    assert.equal(await viewSession(first, { follow: true }, ui), 0);
    ui.tui.setPanel('room'); ui.tui.render();
    assert.equal(ui.tui.sharedRoom.length, 3, 'the source mirror and parent record are one message');
    assert.ok(seen.some(item => item.type === 'peer.message' && item.data.id === 'live-reply'));
    assert.ok(seen.some(item => item.type === 'peer.review' && item.data.id === 'live-review'));
    assert.equal(ui.sessionMode, 'VIEW'); assert.equal(ui.tui.peerLabel(second.id), 'claude · 2');
    const frame = ui.tui.lastFrame.map(clean).join('\n');
    assert.match(frame, /codex · 1 → claude · 2/); assert.match(frame, /Message all agents/);
    assert.match(frame, /independent local control/); assert.match(frame, /peer judgment/);
    assert.doesNotMatch(ui.tui.entries.map(entry => entry.text).join('\n'), /UNRELATED-PARENT-CHAT/);
    assert.equal(getRecord('input-owner', first.id), null); assert.equal(getRecord('input-owner', parent.id), null);
    assert.equal(listRecords('execution').length, 0, 'observing the room cannot start model work');
  } finally {
    clearTimeout(publish); clearTimeout(timeout); ui.close();
    const info = runtimeInfo(); if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let attempt = 0; attempt < 100 && info && identityAlive(info.identity); attempt++) await delay(20);
    if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
