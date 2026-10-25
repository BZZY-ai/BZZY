import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CoreWorkspaces } from '@bzzy/core/workspaces';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { UI } from '../src/ui.js';
import { ClientSettings } from '../src/client-settings.js';
import { PairingQRImage } from '../src/pairing-qr-image.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { palette, createTerminalTheme } from '../src/terminal-theme.js';
import { createSession } from '../src/store.js';
import { BUILTINS, defaultSelection } from '../src/providers.js';
import { home, readJson, writeJson } from '../src/files.js';
import { listRecords, getRecord, putRecord, digest } from '../src/database.js';
import { runtimeInfo, runtimeRequest } from '../src/runtime.js';
import { identityAlive } from '../src/process-identity.js';

let directory, previous;
const keys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'DEEPSEEK_API_KEY', 'BZZY_FIXTURE_CORE_SETTINGS_KEY'];
const terminals = [];
test.beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'bzzy-settings-')));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'native'), BZZY_CODEX_BIN: new URL('./fixtures/codex.mjs', import.meta.url).pathname });
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.BZZY_FIXTURE_CORE_SETTINGS_KEY;
  fs.mkdirSync(home(), { mode: 0o700 }); fs.mkdirSync(path.join(directory, 'workspace'));
});
test.afterEach(async () => {
  for (const term of terminals.splice(0)) { await term.ui.settings?.close(); term.ui.close(); }
  const info = runtimeInfo();
  if (info && identityAlive(info.identity)) {
    await runtimeRequest(info, 'POST', '/shutdown', {}).catch(() => {});
    for (let index = 0; index < 100 && identityAlive(info.identity); index++) await delay(20);
  }
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
function terminal() {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 32, columns: 100 });
  const term = { input, output, written: '' }; output.on('data', chunk => { term.written += chunk; });
  term.ui = new UI({ input, output, error: output, pet: false });
  const session = createSession(BUILTINS.codex, path.join(directory, 'workspace'));
  term.ui.setSession(session.id); terminals.push(term); return term;
}
async function waitFor(check) {
  for (let index = 0; index < 200; index++) { if (check()) return; await delay(10); }
  assert.fail('Expected settings state was not reached.');
}
const fullPermissions = ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'];
const fixturePNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function pairingFixture({ expiresIn = 600000, grants = [], pending = [] } = {}) {
  const calls = [];
  class Gateway extends EventEmitter {
    managed = true;
    status() { return { transport: 'online' }; }
    pendingPairings() { return pending; }
    grants() { return grants; }
    async start() {}
    async close() {}
    async createPairing(input) {
      calls.push(structuredClone(input));
      return { ...input, resource: randomUUID(), code: 'BZZY-PAIR-' + String.fromCharCode(64 + calls.length).repeat(43),
        expiresAt: Date.now() + expiresIn,
        renderQR: async options => options?.terminal === false && options.format === 'png' ? fixturePNG : Array(24).fill('\x1b[47m  ▄▄  \x1b[0m').join('\n') };
    }
  }
  return { calls, module: { CoreRelayClient: Gateway, initializeRelayIdentity: () => ({ id: 'fixture-public-host' }) } };
}

test('Settings presents the four requested options and preserves the chat draft', async () => {
  const { ui } = terminal(), answer = ui.ask('bzzy › '); await Promise.resolve();
  ui.tui.key('unfinished chat', {}); ui.openSettings(); ui.tui.render();
  assert.ok(ui.tui.panels().includes('settings'));
  assert.equal(ui.settings.page, 'main');
  assert.deepEqual(ui.settings.rows().filter(row => row.action).map(row => row.action), ['deepseek', 'workspace-root', 'pair', 'core']);
  const frame = ui.tui.lastFrame.map(clean).join('\n');
  assert.match(frame, /API keys/); assert.match(frame, /BZZY folder/); assert.match(frame, /Pair iPhone/);
  assert.doesNotMatch(frame, /Core coordinator|Prepare host identity|Copy public host certificate|Restart Core|Stop Core/);
  assert.equal(ui.tui.value, '');
  ui.settings.focusAction('deepseek');
  ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'up' });
  ui.tui.key('', { name: 'return' });
  assert.equal(await answer, '/settings deepseek');
  ui.tui.setPanel('chat'); assert.equal(ui.tui.value, 'unfinished chat');
  assert.equal(ui.tui.entries.some(entry => entry.kind === 'user'), false);
});

test('Settings takes over the full screen and keeps all four choices at normal terminal heights', () => {
  const { ui, output } = terminal();
  ui.updateSession({ id: ui.sessionId, provider: 'codex', model: 'fixture-model-banner', cwd: '/fixture-project-path',
    executionState: 'running', usage: { tokens: 987654, available: true } });
  ui.openSettings();
  for (const rows of [24, 32]) {
    Object.assign(output, { rows, columns: 100 }); ui.tui.render();
    const frame = ui.tui.lastFrame.map(clean).join('\n');
    for (const label of ['API keys', 'Default BZZY folder', 'Pair iPhone', 'BZZY Core']) assert.ok(frame.includes(label), `${rows} rows must show ${label}`);
    assert.match(frame, /^\s*Settings/m); assert.doesNotMatch(frame, /◉◉|bzzy/);
    assert.doesNotMatch(frame, /fixture-model-banner|fixture-project-path|987,654 tokens|Ask BZZY to do anything/);
    assert.ok(ui.tui.hitTargets.some(hit => hit.type === 'settings'));
    assert.equal(ui.tui.hitTargets.some(hit => hit.type === 'confirm'), false);
    assert.doesNotMatch(frame, /Core service/);
    assert.equal(frame.includes(ui.sessionId), false); assert.ok(ui.tui.lastFrame.length <= rows);
  }
});

