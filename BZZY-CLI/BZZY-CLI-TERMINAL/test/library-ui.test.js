import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { shareLibrary, importLibrary, importRelayShare, libraryCommand } from '../src/library-ui.js';
import { forgetPrivateImportInput } from '../src/share-ui.js';
import { privateChatCommand } from '../src/terminal-commands.js';
import { createSession } from '@bzzy/core/engine/store.js';
import { listRecords } from '@bzzy/core/engine/database.js';

const code = 'BZZY-LIBRARY-' + 'L'.repeat(43), terminalCode = 'BZZY-TERMINAL-' + 'T'.repeat(43);
const sender = 's'.repeat(43), recipient = 'r'.repeat(43), sourceDigest = 'e'.repeat(64);
const blockedId = 'template:' + 'a'.repeat(64);
let directory, cwd, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-ui-')));
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function mockUI({ answers = [], choices = [], secret = code } = {}) {
  const ui = { interactive: true, json: false, input: { isTTY: true }, output: { isTTY: true },
    events: [], prompts: [], frames: [], menus: [],
    ask: async question => { ui.prompts.push(question); const answer = answers.shift(); return typeof answer === 'function' ? answer() : answer; },
    secret: async question => { ui.prompts.push(question); ui.usedHiddenInput = true; return secret; },
    chooseOne: async (title, offered) => {
      const content = await offered; ui.menus.push({ title, content, privateView: ui.privateView });
      const answer = choices.shift(); return typeof answer === 'function' ? answer(title, content) : answer;
    },
    event(type, data) { ui.events.push({ type, ...data }); },
    tui: { value: 'Unsent draft', cursor: 5, schedule() { if (ui.privateView) ui.frames.push(JSON.stringify(ui.privateView)); }, notice() {} },
  };
  return ui;
}
function review() {
  return { id: 'reviewed-library', kind: 'library-export', sourceDigest, excludeGoalIds: [], excludedGoals: [], conflicts: [],
    entries: ['skill', 'agent', 'workflow', 'goal'].map(kind => ({ kind, name: 'reviewed-' + kind, scope: kind === 'agent' ? 'project' : 'global', description: 'Inspect the complete reviewed fixture.', files: [{ path: kind === 'skill' ? 'SKILL.md' : 'definition.json', bytes: 40, sha256: 'a'.repeat(64) }] })),
    totals: { skills: 1, agents: 1, workflows: 1, goals: 1, files: 4, bytes: 160 } };
}
function backend(value = review()) {
  const calls = [];
  return { calls,
    previewLibraryExport(input) { calls.push({ operation: 'preview', input }); return { ...value, excludeGoalIds: [...input.excludeGoalIds] }; },
    readDefinitionBundleFile(_review, input) { calls.push({ operation: 'read', input }); return { text: 'Complete reviewed fixture body.', sha256: 'a'.repeat(64), nextOffset: null }; },
    discardDefinitionBundleReview(item) { calls.push({ operation: 'discard', id: item.id }); },
  };
}
function sourceTransport(calls, { state = 'complete' } = {}) {
  return { CoreTerminalSharing: class {
    async start() { calls.push({ operation: 'start' }); }
    async createLibraryShare(input) { calls.push({ operation: 'create', input }); return { shareId: randomUUID(), code, senderFingerprint: sender, expiresAt: Date.now() + 60000 }; }
    async status() { return { state, pending: [] }; }
    async revokeShare() { calls.push({ operation: 'revoke' }); }
    async close() { calls.push({ operation: 'close' }); }
  } };
}
const imported = { skills: [{}], agents: [{}], workflows: [{}], goals: [{}], skipped: [{ kind: 'skill', name: 'kept-local' }] };

test('source code creation requires concrete four-kind review and forwards exact digest and explicit exclusions', async () => {
  const ui = mockUI({ choices: ['share'] }), value = review(), transport = [], bundle = backend(value);
  value.excludeGoalIds = [blockedId];
  bundle.previewLibraryExport = input => { bundle.calls.push({ operation: 'preview', input }); return value; };
  assert.deepEqual(await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) }), { state: 'complete' });
  assert.equal(ui.menus[0].title, 'Share BZZY Library');
  assert.equal(ui.menus[0].content.choices[0].value, 'back'); assert.equal(ui.menus[0].content.choices[0].selected, true);
  for (const kind of ['skills', 'agents', 'workflows', 'goals']) assert.ok(ui.menus[0].content.description.includes(`1 ${kind}`));
  assert.deepEqual(transport.find(call => call.operation === 'create').input, { cwd, expectedDigest: sourceDigest, excludeGoalIds: [blockedId], ttlSeconds: 600 });
  assert.equal(bundle.calls.at(-1).operation, 'discard');
  assert.equal(ui.privateView, undefined); assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.events.length, 0);
});

