import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { shareTerminal, importTerminal, relayImportArgument, forgetPrivateImportInput } from '../src/share-ui.js';
import { UI } from '../src/ui.js';
import { chatCommands, privateChatCommand } from '../src/terminal-commands.js';
import { parseArgs } from '../src/cli.js';

const sender = 's'.repeat(43), recipient = 'r'.repeat(43), code = 'BZZY-TERMINAL-' + 'A'.repeat(43);
function ui(answers = [], secret = code) {
  const object = { interactive: true, json: false, input: { isTTY: true }, output: { isTTY: true },
    events: [], prompts: [], frames: [], sessionMode: 'CONTROL',
    tui: { schedule() { if (object.privateView) object.frames.push(JSON.stringify(object.privateView)); } },
    ask: async question => { object.prompts.push(question); return answers.shift(); },
    secret: async question => { object.prompts.push(question); object.hidden = true; return secret; },
    event: (type, data) => object.events.push({ type, ...data }) };
  return object;
}

test('Relay import keeps FILE.zip compatibility and never exposes codes through JSON/noninteractive output', async () => {
  assert.equal(relayImportArgument(code), true); assert.equal(relayImportArgument('BZZY:INVITE:1:opaque'), true);
  assert.equal(relayImportArgument('/a/project.zip'), false);
  assert.equal(parseArgs(['--import', code]).options.importFile, code);
  assert.ok(chatCommands.some(item => item.command === '/share')); assert.ok(chatCommands.some(item => item.command === '/import'));
  let loaded = false;
  for (const flags of [{ interactive: false }, { json: true }]) {
    await assert.rejects(importTerminal(code, process.cwd(), { ...ui(), ...flags }, { relayLoader: async () => { loaded = true; } }), /private interactive/);
  }
  assert.equal(loaded, false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-share-ui-'));
  try {
    const result = spawnSync(process.execPath, [new URL('../bin/bzzy.js', import.meta.url).pathname, '--import', code, '--json'],
      { cwd: directory, env: { ...process.env, BZZY_HOME: path.join(directory, 'private') }, encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private interactive terminal/);
    assert.ok(!(result.stdout + result.stderr).includes(code));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('hidden import independently confirms sender, exposes recipient identity for approval, and leaves work paused', async () => {
  const terminal = ui([sender, 'IMPORT']), calls = [];
  const id = randomUUID(), destination = path.resolve('/tmp/new recipient project');
  const result = await importTerminal('', destination, terminal, { relayLoader: async () => ({ importTerminalShare: async request => {
    calls.push(request); request.onIdentity({ recipientFingerprint: recipient }); request.onProgress({ received: 10, total: 10 });
    return { primarySession: { id }, sessions: [{ id }] };
  } }) });
  assert.equal(terminal.hidden, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].code, code); assert.equal(calls[0].expectedSenderFingerprint, sender); assert.equal(calls[0].cwd, destination);
  assert.equal(result.primarySession.id, id); assert.equal(terminal.privateView, undefined);
  assert.ok(terminal.frames.some(frame => frame.includes(recipient)));
  assert.ok(!JSON.stringify(terminal.events).includes(code));
  assert.match(terminal.events[0].message, /Execution remains paused/);
  assert.match(terminal.events[0].message, new RegExp(id));
  assert.equal(calls[0].signal.aborted, false);
});

test('invalid fingerprint and wrong-purpose import never claim or load transport and errors omit private input', async () => {
  let loads = 0;
  for (const [value, answers] of [[code, ['untrusted']], ['BZZY-AGENT-' + 'B'.repeat(43), []]]) {
    const terminal = ui(answers);
    await assert.rejects(importTerminal(value, process.cwd(), terminal, { relayLoader: async () => { loads++; } }), error => !error.message.includes(value));
    assert.equal(terminal.privateView, undefined);
  }
  assert.equal(loads, 0);
});

test('sharing requires complete-context consent and exact independent recipient fingerprint before approval', async () => {
  const terminal = ui(['SHARE', 'a', 'wrong', 'a', recipient]), calls = [], shareId = randomUUID();
  let approved = false;
  class Sharing {
    async start() { calls.push('start'); }
    async createShare(input) { calls.push(input); return { shareId, code, senderFingerprint: sender, expiresAt: Date.now() + 60_000, terminalQR: '██\n██' }; }
    async status() { return { shareId, state: approved ? 'complete' : 'pending', pending: [{ claimId: 'claim', fingerprint: recipient }], expiresAt: Date.now() + 60_000 }; }
    async approveShare(input) { calls.push(input); approved = true; }
    async revokeShare() { calls.push('revoke'); }
    async close() { calls.push('close'); }
  }
  const session = { id: randomUUID(), cwd: '/tmp/source project' };
  assert.equal((await shareTerminal(session, terminal, { relayLoader: async () => ({ CoreTerminalSharing: Sharing }) })).state, 'complete');
  const approvals = calls.filter(item => item?.confirmedFingerprint);
  assert.equal(approvals.length, 1); assert.equal(approvals[0].confirmedFingerprint, recipient);
  assert.deepEqual(calls.find(item => item?.sessionId), { sessionId: session.id, ttlSeconds: 600 });
  assert.equal(calls.includes('revoke'), false); assert.equal(calls.at(-1), 'close');
  assert.ok(terminal.frames.some(frame => frame.includes(code))); assert.equal(terminal.privateView, undefined);
  assert.ok(!JSON.stringify(terminal.events).includes(code));
});

test('cancelling an unclaimed share revokes it and transport exception text never leaks codes', async () => {
  let revoked = 0, closed = 0;
  class Sharing {
    async start() {}
    async createShare() { return { shareId: 'share', code, senderFingerprint: sender, expiresAt: Date.now() + 60_000 }; }
    async status() { return { shareId: 'share', state: 'open', pending: [] }; }
    async revokeShare() { revoked++; }
    async close() { closed++; }
  }
  await shareTerminal({ id: randomUUID(), cwd: '/tmp/project' }, ui(['SHARE', null]), { relayLoader: async () => ({ CoreTerminalSharing: Sharing }) });
  assert.equal(revoked, 1); assert.equal(closed, 1);
  const terminal = ui([sender, 'IMPORT']);
  await assert.rejects(importTerminal(code, '/tmp/project', terminal, { relayLoader: async () => ({ importTerminalShare: async () => { throw new Error('Do not print ' + code); } }) }), error => !error.message.includes(code));
  assert.equal(terminal.privateView, undefined);
});

test('private import commands and QR display never enter TUI history, chat entries or frame caches', async () => {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 40, columns: 100 });
  let written = ''; output.on('data', chunk => { written += chunk; });
  const terminal = new UI({ input, output, error: output, pet: false });
  try {
    terminal.setSession(randomUUID());
    const answer = terminal.ask('bzzy › '); await Promise.resolve();
    terminal.tui.value = '/import ' + code; terminal.tui.cursor = terminal.tui.value.length;
    terminal.tui.submitMessage(); assert.equal(await answer, '/import ' + code);
    assert.equal(privateChatCommand('/import ' + code), true);
    assert.equal(terminal.tui.history.length, 0);
    terminal.tui.value = '/import ' + code; terminal.tui.submitMessage();
    assert.equal(terminal.tui.history.length, 0);
    forgetPrivateImportInput(terminal, '/import ' + code);
    terminal.privateView = { title: 'Share terminal', lines: [code], qr: ['██'], notice: '', onCancel() {} };
    terminal.tui.render();
    assert.ok(written.includes(code)); assert.equal(terminal.tui.lastFrame.length, 0);
    assert.ok(!JSON.stringify(terminal.tui.entries).includes(code));
    terminal.privateView = null; terminal.tui.render();
    assert.ok(!JSON.stringify(terminal.tui.lastFrame).includes(code));
  } finally { terminal.close(); input.destroy(); output.destroy(); }
});