test('Esc leaves any Settings page for the active chat and preserves the draft', async () => {
  const { ui } = terminal(), answer = ui.ask('bzzy › '); await Promise.resolve();
  ui.tui.value = 'Keep this draft'; ui.tui.cursor = 5;
  ui.openSettings(); await ui.settings.run('modes');
  assert.equal(ui.tui.panel, 'settings'); assert.equal(ui.settings.page, 'modes');
  ui.tui.key('\x1b', { sequence: '\x1b', meta: true });
  assert.equal(ui.tui.panel, 'chat');
  assert.equal(ui.tui.value, 'Keep this draft'); assert.equal(ui.tui.cursor, 5);
  ui.reader.close(); assert.equal(await answer, null);
});

test('the visible Esc Chat control leaves Settings and preserves the draft', async () => {
  const { ui } = terminal(), answer = ui.ask('bzzy › '); await Promise.resolve();
  ui.tui.value = 'Visible exit draft'; ui.tui.cursor = 7;
  ui.openSettings(); ui.renderFooter(); ui.tui.render();
  const exit = ui.tui.hitTargets.find(hit => hit.type === 'settings-exit'); assert.ok(exit);
  ui.tui.mouse(0, exit.left, exit.row);
  assert.equal(ui.tui.panel, 'chat');
  assert.equal(ui.tui.value, 'Visible exit draft'); assert.equal(ui.tui.cursor, 7);
  ui.reader.close(); assert.equal(await answer, null);
});

test('BZZY Core Settings exposes one action that updates both CLI and Core', async () => {
  const { ui } = terminal(); ui.openSettings(); ui.settings.page = 'core';
  let updatedWith;
  ui.settings.updater = async target => { updatedWith = target; };
  assert.ok(ui.settings.rows().some(row => row.action === 'update-bzzy'));
  await ui.settings.run('update-bzzy');
  assert.equal(updatedWith, ui);
  assert.equal(ui.settings.busy, false);
  assert.equal(listRecords('execution').length, 0);
});

test('terminal mode settings have separate clickable model/effort fields and preserve unsaved edits through Back', async () => {
  const { ui, output } = terminal(); ui.openSettings();
  await ui.settingsCommand('/settings modes'); assert.equal(ui.settings.page, 'modes');
  assert.deepEqual(ui.settings.rows().map(row => row.action), ['solo-default', 'mode:debate', 'mode:parallel', 'mode:besties', 'mode:delegate']);
  await ui.settings.run('mode:debate'); assert.equal(ui.settings.pageTitle, 'Debate default');
  ui.settings.modes.modelPicker = async () => ({ provider: 'codex', model: 'fixture', effort: 'default' });
  await ui.settings.run('preset-model:0'); assert.equal(ui.settings.modes.draft.dirty, true);
  for (const [columns, rows] of [[80, 24], [140, 40]]) {
    Object.assign(output, { columns, rows }); ui.settings.focusAction('preset-model:0'); ui.tui.settingsEnsureFocus = true; ui.tui.render();
    const model = ui.tui.hitTargets.find(hit => hit.action === 'preset-model:0'), effort = ui.tui.hitTargets.find(hit => hit.action === 'preset-effort:0');
    assert.ok(model && effort); assert.equal(model.row, effort.row); assert.ok(model.right < effort.left);
    assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) < columns));
  }
  ui.settings.back(); assert.equal(ui.settings.page, 'modes');
  await ui.settings.run('mode:debate'); assert.equal(ui.settings.modes.draft.agents[0].model, 'fixture');
  await ui.settings.run('preset-save'); assert.equal(ui.settings.warning, true); assert.match(ui.settings.message, /every agent/);
  await ui.settings.run('preset-model:1'); await ui.settings.run('preset-save');
  assert.equal(ui.settings.warning, false, ui.settings.message); assert.match(ui.settings.message, /2 agents/);
  assert.equal(listRecords('execution').length, 0); assert.equal(ui.tui.entries.some(entry => entry.kind === 'user'), false);
  ui.settings.back(); ui.settings.back(); assert.equal(ui.settings.page, 'core'); ui.settings.back();
  assert.deepEqual(ui.settings.rows().map(row => row.action), ['deepseek', 'workspace-root', 'pair', 'core']);
});

test('Terminal agent setups saves a Solo chat default without starting work', async () => {
  const { ui } = terminal(); ui.openSettings();
  await ui.settings.run('modes');
  assert.equal(ui.settings.rows()[0].action, 'solo-default');
  ui.settings.modelPicker = async () => ({ provider: 'codex', model: 'fixture-solo-model', effort: 'high',
    capabilities: { supportsEffort: true, supportedEfforts: ['high'] } });
  const before = listRecords('execution').length;
  await ui.settings.run('solo-default');
  assert.deepEqual(defaultSelection(), { provider: 'codex', model: 'fixture-solo-model', effort: 'high',
    capabilities: { supportsEffort: true, supportedEfforts: ['high'] } });
  assert.match(ui.settings.message, /Solo chat default saved/);
  assert.equal(listRecords('execution').length, before);
});