test('Back and inspection navigate exact package text without loading or creating a Relay transfer', async () => {
  const ui = mockUI({ choices: ['entry:0', 'back', 'back'] }), bundle = backend(); let loads = 0;
  assert.equal(await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => { loads++; } }), null);
  assert.equal(loads, 0); assert.equal(bundle.calls.filter(call => call.operation === 'read').length, 1);
  assert.equal(bundle.calls.find(call => call.operation === 'read').input.file, 'SKILL.md');
  assert.ok(ui.menus[1].content.description.includes('Complete reviewed fixture body.'));
  assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 5);
});

test('blocked private goals are omitted only by explicit owner choice and remaining four-kind bundle is reviewed again', async () => {
  const bundle = backend(), transport = [], excluded = [];
  bundle.previewLibraryExport = input => {
    excluded.push(input.excludeGoalIds);
    if (!input.excludeGoalIds.length) throw Object.assign(new Error('One saved goal cannot be shared.'), { code: 'LIBRARY_BLOCKED_GOALS', blockedGoals: [{ id: blockedId, reason: 'Private host paths.' }] });
    return { ...review(), excludeGoalIds: input.excludeGoalIds, excludedGoals: [{ id: blockedId, reason: 'Private host paths.' }] };
  };
  const cancelled = mockUI({ choices: ['back'] });
  assert.equal(await shareLibrary(cwd, cancelled, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) }), null);
  assert.equal(transport.length, 0);
  const ui = mockUI({ choices: ['omit', 'share'] });
  await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) });
  assert.deepEqual(excluded, [[], [], [blockedId]]);
  assert.equal(ui.menus[0].title, 'Some saved goals cannot be shared'); assert.equal(ui.menus[1].title, 'Share BZZY Library');
  assert.match(ui.menus[1].content.description, /1 blocked goals explicitly omitted/);
  assert.deepEqual(transport.find(call => call.operation === 'create').input.excludeGoalIds, [blockedId]);
});

test('host or visible terminal change during source preflight prevents transport creation', async () => {
  const ui = mockUI({ choices: ['share'] }), bundle = backend(); let creates = 0;
  await assert.rejects(shareLibrary(cwd, ui, { loadBundle: async () => { ui.sessionId = randomUUID(); return bundle; }, relayLoader: async () => { creates++; } }), /host or terminal changed/);
  assert.equal(bundle.calls.length, 0); assert.equal(creates, 0);
});

test('receiving releases private transport keyboard ownership for concrete review and preserves enable decision/counts', async () => {
  for (const choice of ['enable', 'install']) {
    const previous = { title: 'Previous private screen' }, ui = mockUI({ answers: [sender], choices: [choice] }), bundle = backend();
    ui.privateView = previous; let decision;
    const result = await importLibrary(code, cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => ({
      importLibraryShare: async request => {
        assert.equal(request.code, code); assert.equal(request.expectedSenderFingerprint, sender); assert.equal(request.cwd, cwd);
        request.onIdentity({ recipientFingerprint: recipient }); request.onProgress({ received: 10, total: 10 });
        decision = await request.onReview({ ...review(), kind: 'library-import', conflicts: [{ kind: 'skill', name: 'reviewed-skill', scope: 'global' }] });
        assert.notEqual(ui.privateView, previous, 'transport screen resumes only after its review dialog closes');
        return imported;
      },
    }) });
    assert.deepEqual(decision, { approved: true, enable: choice === 'enable' });
    assert.match(ui.menus[0].content.description, /3 missing entries/);
    assert.match(ui.menus[0].content.choices.find(row => row.value === 'entry:0').label, /^Already here · skip/);
    assert.match(ui.menus[0].content.choices.find(row => row.value === 'entry:1').label, /^New/);
    assert.equal(ui.menus[0].privateView, previous, 'the private transport screen must release keyboard/mouse ownership during review');
    assert.deepEqual(result, imported); assert.equal(ui.privateView, previous);
    assert.match(ui.events[0].message, /1 skills.*1 agents.*1 workflows.*1 goals.*Skipped 1 existing.*No execution started/);
    assert.ok(!JSON.stringify(ui.events).includes(code)); assert.ok(ui.frames.some(frame => frame.includes(recipient)));
    assert.equal(listRecords('execution').length, 0);
  }
});