test('removed Settings actions cannot change lifecycle, coordinator or identity from the compact menu', async () => {
  const { ui } = terminal(), calls = [];
  const facade = { coreHostStatus: async () => ({ running: false }),
    startCoreHost: async () => calls.push('start'), stopCoreHost: async () => calls.push('stop'), restartCoreHost: async () => calls.push('restart') };
  ui.settings = new ClientSettings(ui, { hostLoader: async () => facade, relayLoader: async () => { calls.push('relay'); throw new Error('unused'); } });
  ui.openSettings();
  const before = listRecords('session');
  for (const action of ['core-start', 'core-stop', 'core-restart', 'core-ai', 'identity', 'certificate', 'connect', 'disconnect', 'remove-key']) await ui.settings.run(action);
  assert.deepEqual(calls, []);
  assert.equal(getRecord('core.assistant', 'default'), null);
  assert.deepEqual(listRecords('session'), before); assert.equal(listRecords('execution').length, 0);
  assert.equal(ui.tui.entries.some(entry => entry.kind === 'user'), false);
  assert.deepEqual(ui.settings.rows().filter(row => row.action).map(row => row.action), ['deepseek', 'workspace-root', 'pair', 'core']);
});

test('Core controls use the owner lifecycle API on a secondary page without executing a chat', async () => {
  const { ui, output } = terminal(), calls = [];
  let running = true, stopped = false;
  const host = {
    coreHostStatus: async () => { calls.push('status'); return { running, operatorStopped: stopped }; },
    startCoreHost: async () => { calls.push('start'); running = true; stopped = false; },
    stopCoreHost: async () => { calls.push('stop'); running = false; stopped = true; },
    restartCoreHost: async () => { calls.push('restart'); running = true; stopped = false; },
  };
  ui.settings = new ClientSettings(ui, { hostLoader: async () => host }); ui.openSettings();
  await ui.settings.run('core');
  assert.deepEqual(calls, ['status']); assert.equal(ui.coreLifecycleInterrupted, undefined);
  assert.equal(ui.settings.page, 'core');
  assert.deepEqual(ui.settings.rows().filter(row => row.action).map(row => row.action), ['core-status', 'core-start', 'core-stop', 'core-restart', 'core-model', 'core-effort', 'core-save', 'update-bzzy', 'modes', 'back']);
  for (const action of ['core-stop', 'core-status', 'core-start', 'core-restart']) {
    await ui.settings.run(action); assert.equal(ui.settings.warning, false, ui.settings.message);
    assert.equal(ui.settings.hostLabel(), action === 'core-stop' || action === 'core-status' ? 'Stopped' : 'Running');
  }
  assert.deepEqual(calls, ['status', 'stop', 'status', 'status', 'start', 'status', 'restart', 'status']);
  assert.equal(ui.coreLifecycleInterrupted, true);
  Object.assign(output, { rows: 24, columns: 80 }); ui.tui.render();
  const frame = ui.tui.lastFrame.map(clean).join('\n');
  for (const label of ['BZZY Core', 'Status · Running', 'Start', 'Stop', 'Restart']) assert.ok(frame.includes(label));
  ui.settings.focusAction('back'); ui.tui.settingsEnsureFocus = true; ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Back/);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(ui.tui.entries.some(entry => entry.kind === 'user'), false);
  ui.settings.back(); assert.equal(ui.settings.rows().filter(row => row.action)[ui.settings.focus].action, 'core');
});

test('failed Core controls disclose a safe error and leave status/controls usable', async () => {
  const { ui } = terminal();
  ui.settings = new ClientSettings(ui, { hostLoader: async () => ({
    coreHostStatus: async () => ({ running: false, operatorStopped: true }),
    stopCoreHost: async () => { throw new Error('fixture-private-service-detail'); },
  }) }); ui.openSettings();
  await ui.settings.run('core'); await ui.settings.run('core-stop');
  assert.equal(ui.settings.busy, false); assert.equal(ui.settings.warning, true);
  assert.match(ui.settings.message, /Core service action failed/);
  assert.doesNotMatch(ui.settings.message, /fixture-private/);
  assert.equal(ui.settings.hostLabel(), 'Stopped');
  await ui.settings.run('core-status'); assert.equal(ui.settings.warning, false);
});

test('Core controls cannot switch private host context after Settings opens', async () => {
  const { ui } = terminal(); let loaded = false;
  ui.settings = new ClientSettings(ui, { hostLoader: async () => { loaded = true; return {}; } }); ui.openSettings();
  const original = process.env.BZZY_HOME;
  try {
    process.env.BZZY_HOME = path.join(directory, 'different-private-host');
    await ui.settings.run('core');
    assert.equal(loaded, false); assert.equal(ui.settings.warning, true);
    assert.match(ui.settings.message, /private Core host changed/);
    assert.equal(ui.coreLifecycleInterrupted, undefined);
  } finally { process.env.BZZY_HOME = original; }
});

test('Pair iPhone uses maximum access without pickers and its secondary screen returns to the compact menu', async () => {
  const { ui } = terminal(), fixture = pairingFixture();
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module }); ui.openSettings();
  ui.sessionMode = 'VIEW';
  ui.chooseOne = async () => assert.fail('Host pairing must not ask a scope or permissions question.');
  await ui.settings.run('pair');
  assert.equal(ui.settings.warning, false, ui.settings.message); assert.equal(ui.settings.page, 'pair');
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0], { sessionId: ui.sessionId, permissions: fullPermissions,
    sessionAccess: true, shareAccess: true, agentAccess: true, ttlSeconds: 600, grantTtlSeconds: 86400 });
  assert.ok(ui.settings.rows().some(row => row.action === 'back')); assert.ok(ui.settings.rows().some(row => row.action === 'copy-code'));
  assert.ok(ui.settings.rows().some(row => /^BZZY-PAIR-/.test(row.text)));
  // Escape closes an optional QR and returns directly to chat.
  ui.tui.key('', { name: 'escape' });
  assert.equal(ui.settings.page, 'pair'); assert.equal(ui.tui.panel, 'chat');
  ui.tui.setPanel('settings'); await ui.settings.run('back');
  assert.equal(ui.settings.page, 'main'); assert.equal(ui.tui.panel, 'settings');
  assert.deepEqual(ui.settings.rows().filter(row => row.action).map(row => row.action), ['deepseek', 'workspace-root', 'pair', 'core']);
  assert.equal(ui.settings.rows().some(row => /^BZZY-PAIR-/.test(row.text)), false);
  await ui.settings.run('pair'); assert.equal(fixture.calls.length, 1, 'reopening Pair reuses the current temporary invitation');
  await ui.settings.run('back'); assert.equal(ui.settings.page, 'main');
  assert.equal(ui.settings.rows().filter(row => row.action)[ui.settings.focus].action, 'pair');
  assert.equal(listRecords('execution').length, 0); assert.equal(ui.tui.entries.some(entry => entry.kind === 'user'), false);
});

test('standalone Pair iPhone automatically selects the latest eligible terminal and expired codes disappear', async () => {
  const { ui } = terminal(), fixture = pairingFixture({ expiresIn: 50 }), cwd = path.join(directory, 'workspace');
  const latest = createSession(BUILTINS.codex, cwd), stamp = Date.now();
  putRecord('session', latest.id, { ...latest, updatedAt: new Date(stamp + 1000).toISOString() });
  for (const [index, details] of [{ purpose: 'agent', agentId: randomUUID() }, { purpose: 'core-assistant' }, { parentSessionId: latest.id }].entries()) {
    const excluded = createSession(BUILTINS.codex, cwd);
    putRecord('session', excluded.id, { ...excluded, ...details, updatedAt: new Date(stamp + 2000 + index).toISOString() });
  }
  const privateSession = createSession(BUILTINS.codex, home());
  putRecord('session', privateSession.id, { ...privateSession, updatedAt: new Date(stamp + 3000).toISOString() });
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module }); ui.openSettings();
  ui.sessionId = null; ui.activeTab = null;
  ui.chooseOne = async () => assert.fail('Standalone Pair must choose the eligible terminal automatically.');
  await ui.settings.run('pair');
  assert.equal(ui.settings.warning, false, ui.settings.message); assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].sessionId, latest.id);
  assert.ok(ui.settings.rows().some(row => /^BZZY-PAIR-/.test(row.text)));
  await waitFor(() => ui.settings.rows().some(row => row.action === 'new-pair'));
  assert.equal(ui.settings.rows().some(row => /^BZZY-PAIR-/.test(row.text)), false); assert.equal(ui.settings.qrLines().length, 0);
  assert.match(ui.settings.message, /expired/);
  assert.equal(listRecords('execution').length, 0);
});

test('normal-width Pair offers an image and copyable code, with O and C dispatched locally', async () => {
  const term = terminal(), { ui, output } = term, fixture = pairingFixture(), opened = [], copied = [];
  const image = new PairingQRImage({ temporaryRoot: directory, openFile: async file => opened.push(file) });
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module, qrImage: image }); ui.openSettings();
  Object.assign(output, { rows: 24, columns: 80 });
  await ui.settings.run('pair');
  const start = term.written.length; ui.tui.render();
  const frame = clean(term.written.slice(start));
  assert.match(frame, /Open QR image/); assert.match(frame, /Copy code/); assert.ok(frame.includes(ui.settings.invitationCode()));
  assert.doesNotMatch(frame, /QR needs|\d+ columns|Resize/);
  assert.equal(ui.tui.lastFrame.length, 0, 'private QR view stays out of frame/copy caches');
  let answer = ui.ask('bzzy › '); await waitFor(() => ui.tui.resolveInput);
  ui.tui.key('o', { name: 'o' }); assert.equal(await answer, '/settings open-qr');
  await ui.settings.run('open-qr'); assert.equal(opened.length, 1); assert.match(ui.settings.message, /QR image opened/);
  assert.equal(fs.statSync(opened[0]).mode & 0o777, 0o600);
  ui.clipboard = { copyText: async code => { copied.push(code); return { copied: true, method: 'native' }; } };
  answer = ui.ask('bzzy › '); await waitFor(() => ui.tui.resolveInput);
  ui.tui.key('c', { name: 'c' }); assert.equal(await answer, '/settings copy-code');
  await ui.settings.run('copy-code'); assert.deepEqual(copied, [ui.settings.invitationCode()]); assert.match(ui.settings.message, /code copied/);
  assert.equal(ui.tui.entries.some(entry => entry.kind === 'user'), false); assert.equal(listRecords('execution').length, 0);
  await ui.settings.close(); assert.equal(fs.existsSync(opened[0]), false);
});