test('context changes during receiver review cannot approve installation', async () => {
  const ui = mockUI({ answers: [sender], choices: [() => { ui.nextSession = { id: randomUUID() }; return 'enable'; }] }); let committed = false;
  await assert.rejects(importLibrary(code, cwd, ui, { loadBundle: async () => backend(), relayLoader: async () => ({
    importLibraryShare: async request => { await request.onReview(review()); committed = true; return imported; },
  }) }), /host or terminal changed/);
  assert.equal(committed, false); assert.equal(ui.privateView, undefined); assert.equal(ui.events.length, 0);
});

test('import codes are hidden, unsupported purposes never load transport, redirects reject early and errors cannot print private code', async () => {
  let loads = 0;
  for (const flags of [{ interactive: false }, { json: true }, { output: { isTTY: false } }, { input: { isTTY: false } }]) {
    await assert.rejects(importLibrary(code, cwd, { ...mockUI(), ...flags }, { relayLoader: async () => { loads++; } }), /private interactive terminal/);
  }
  const wrong = 'BZZY-AGENT-' + 'a'.repeat(43);
  await assert.rejects(importLibrary(wrong, cwd, mockUI(), { relayLoader: async () => { loads++; } }), error => !error.message.includes(wrong));
  assert.equal(loads, 0);
  const ui = mockUI({ answers: [sender] });
  await assert.rejects(importLibrary('', cwd, ui, { loadBundle: async () => backend(), relayLoader: async () => ({ importLibraryShare: async () => { throw new Error('Private transport error ' + code); } }) }), error => !error.message.includes(code));
  assert.equal(ui.usedHiddenInput, true); assert.equal(ui.privateView, undefined);
  assert.ok(!JSON.stringify(ui.events).includes(code));
});

test('cancelled source and recipient clear private views, revoke unused codes and start no execution', async () => {
  const transport = [], ui = mockUI({ answers: [null], choices: ['share'] });
  await shareLibrary(cwd, ui, { loadBundle: async () => backend(), relayLoader: async () => sourceTransport(transport, { state: 'open' }) });
  assert.ok(transport.some(call => call.operation === 'revoke')); assert.equal(transport.at(-1).operation, 'close'); assert.equal(ui.privateView, undefined);
  const incoming = mockUI({ answers: [sender], choices: ['back'] });
  assert.equal(await importLibrary(code, cwd, incoming, { loadBundle: async () => backend(), relayLoader: async () => ({ importLibraryShare: async request => {
    const decision = await request.onReview(review()); assert.equal(decision, null);
    throw Object.assign(new Error('Cancelled by owner'), { code: 'CANCELLED' });
  } }) }), null);
  assert.equal(incoming.privateView, undefined); assert.equal(incoming.events.length, 0); assert.equal(listRecords('execution').length, 0);
});

test('generic /import routes Library codes and Library QR through the matching importer while retaining Terminal purpose', async () => {
  const seen = [], relay = { classifyProjectShareCode(value) { seen.push({ kind: 'classify', value }); return 'LIBRARY'; },
    async importLibraryShare(request) { seen.push({ kind: 'library', value: request.code }); assert.deepEqual(await request.onReview(review()), { approved: true, enable: false }); return imported; },
    async importTerminalShare(request) { seen.push({ kind: 'terminal', value: request.code }); return { sessions: [] }; },
  };
  const options = { loadBundle: async () => backend(), relayLoader: async () => relay };
  await importRelayShare(code, cwd, mockUI({ answers: [sender], choices: ['install'] }), options);
  const qr = 'BZZY:INVITE:1:opaque-fixture';
  await importRelayShare(qr, cwd, mockUI({ answers: [sender], choices: ['install'] }), options);
  await importRelayShare(terminalCode, cwd, mockUI({ answers: [sender, 'IMPORT'] }), options);
  assert.deepEqual(seen.map(item => item.kind), ['library', 'classify', 'library', 'terminal']);
  assert.equal(seen[0].value, code); assert.equal(seen[2].value, qr); assert.equal(seen[3].value, terminalCode);
});