test('a compact pairing QR renders completely inside an 80 by 24 TUI', async () => {
  const { createIdentity, renderInvitationQR } = await import('../../../BZZY-CORE/src/relay/sdk.js');
  const sender = createIdentity().certificate, fixture = pairingFixture(), Gateway = fixture.module.CoreRelayClient;
  const create = Gateway.prototype.createPairing;
  Gateway.prototype.createPairing = async function (input) {
    const invitation = await create.call(this, input);
    return { ...invitation, renderQR: options => renderInvitationQR({ relay: 'wss://190.114.255.214/v1/socket',
      code: invitation.code, sender, expiresAt: invitation.expiresAt }, options) };
  };
  const term = terminal(), { ui, output } = term;
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module }); ui.openSettings();
  Object.assign(output, { rows: 24, columns: 80 }); await ui.settings.run('pair');
  ui.pet = true;
  ui.updateSession({ id: ui.sessionId, provider: 'codex', model: 'qr-model', mode: 'delegate', executor: { provider: 'claude', model: 'qr-hands', effort: 'high' }, executionState: 'idle', usage: { tokens: 1234, available: true } });
  ui.hostMetrics = { host: { cpuPercent: 12, memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3 } } };
  assert.equal(ui.settings.qrLines().length, 18);
  const start = term.written.length; ui.tui.render(); const frame = term.written.slice(start);
  assert.match(clean(frame), /bzzy.*qr-model/); assert.match(clean(frame), /1,234 tokens.*CPU.*RAM/); assert.match(frame, /\x1b\[47m/);
  assert.ok(ui.tui.eyeRegion && ui.tui.eyeRegion.rows === 2);
  assert.match(clean(frame), /[\u2800-\u28ff]/u, 'the compact header retains the actual eyes');
  assert.doesNotMatch(clean(frame), /Open the QR image to scan|QR needs|\d+ columns/);
  assert.equal([...frame.matchAll(/\x1b\[\d+;1H/g)].length, 24);
  assert.match(clean(frame), /C Copy code/); assert.equal(ui.tui.lastFrame.length, 0);
  const rows = [...frame.matchAll(/\x1b\[(\d+);1H([^]*?)(?=\x1b\[\d+;1H|$)/g)];
  assert.equal(rows.length, 24);
  assert.ok(rows.every(row => cellWidth(row[2]) <= 79), 'the header and complete QR stay within the terminal width');
  const qr = ui.settings.qrLines();
  assert.equal(rows.slice(4, 22).length, qr.length);
  for (let index = 0; index < qr.length; index++) assert.ok(rows[index + 4][2].includes(qr[index]), 'QR module rows remain byte-for-byte unchanged');
  for (const index of [2, 3, 22, 23]) assert.match(rows[index][2], /\x1b\[47m +\x1b\[0m/, 'four module rows of white quiet zone remain above and below');
});

test('Pair resumes the pending phone and approval uses an explicit visible fingerprint confirmation', async () => {
  const { ui } = terminal(), approved = [], pending = [{ claimId: randomUUID(), deviceId: 'fixture-phone-fingerprint',
    certificate: { id: 'fixture-phone-fingerprint' }, expiresAt: Date.now() + 600000, resource: randomUUID() }];
  const fixture = pairingFixture({ pending });
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module }); ui.openSettings();
  ui.sessionId = null; ui.ask = async () => assert.fail('Do not open the old fingerprint text prompt.');
  await ui.settings.run('pair');
  assert.equal(fixture.calls.length, 0, 'Reopening Pair must not create another invitation.');
  assert.equal(ui.settings.qrView, false); assert.ok(ui.settings.rows().some(row => row.action === 'approve'));
  ui.settings.gateway.approvePairing = async input => approved.push(input);
  await ui.settings.run('approve'); ui.tui.render();
  const frame = ui.tui.lastFrame.map(clean).join('\n');
  assert.match(frame, /Confirm iPhone/); assert.match(frame, /fixture-phone-fingerprint/);
  assert.match(frame, /Fingerprints match/); assert.equal(ui.settings.page, 'approve');
  assert.equal(ui.tui.promptDraft, undefined); assert.equal(approved.length, 0);
  assert.equal(ui.settings.rows().filter(row => row.action)[ui.settings.focus].action, 'cancel-approve');
  await ui.settings.run('cancel-approve'); assert.equal(ui.settings.page, 'pair'); assert.equal(approved.length, 0);
  await ui.settings.run('approve');
  const original = pending.shift();
  await ui.settings.run('confirm-approve'); assert.equal(approved.length, 0, 'A vanished or changed request must not be approved.');
  pending.push(original); await ui.settings.run('approve'); await ui.settings.run('confirm-approve');
  assert.deepEqual(approved, [{ claimId: original.claimId, confirmedCertificate: original.certificate, confirmedFingerprint: original.deviceId }]);
  assert.equal(ui.settings.page, 'pair'); assert.match(ui.settings.message, /iPhone paired/);
});

test('QR image expiry removes the file and clipboard or image failures stay honest and private', async () => {
  const { ui } = terminal(), fixture = pairingFixture({ expiresIn: 200 }), opened = [];
  const image = new PairingQRImage({ temporaryRoot: directory, openFile: async file => opened.push(file) });
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module, qrImage: image }); ui.openSettings();
  await ui.settings.run('pair'); await ui.settings.run('open-qr');
  assert.equal(opened.length, 1); assert.ok(fs.existsSync(opened[0]));
  ui.clipboard = { copyText: async () => ({ copied: false, reason: 'fixture-private-clipboard-details' }) };
  await ui.settings.run('copy-code'); assert.equal(ui.settings.warning, true); assert.match(ui.settings.message, /Clipboard unavailable/);
  assert.doesNotMatch(ui.settings.message, /copied|fixture-private/);
  ui.clipboard.copyText = async () => ({ copied: true, method: 'osc52' });
  await ui.settings.run('copy-code'); assert.equal(ui.settings.warning, false); assert.match(ui.settings.message, /Copy request sent/);
  await waitFor(() => /expired/.test(ui.settings.message)); assert.equal(fs.existsSync(opened[0]), false);
  assert.equal(ui.settings.invitationCode(), undefined);
  await ui.settings.run('new-pair');
  image.openFile = async () => { throw new Error('fixture-private-opener-detail'); };
  await ui.settings.run('open-qr'); assert.equal(ui.settings.warning, true); assert.match(ui.settings.message, /Unable to open a QR image/);
  assert.doesNotMatch(ui.settings.message, /fixture-private-opener-detail/);
});