test('actual terminal review accepts arrows/Enter after private transport releases ownership and retains the unsent draft', async () => {
  const session = createSession({ id: 'codex', backend: 'codex' }, cwd, 'offline-fixture');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 36, columns: 110 }); output.on('data', () => {});
  const ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id);
  Object.assign(ui.tui, { value: 'Unsent draft', cursor: 5 }); let decision;
  const until = async check => { for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Expected interactive review state did not appear'); };
  let task;
  try {
    task = importLibrary(code, cwd, ui, { loadBundle: async () => backend(), relayLoader: async () => ({ importLibraryShare: async request => {
      request.onIdentity({ recipientFingerprint: recipient }); decision = await request.onReview(review()); return imported;
    } }) });
    await until(() => ui.tui.resolveInput && /Sender fingerprint/.test(ui.tui.question)); input.write(sender + '\r');
    await until(() => ui.tui.selection?.title === 'Install missing Library entries' && !ui.tui.selection.loading);
    assert.equal(ui.privateView, undefined); ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
    assert.deepEqual(await task, imported); assert.deepEqual(decision, { approved: true, enable: true });
    assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 5); assert.equal(ui.privateView, undefined);
    assert.equal(listRecords('execution').length, 0);
    assert.equal(privateChatCommand('/library import ' + code), true);
    const answer = ui.ask('bzzy › '); await Promise.resolve();
    Object.assign(ui.tui, { value: '/library import ' + code, cursor: 16 + code.length }); ui.tui.submitMessage();
    assert.equal(await answer, '/library import ' + code); assert.equal(ui.tui.history.length, 0);
    ui.tui.drafts.set(session.id, { value: '/library import ' + code, cursor: 10 }); forgetPrivateImportInput(ui, '/library import ' + code);
    assert.equal(ui.tui.drafts.get(session.id).value, ''); assert.ok(!JSON.stringify(ui.tui.entries).includes(code));
  } finally { ui.reader?.close(); ui.tui.finishSelection(null); await task?.catch(() => {}); ui.close(); input.destroy(); output.destroy(); }
});

test('library menu Back returns without starting inference, transport or package operations', async () => {
  const ui = mockUI({ choices: ['back'] }); let loads = 0;
  await libraryCommand('', cwd, ui, { loadBundle: async () => { loads++; } });
  assert.equal(loads, 0); assert.equal(ui.events.length, 0); assert.equal(listRecords('execution').length, 0);
});

test('a long sub-16KiB resource is fully reachable through review line pages at normal and narrow terminal sizes', async () => {
  const text = Array.from({ length: 45 }, (_, index) => `LINE_${String(index + 1).padStart(3, '0')} ${'Complete fixture detail. '.repeat(4)}`).join('\n') + '\nFINAL_LINE';
  assert.ok(Buffer.byteLength(text) < 16384);
  for (const [columns, rows] of [[100, 30], [50, 20]]) {
    const ui = mockUI(), bundle = backend(), visible = new Set(), descriptions = [];
    Object.assign(ui.output, { columns, rows });
    let menuCount = 0, inspections = 0, traversedBack = false, sawFinal = false, loads = 0;
    bundle.readDefinitionBundleFile = (_review, input) => {
      bundle.calls.push({ operation: 'read', input });
      return { text, sha256: 'a'.repeat(64), nextOffset: null };
    };
    ui.chooseOne = async (title, offered) => {
      if (title === 'Share BZZY Library') return menuCount++ === 0 ? 'entry:0' : 'back';
      assert.match(title, /^Skill ·/); inspections++;
      descriptions.push(offered.description);
      const body = offered.description.split('\n').slice(3);
      assert.ok(body.length <= 6, 'a review screen must expose a bounded visible line slice');
      for (const match of body.join('\n').matchAll(/LINE_(\d{3})/g)) visible.add(Number(match[1]));
      if (inspections === 1) {
        assert.match(offered.description, /LINE_001/);
        assert.ok(!offered.description.includes('FINAL_LINE'), 'the unread tail must have reachable navigation rather than being clipped in one description');
      }
      if (offered.description.includes('FINAL_LINE')) {
        sawFinal = true;
        if (!traversedBack) { traversedBack = true; assert.ok(offered.choices.some(choice => choice.value === 'previous-screen')); return 'previous-screen'; }
        return 'back';
      }
      assert.ok(offered.choices.some(choice => choice.value === 'next-screen'), 'more text below 16KiB still needs a next-lines control');
      assert.ok(!offered.choices.some(choice => choice.value === 'next-page'), 'the backend correctly has only one byte chunk');
      return 'next-screen';
    };
    assert.equal(await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => { loads++; } }), null);
    assert.equal(sawFinal, true); assert.equal(traversedBack, true); assert.ok(inspections > 8);
    assert.deepEqual([...visible].sort((a, b) => a - b), Array.from({ length: 45 }, (_, index) => index + 1));
    assert.ok(bundle.calls.filter(call => call.operation === 'read').every(call => call.input.offset === 0));
    assert.equal(loads, 0); assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 5);
    assert.equal(ui.events.length, 0); assert.equal(listRecords('execution').length, 0);
  }
});