test('a small Pair viewport scrolls back to host identity and expiry after action focus moves down', async () => {
  const { ui, output } = terminal(), fixture = pairingFixture({ grants: Array.from({ length: 6 }, (_, index) => ({
    id: randomUUID(), deviceId: `fixture-phone-${index}`, expiresAt: Date.now() + 600000,
  })) });
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module }); ui.openSettings();
  Object.assign(output, { rows: 10, columns: 100 });
  await ui.settings.run('pair');
  await ui.settings.run('new-pair');
  ui.tui.key('', { name: 'return' });
  ui.settings.focusAction('back'); ui.settings.changed(); ui.tui.render();
  const frame = () => ui.tui.lastFrame.map(clean).join('\n');
  assert.ok(ui.tui.settingsOffset > 0); assert.match(frame(), /Back/); assert.doesNotMatch(frame(), /Host fingerprint:/);
  const fromBottom = ui.tui.settingsOffset;
  ui.tui.mouse(64, 5, 5); ui.tui.render(); assert.ok(ui.tui.settingsOffset < fromBottom);
  for (let index = 0; index < 30; index++) ui.tui.mouse(64, 5, 5);
  ui.tui.render(); assert.equal(ui.tui.settingsOffset, 0); assert.match(frame(), /Host fingerprint: fixture-public-host/); assert.match(frame(), /Code expires at/);
  ui.tui.key('', { name: 'end' }); ui.tui.render(); assert.equal(ui.tui.settingsOffset, ui.tui.settingsMaximum); assert.match(frame(), /Back/);
  ui.tui.key('', { name: 'home' }); ui.tui.render(); assert.equal(ui.tui.settingsOffset, 0); assert.match(frame(), /Host fingerprint:/);
  ui.tui.key('', { name: 'pagedown' }); ui.tui.render(); assert.ok(ui.tui.settingsOffset > 0);
  ui.tui.key('', { name: 'pageup' }); ui.tui.render(); assert.equal(ui.tui.settingsOffset, 0); assert.match(frame(), /Code expires at/);
  assert.equal(listRecords('execution').length, 0);
});

test('Unpair groups each device once and revokes every active grant belonging to the selected device', async () => {
  const { ui } = terminal(), expiry = Date.now() + 600000;
  const grants = [
    { id: randomUUID(), deviceId: 'selected-phone', sessionId: ui.sessionId, expiresAt: expiry },
    { id: randomUUID(), deviceId: 'selected-phone', sessionId: randomUUID(), expiresAt: expiry + 600000 },
    { id: randomUUID(), deviceId: 'other-phone', sessionId: ui.sessionId, expiresAt: expiry },
  ];
  const fixture = pairingFixture({ grants }), revoked = [];
  fixture.module.revokeLocalRelayGrant = id => { revoked.push(id); grants.find(grant => grant.id === id).revokedAt = new Date().toISOString(); };
  ui.settings = new ClientSettings(ui, { relayLoader: async () => fixture.module }); ui.openSettings();
  await ui.settings.run('pair');
  const actions = ui.settings.rows().filter(row => row.action?.startsWith('revoke:'));
  assert.equal(actions.length, 2); assert.ok(actions.some(row => row.action === `revoke:${grants[1].id}`));
  assert.equal(ui.settings.rows().filter(row => row.text.includes('selected-phone')).length, 1);
  ui.chooseOne = async () => 'revoke'; await ui.settings.run(`revoke:${grants[1].id}`);
  assert.equal(ui.settings.warning, false, ui.settings.message);
  assert.deepEqual(revoked.sort(), [grants[0].id, grants[1].id].sort());
  assert.equal(grants[2].revokedAt, undefined);
  assert.deepEqual(ui.settings.rows().filter(row => row.action?.startsWith('revoke:')).map(row => row.action), [`revoke:${grants[2].id}`]);
  assert.equal(listRecords('execution').length, 0);
});

test('workspace Settings saves a separate managed root and preserves external terminal cwd', async () => {
  const { ui } = terminal(); ui.openSettings();
  const before = listRecords('session').map(session => ({ id: session.id, cwd: session.cwd }));
  const selected = path.join(directory, 'BZZY managed');
  ui.ask = async () => selected;
  await ui.settings.run('workspace-root');
  assert.equal(ui.settings.warning, false, ui.settings.message);
  assert.equal(new CoreWorkspaces().settings().root.path, selected);
  assert.ok(fs.statSync(selected).isDirectory());
  assert.deepEqual(listRecords('session').map(session => ({ id: session.id, cwd: session.cwd })), before);
  assert.match(ui.settings.rows().find(row => row.action === 'workspace-root').detail, /BZZY managed/);
  assert.deepEqual(ui.settings.rows().filter(row => row.action).map(row => row.action), ['deepseek', 'workspace-root', 'pair', 'core']);
  assert.equal(listRecords('execution').length, 0);
  assert.equal(fs.lstatSync(selected).isSymbolicLink(), false);
});

test('DeepSeek edits are masked, private, cancellable and do not overwrite unrelated bindings', async () => {
  const term = terminal(), { ui } = term; ui.openSettings();
  const file = path.join(home(), 'credentials.json'); writeJson(file, { another: 'fixture-other-binding' });
  const secret = 'fixture-new-deepseek-key';
  await ui.settings.run('deepseek');
  const save = ui.settings.run('key:deepseek'); await waitFor(() => ui.tui.hidden);
  ui.tui.key(secret, {}); ui.tui.render();
  assert.doesNotMatch(term.written, new RegExp(secret));
  ui.tui.key('', { name: 'return' }); await save;
  assert.deepEqual(readJson(file), { another: 'fixture-other-binding', deepseek: secret });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify([ui.tui.entries, ui.tui.history, listRecords('event'), listRecords('outbox')]), new RegExp(secret));
  const cancel = ui.settings.run('key:deepseek'); await waitFor(() => ui.tui.hidden);
  ui.tui.key('fixture-cancelled-key', {}); ui.tui.key('', { name: 'escape' }); await cancel;
  assert.equal(readJson(file).deepseek, secret);
  const invalid = ui.settings.run('key:deepseek'); await waitFor(() => ui.tui.hidden);
  ui.tui.key('not a valid key', {}); ui.tui.key('', { name: 'return' }); await invalid;
  assert.equal(readJson(file).deepseek, secret); assert.equal(ui.settings.warning, true);
});

test('one masked key prompt replaces the environment override without exposing either key', async () => {
  const term = terminal(), { ui } = term; ui.openSettings();
  process.env.DEEPSEEK_API_KEY = 'fixture-environment-key';
  ui.chooseOne = async () => assert.fail('Replacing a key uses only the masked prompt.');
  await ui.settings.run('deepseek');
  const save = ui.settings.run('key:deepseek'); await waitFor(() => ui.tui.hidden);
  ui.tui.key('fixture-replacement-key', {}); ui.tui.key('', { name: 'return' });
  await save;
  assert.equal(Boolean(ui.tui.selection), false);
  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);
  assert.equal(readJson(path.join(home(), 'credentials.json')).deepseek, 'fixture-replacement-key');
  assert.doesNotMatch(term.written, /fixture-environment-key|fixture-replacement-key/);
});

test('unavailable pairing adapters fail visibly without fabricating a QR or starting work', async () => {
  const { ui } = terminal();
  ui.settings = new ClientSettings(ui, { relayLoader: async () => { throw new Error('fixture-private-detail'); } });
  ui.openSettings();
  await ui.settings.run('pair');
  assert.equal(ui.settings.page, 'pair');
  assert.match(ui.settings.message, /adapter unavailable/);
  assert.doesNotMatch(ui.settings.message, /fixture-private-detail/);
  assert.equal(ui.settings.rows().some(row => /^BZZY-PAIR-/.test(row.text)), false);
  assert.equal(listRecords('execution').length, 0);
});

test('a damaged credential store cannot leak private parse fragments into Settings or errors', async () => {
  const term = terminal(), { ui } = term;
  fs.writeFileSync(path.join(home(), 'credentials.json'), 'fixture-private-damaged-json', { mode: 0o600 });
  ui.openSettings(); ui.tui.render();
  assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Unavailable/i);
  assert.doesNotMatch(term.written, /fixture-private-damaged-json/);
  await ui.settings.run('deepseek'); ui.tui.render();
  assert.equal(ui.settings.page, 'keys');
  assert.doesNotMatch(term.written, /fixture-private-damaged-json/);
});

test('Settings pairs through the real Core/Relay adapter, requires phone confirmation and revokes the scoped grant', {
  skip: !fs.existsSync(new URL('../../../BZZY-CORE/src/relay/index.js', import.meta.url)),
}, async t => {
  const relayModule = await import('../../../BZZY-CORE/src/relay/index.js');
  const { RelayClient, createIdentity } = await import('../../../BZZY-CORE/src/relay/sdk.js');
  const requireCore = createRequire(new URL('../../../BZZY-CORE/package.json', import.meta.url));
  const sdk = pathToFileURL(requireCore.resolve('@bzzy/relay'));
  const { RelayStore } = await import(new URL('./store.js', sdk));
  const { startRelay } = await import(new URL('./server.js', sdk));
  const certificate = relayModule.initializeRelayIdentity(), store = new RelayStore(); store.provisionHost(certificate);
  const relay = await startRelay({ store, allowInsecureLocal: true });
  const peer = new RelayClient({ identity: createIdentity(), url: relay.audience, allowInsecureLocal: true, autoReconnect: false });
  const term = terminal(), { ui } = term;
  ui.settings = new ClientSettings(ui, { relayLoader: async () => ({ ...relayModule,
    CoreRelayClient: undefined,
    RelayGateway: class extends relayModule.RelayGateway {
      constructor() { super({ url: relay.audience, allowInsecureLocal: true, autoReconnect: false, requestTimeoutMs: 2000 }); }
    },
  }) });
  ui.openSettings();
  t.after(async () => { await ui.settings.close(); await peer.close(); await relay.close(); store.close(); });
  ui.chooseOne = async () => assert.fail('Pairing an active terminal must not ask scope or permission questions.');
  await ui.settings.run('pair');
  assert.equal(ui.settings.warning, false, ui.settings.message);
  const code = ui.settings.invitationCode();
  assert.match(code, /^BZZY-PAIR-/); assert.ok(ui.settings.qrLines().length > 20);
  assert.doesNotMatch(JSON.stringify([ui.tui.entries, listRecords('core.relay.pairing')]), new RegExp(code));
  await ui.settings.run('qr'); ui.tui.render();
  assert.match(clean(term.written), /Open QR image/); assert.doesNotMatch(clean(term.written), /QR needs/);
  Object.assign(term.output, { rows: 100, columns: 200 }); const before = term.written.length; ui.tui.render();
  assert.match(term.written.slice(before), /\x1b\[47m/);
  await peer.connect();
  const waiting = once(ui.settings.gateway, 'pairing.requested', { signal: AbortSignal.timeout(4000) });
  await peer.claim(code); await waiting;
  assert.equal(ui.settings.qrView, false); assert.equal(ui.settings.grants().length, 0);
  ui.ask = async () => assert.fail('Approval must not open a hidden fingerprint typing prompt.');
  await ui.settings.run('approve');
  assert.equal(ui.settings.page, 'approve');
  ui.tui.render(); assert.match(ui.tui.lastFrame.map(clean).join('\n'), /Confirm iPhone/);
  assert.ok(ui.tui.lastFrame.map(clean).join('\n').includes(peer.identity.certificate.id));
  assert.equal(ui.settings.rows().filter(row => row.action)[ui.settings.focus].action, 'cancel-approve');
  await ui.settings.run('cancel-approve');
  assert.equal(ui.settings.grants().length, 0);
  await ui.settings.run('approve'); await ui.settings.run('confirm-approve');
  const [grant] = ui.settings.grants();
  assert.deepEqual([...grant.permissions].sort(), ['observe', 'claim', 'takeover', 'execute', 'answer', 'pause', 'cancel', 'steer'].sort());
  assert.equal(grant.sessionAccess, true); assert.equal(grant.shareAccess, true); assert.equal(grant.agentAccess, true);
  assert.equal(grant.sessionId, ui.sessionId);
  assert.equal(ui.settings.rows().some(row => /^BZZY-PAIR-/.test(row.text)), false);
  await assert.rejects(peer.claim(code));
  ui.chooseOne = async () => 'revoke'; await ui.settings.run(`revoke:${grant.id}`);
  assert.equal(ui.settings.grants().length, 0);
  const saved = getRecord('core.relay.grant', grant.id);
  assert.ok(getRecord('access-token', digest(saved.token)).revokedAt);
  assert.equal(listRecords('execution').length, 0, 'pairing does not start a model');
  assert.ok(ui.settings.qrLines().length === 0);
});

test('the iOS palette uses exact RGB where supported and readable terminal fallbacks', () => {
  const output = { isTTY: true };
  const rgb = createTerminalTheme(output, { COLORTERM: 'truecolor' });
  assert.equal(rgb.background(palette.background), '\x1b[48;2;3;9;15m');
  assert.equal(rgb.foreground(palette.accent), '\x1b[38;2;36;223;255m');
  for (const env of [{ TERM: 'xterm-256color' }, { TERM: 'linux' }, { NO_COLOR: '1' }, { TERM: 'dumb' }]) {
    const theme = createTerminalTheme(output, env), line = theme.color('Text 世界', palette.text);
    assert.equal(clean(line), 'Text 世界'); assert.equal(cellWidth(line), 9);
    if (!theme.level) assert.equal(line, 'Text 世界');
    else assert.ok(theme.foreground(palette.text) !== theme.foreground(palette.background));
  }
});

for (const id of ['abliteration', 'orcarouter']) test(`${id} Settings key replacement uses hidden private storage`, async () => {
  const term = terminal(), { ui } = term; ui.openSettings();
  await ui.settings.run('deepseek');
  assert.equal(ui.settings.page, 'keys');
  const secret = `fixture-${id}-replacement`;
  const save = ui.settings.run(`key:${id}`); await waitFor(() => ui.tui.hidden);
  ui.tui.key(secret, {}); ui.tui.render(); assert.ok(!term.written.includes(secret));
  ui.tui.key('', { name: 'return' }); await save;
  const file = path.join(home(), 'credentials.json');
  assert.equal(readJson(file)[id], secret); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify([ui.tui.entries, ui.tui.history, listRecords('outbox')]).includes(secret));
});

test('Settings title, description and border hover as one card', () => {
  const { ui } = terminal(); ui.openSettings();
  ui.tui.theme = createTerminalTheme(ui.output, { FORCE_COLOR: '3' }); ui.tui.render();
  const card = ui.tui.hitTargets.filter(hit => hit.type === 'settings' && hit.action === 'core');
  assert.equal(card.length, 3);
  const rows = card.map(hit => hit.row);
  for (const hit of card) {
    ui.tui.mouse(32, hit.left + 2, hit.row); ui.tui.render();
    for (const row of rows) assert.ok(ui.tui.lastFrame[row - 1].includes(ui.tui.theme.background(palette.hover)), 'every part of the card shares hover feedback');
  }
});
