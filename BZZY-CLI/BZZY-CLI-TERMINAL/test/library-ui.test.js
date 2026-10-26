import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { shareLibrary, importLibrary, importRelayShare, libraryCommand, transferLibraryTab } from '../src/library-ui.js';
import { forgetPrivateImportInput } from '../src/share-ui.js';
import { privateChatCommand } from '../src/terminal-commands.js';
import { createSession } from '@bzzy/core/engine/store.js';
import { listRecords } from '@bzzy/core/engine/database.js';
import * as libraryBackend from '@bzzy/core/engine/definition-bundle.js';
import { createSkill, setSkillEnabled } from '@bzzy/core/engine/skills.js';

const code = 'BZZY-LIBRARY-' + 'L'.repeat(43), terminalCode = 'BZZY-TERMINAL-' + 'T'.repeat(43);
const sender = 's'.repeat(43), recipient = 'r'.repeat(43), sourceDigest = 'e'.repeat(64);
const blockedId = 'template:' + 'a'.repeat(64);
const allKinds = ['agent', 'goal', 'skill', 'workflow'];
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
function mockUI({ answers = [], choices = [], typeChoices = [], secret = code } = {}) {
  const ui = { interactive: true, json: false, input: { isTTY: true }, output: { isTTY: true },
    events: [], prompts: [], frames: [], menus: [], typeMenus: [],
    ask: async question => { ui.prompts.push(question); const answer = answers.shift(); return typeof answer === 'function' ? answer() : answer; },
    secret: async question => { ui.prompts.push(question); ui.usedHiddenInput = true; return secret; },
    chooseOne: async (title, offered) => {
      const content = await offered; ui.menus.push({ title, content, privateView: ui.privateView });
      const answer = choices.shift(); return typeof answer === 'function' ? answer(title, content) : answer;
    },
    chooseMany: async (title, choices, options) => {
      ui.typeMenus.push({ title, choices, options });
      const answer = typeChoices.length ? typeChoices.shift() : choices.filter(choice => choice.selected).map(choice => choice.value);
      return typeof answer === 'function' ? answer(title, choices, options) : answer;
    },
    event(type, data) { ui.events.push({ type, ...data }); },
    tui: { value: 'Unsent draft', cursor: 5, schedule() { if (ui.privateView) ui.frames.push(JSON.stringify(ui.privateView)); }, notice() {} },
  };
  return ui;
}
function review() {
  return { id: 'reviewed-library', kind: 'library-export', sourceDigest, kinds: [...allKinds], excludeEntries: [], excludedEntries: [], excludeGoalIds: [], excludedGoals: [], conflicts: [],
    entries: ['skill', 'agent', 'workflow', 'goal'].map(kind => ({ kind, name: 'reviewed-' + kind, scope: kind === 'agent' ? 'project' : 'global', description: 'Inspect the complete reviewed fixture.', files: [{ path: kind === 'skill' ? 'SKILL.md' : 'definition.json', bytes: 40, sha256: 'a'.repeat(64) }] })),
    totals: { skills: 1, agents: 1, workflows: 1, goals: 1, files: 4, bytes: 160 } };
}
function selectedReview(input, value = review()) {
  const kinds = [...input.kinds].sort(), entries = value.entries.filter(entry => kinds.includes(entry.kind)
    && !input.excludeEntries.some(pin => pin.kind === entry.kind && pin.scope === entry.scope && pin.name === entry.name));
  return { ...value, kinds, entries, excludeEntries: [...input.excludeEntries], excludeGoalIds: [...input.excludeGoalIds],
    totals: { ...Object.fromEntries(['skill', 'agent', 'workflow', 'goal'].map(kind => [kind + 's', entries.filter(entry => entry.kind === kind).length])), files: entries.length, bytes: entries.length * 40 } };
}
function backend(value = review()) {
  const calls = [];
  return { calls,
    previewLibraryExport(input) { calls.push({ operation: 'preview', input }); return selectedReview(input, value); },
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

test('tab export checks names only and generates a Relay code for exactly the selected packages', async () => {
  const definition = name => ({ name, description: 'Detailed fixture description.', instructions: 'Detailed fixture instructions.' });
  createSkill(definition('first-checks'), { scope: 'global' }); createSkill(definition('second-checks'), { scope: 'global' });
  const transport = [], ui = mockUI({ typeChoices: [(_title, choices) => [choices.find(row => row.label === 'second-checks').value]] });
  await transferLibraryTab('export', 'skill', cwd, ui, { loadBundle: async () => libraryBackend, relayLoader: async () => sourceTransport(transport) });
  assert.equal(ui.typeMenus.length, 1); assert.equal(ui.menus.length, 0);
  assert.deepEqual(ui.typeMenus[0].choices.map(row => row.label), ['first-checks', 'second-checks']);
  assert.equal(ui.typeMenus[0].options.columnHeader, 'NAME'); assert.equal(ui.typeMenus[0].options.confirmLabel, 'Export');
  assert.ok(!JSON.stringify(ui.typeMenus).includes('Detailed fixture'));
  const request = transport.find(call => call.operation === 'create').input;
  assert.deepEqual(request.kinds, ['skill']); assert.equal(request.expectedDigest.length, 64);
  assert.deepEqual(request.excludeEntries.map(row => row.name), ['first-checks']);
  assert.ok(ui.frames.some(frame => frame.includes('Export skills')));
  assert.equal(ui.privateView, undefined); assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.events.length, 0);
  assert.equal(listRecords('execution').length, 0);
});

test('cancelled name selection or stale selected revision cannot create a Relay invitation', async () => {
  const source = createSkill({ name: 'chosen-checks', description: 'Inspect supplied controls.', instructions: 'Inspect offline controls.' }, { scope: 'global' });
  let loads = 0;
  for (const selected of [null, []]) {
    assert.equal(await transferLibraryTab('export', 'skill', cwd, mockUI({ typeChoices: [selected] }), { loadBundle: async () => libraryBackend, relayLoader: async () => { loads++; } }), null);
  }
  const ui = mockUI({ typeChoices: [(_title, choices) => { setSkillEnabled(source.id, true, source.revision); return choices.map(row => row.value); }] });
  await assert.rejects(transferLibraryTab('export', 'skill', cwd, ui, { loadBundle: async () => libraryBackend, relayLoader: async () => { loads++; } }), { code: 'STALE_REVIEW' });
  assert.equal(loads, 0); assert.equal(listRecords('execution').length, 0);
});

test('tab import offers only missing names of its type and commits the checked immutable review indexes', async () => {
  const value = review();
  value.entries.push({ ...value.entries[0], name: 'other-skill', description: 'Do not display full definition.' });
  value.conflicts = [{ ...value.entries[0] }];
  const ui = mockUI({ answers: [sender] }); let decision;
  const result = await transferLibraryTab('import', 'skill', cwd, ui, { loadBundle: async () => libraryBackend,
    relayLoader: async () => ({ importLibraryShare: async request => { request.onIdentity({ recipientFingerprint: recipient }); decision = await request.onReview(value); return { skills: [{}], skipped: [] }; } }) });
  assert.deepEqual(decision, { approved: true, enable: true, entryIndexes: [4] });
  assert.deepEqual(ui.typeMenus[0].choices.map(row => row.label), ['other-skill']);
  assert.equal(ui.typeMenus[0].options.confirmLabel, 'Import'); assert.equal(ui.menus.length, 0);
  assert.ok(!JSON.stringify(ui.typeMenus).includes('Do not display')); assert.equal(ui.usedHiddenInput, true);
  assert.equal(result.skills.length, 1); assert.equal(ui.privateView, undefined); assert.equal(ui.tui.value, 'Unsent draft');
});

test('tab import distinguishes duplicate scoped names and rejects codes for another tab', async () => {
  const value = review(); value.entries.push({ ...value.entries[1], scope: 'global' });
  const ui = mockUI({ answers: [sender], typeChoices: [(_title, choices) => [choices.find(row => row.label.endsWith('(Core)')).value]] });
  let decision;
  await transferLibraryTab('import', 'agent', cwd, ui, { loadBundle: async () => libraryBackend, relayLoader: async () => ({ importLibraryShare: async request => {
    decision = await request.onReview(value); return { agents: [{}], skipped: [] };
  } }) });
  assert.deepEqual(ui.typeMenus[0].choices.map(row => row.label), ['reviewed-agent (project)', 'reviewed-agent (Core)']);
  assert.deepEqual(decision.entryIndexes, [4]);
  await assert.rejects(transferLibraryTab('import', 'agent', cwd, mockUI({ answers: [sender] }), { loadBundle: async () => libraryBackend,
    relayLoader: async () => ({ importLibraryShare: async request => request.onReview({ ...value, entries: value.entries.filter(row => row.kind === 'skill') }) }) }), /no entries for the selected tab/);
  assert.equal(listRecords('execution').length, 0);
});

test('tab import cancels unchecked names and treats already installed entries as skips', async () => {
  for (const existing of [false, true]) {
    const value = review(); if (existing) value.conflicts = [value.entries[0]];
    const ui = mockUI({ answers: [sender], typeChoices: [null] }); let decision;
    const result = await transferLibraryTab('import', 'skill', cwd, ui, { loadBundle: async () => libraryBackend,
      relayLoader: async () => ({ importLibraryShare: async request => {
        decision = await request.onReview(value);
        if (!decision) throw Object.assign(new Error('Owner cancelled'), { code: 'CANCELLED' });
        return { skills: [], skipped: [{ kind: 'skill', name: 'reviewed-skill' }] };
      } }) });
    if (existing) {
      assert.deepEqual(decision, { approved: true, enable: true, entryIndexes: [0] }); assert.equal(ui.typeMenus.length, 0);
      assert.equal(result.skipped.length, 1);
    } else { assert.equal(decision, null); assert.equal(result, null); }
    assert.equal(ui.privateView, undefined); assert.equal(ui.tui.value, 'Unsent draft');
  }
});

test('source code creation requires concrete four-kind review and forwards exact digest and explicit exclusions', async () => {
  const ui = mockUI({ choices: ['share'] }), value = review(), transport = [], bundle = backend(value);
  value.excludeGoalIds = [blockedId];
  bundle.previewLibraryExport = input => { bundle.calls.push({ operation: 'preview', input }); return value; };
  assert.deepEqual(await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) }), { state: 'complete' });
  assert.equal(ui.menus[0].title, 'Share BZZY Library');
  assert.equal(ui.typeMenus.length, 1); assert.ok(ui.typeMenus[0].choices.every(choice => choice.selected));
  assert.equal(ui.menus[0].content.choices[0].value, 'back'); assert.equal(ui.menus[0].content.choices[0].selected, true);
  for (const kind of ['skills', 'agents', 'workflows', 'goals']) assert.ok(ui.menus[0].content.description.includes(`1 ${kind}`));
  assert.deepEqual(transport.find(call => call.operation === 'create').input, { cwd, expectedDigest: sourceDigest, kinds: allKinds, excludeGoalIds: [blockedId], ttlSeconds: 600 });
  assert.equal(bundle.calls.at(-1).operation, 'discard');
  assert.equal(ui.privateView, undefined); assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.events.length, 0);
});

test('selecting agents and skills limits the reviewed files and Relay source request to those types', async () => {
  const ui = mockUI({ typeChoices: [['skill', 'agent']], choices: ['entry:0', 'back', 'entry:1', 'back', 'share'] });
  const bundle = backend(), transport = [];
  await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) });
  assert.deepEqual(bundle.calls.find(call => call.operation === 'preview').input, { cwd, kinds: ['agent', 'skill'], excludeEntries: [], excludeGoalIds: [] });
  assert.deepEqual(transport.find(call => call.operation === 'create').input, { cwd, expectedDigest: sourceDigest, kinds: ['agent', 'skill'], ttlSeconds: 600 });
  const menus = ui.menus.filter(menu => menu.title === 'Share BZZY Library');
  assert.ok(menus.every(menu => menu.content.description.includes('0 workflows · 0 goals')));
  assert.deepEqual(menus[0].content.choices.filter(row => row.value.startsWith('entry:')).map(row => row.label), [
    'Skill · reviewed-skill · global', 'Specialist agent · reviewed-agent · project',
  ]);
  assert.deepEqual(bundle.calls.filter(call => call.operation === 'read').map(call => call.input.entryIndex), [0, 1]);
  assert.ok(!JSON.stringify(ui.menus).includes('reviewed-workflow')); assert.ok(!JSON.stringify(ui.menus).includes('reviewed-goal'));
  assert.equal(listRecords('execution').length, 0);
});

test('share agents skills shortcut skips the type picker and passes only the canonical requested types', async () => {
  const ui = mockUI({ choices: ['share'] }), bundle = backend(), transport = [];
  await libraryCommand('share agents skills', cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) });
  assert.equal(ui.typeMenus.length, 0);
  assert.deepEqual(bundle.calls[0].input.kinds, ['agent', 'skill']);
  assert.deepEqual(transport.find(call => call.operation === 'create').input, { cwd, expectedDigest: sourceDigest, kinds: ['agent', 'skill'], ttlSeconds: 600 });
});

test('cancelled or empty type selection touches neither Library packages nor Relay', async () => {
  for (const selected of [null, []]) {
    const ui = mockUI({ typeChoices: [selected] }); let packageLoads = 0, transportLoads = 0;
    assert.equal(await shareLibrary(cwd, ui, { loadBundle: async () => { packageLoads++; }, relayLoader: async () => { transportLoads++; } }), null);
    assert.equal(packageLoads, 0); assert.equal(transportLoads, 0); assert.equal(ui.menus.length, 0);
    assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.events.length, 0);
  }
  const ui = mockUI(); let loads = 0;
  await assert.rejects(libraryCommand('share anything', cwd, ui, { loadBundle: async () => { loads++; } }), /Choose at least one/);
  await assert.rejects(shareLibrary(cwd, ui, { kinds: [], loadBundle: async () => { loads++; } }), /Choose at least one/);
  assert.equal(loads, 0); assert.equal(listRecords('execution').length, 0);
});

test('changing terminal while the type picker is open rejects before preview or Relay creation', async () => {
  let resolveTypes, packageLoads = 0, transportLoads = 0;
  const ui = mockUI({ typeChoices: [() => new Promise(resolve => { resolveTypes = resolve; })] });
  const task = shareLibrary(cwd, ui, { loadBundle: async () => { packageLoads++; }, relayLoader: async () => { transportLoads++; } });
  assert.equal(typeof resolveTypes, 'function'); ui.nextSession = { id: randomUUID() }; resolveTypes(['skill', 'agent']);
  await assert.rejects(task, /host or terminal changed/);
  assert.equal(packageLoads, 0); assert.equal(transportLoads, 0); assert.equal(ui.menus.length, 0);
});

test('blocked skill diagnostics offer explicit omission, redact matched values, and forward only exact version pins', async () => {
  const pin = { kind: 'skill', scope: 'global', name: 'reviewed-skill', id: 'skill:reviewed-skill', revision: 2, version: 'b'.repeat(64) };
  const matchedValue = 'private-fixture-binding@example.invalid';
  const diagnostic = { ...pin, reasonCode: 'FIXED_ACCOUNT_BINDING', reason: 'Fixed account binding must be replaced with a recipient-owned account.', file: 'scripts/check.py', line: 27,
    matchedValue };
  const transport = [], bundle = backend();
  bundle.previewLibraryExport = input => {
    bundle.calls.push({ operation: 'preview', input });
    if (!input.excludeEntries.length) throw Object.assign(new Error('A selected skill contains a fixed account binding.'), { code: 'LIBRARY_BLOCKED_ENTRIES', blockedEntries: [diagnostic] });
    assert.deepEqual(input.excludeEntries, [pin]);
    return { ...selectedReview(input), excludedEntries: [{ ...pin, reasonCode: diagnostic.reasonCode, reason: diagnostic.reason, file: diagnostic.file, line: diagnostic.line }] };
  };
  const ui = mockUI({ choices: [(_title, content) => {
    assert.equal(transport.length, 0); assert.equal(bundle.calls.length, 1);
    const row = content.choices.find(choice => choice.value === 'blocked:0');
    assert.match(row.description, /scripts\/check\.py:27/); assert.ok(row.description.includes(diagnostic.reason));
    assert.match(row.label, /reviewed-skill · global/); assert.ok(!JSON.stringify(content).includes(matchedValue));
    assert.equal(content.choices[0].value, 'back'); assert.equal(content.choices[0].selected, true);
    return 'omit';
  }, (_title, content) => {
    assert.equal(transport.length, 0, 'no code or archive is created before the remaining Library is reviewed');
    assert.match(content.description, /1 blocked entries explicitly omitted/); assert.ok(!JSON.stringify(content).includes('reviewed-skill'));
    return 'share';
  }] });
  await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => sourceTransport(transport) });
  assert.deepEqual(bundle.calls.filter(call => call.operation === 'preview').map(call => call.input.excludeEntries), [[], [pin]]);
  assert.deepEqual(transport.find(call => call.operation === 'create').input, { cwd, expectedDigest: sourceDigest, kinds: allKinds, excludeEntries: [pin], ttlSeconds: 600 });
  assert.ok(!JSON.stringify({ menus: ui.menus, events: ui.events, transport }).includes(matchedValue));
  assert.equal(bundle.calls.at(-1).operation, 'discard'); assert.equal(listRecords('execution').length, 0);
});

test('Back from blocked package diagnostics preserves Library state and creates no source archive or Relay code', async () => {
  const pin = { kind: 'skill', scope: 'global', name: 'reviewed-skill', id: 'skill:reviewed-skill', revision: 2, version: 'b'.repeat(64) };
  const bundle = backend(), ui = mockUI({ choices: ['back'] }); let transportLoads = 0;
  bundle.previewLibraryExport = input => {
    bundle.calls.push({ operation: 'preview', input });
    throw Object.assign(new Error('Cannot share selected package.'), { code: 'LIBRARY_BLOCKED_ENTRIES', blockedEntries: [{ ...pin, reason: 'Fixed account binding.', reasonCode: 'FIXED_ACCOUNT_BINDING', file: 'SKILL.md', line: 10 }] });
  };
  assert.equal(await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => { transportLoads++; } }), null);
  assert.equal(transportLoads, 0); assert.equal(bundle.calls.length, 1);
  assert.deepEqual(bundle.calls[0].input.excludeEntries, []); assert.equal(ui.menus.length, 1);
  assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.events.length, 0); assert.equal(listRecords('execution').length, 0);
});

test('every blocked package has reachable complete diagnostic pages at normal and compact terminal sizes', async () => {
  const blocked = Array.from({ length: 8 }, (_, index) => ({ kind: 'skill', scope: index % 2 ? 'project' : 'global', name: 'blocked-' + index,
    id: 'skill:blocked-' + index, revision: 1, version: 'b'.repeat(64), reasonCode: 'PRIVATE_ACCOUNT',
    reason: `Safe reason ${index}. Parameterize the reusable account configuration before sharing this package.`,
    file: `scripts/${'resource-'.repeat(6)}${index}.py`, line: index + 10 }));
  for (const [columns, rows] of [[100, 30], [50, 20]]) {
    const ui = mockUI(), bundle = backend(), seen = new Map(blocked.map(entry => [entry.name, new Map()]));
    Object.assign(ui.output, { columns, rows }); let nextEntry = 0, transportLoads = 0, pages = 0;
    bundle.previewLibraryExport = input => {
      bundle.calls.push({ operation: 'preview', input });
      throw Object.assign(new Error('Selected packages cannot be shared.'), { code: 'LIBRARY_BLOCKED_ENTRIES', blockedEntries: blocked });
    };
    ui.chooseOne = async (title, content) => {
      if (title === 'Some selected entries cannot be shared') {
        assert.equal(content.choices[0].value, 'back'); assert.equal(content.choices[0].selected, true);
        assert.equal(content.choices.filter(choice => choice.value.startsWith('blocked:')).length, blocked.length);
        for (const entry of blocked) assert.ok(content.choices.some(choice => choice.label.includes(`${entry.name} · ${entry.scope}`)
          && choice.description.includes(`${entry.file}:${entry.line}`) && choice.description.includes(entry.reason)));
        return nextEntry < blocked.length ? `blocked:${nextEntry++}` : 'back';
      }
      const match = /^Blocked · (blocked-\d+) · (\d+)\/(\d+)$/.exec(title); assert.ok(match);
      const [, name, page, total] = match; pages++;
      assert.equal(content.descriptionRows, 1); assert.ok(!content.description.includes('\n'));
      assert.ok(content.description.length <= columns - 14, 'one diagnostic page must fit the compact detail line');
      seen.get(name).set(Number(page), content.description);
      assert.equal(content.choices[0].value, 'back'); assert.equal(content.choices[0].selected, true);
      if (Number(page) > 1) assert.ok(content.choices.some(choice => choice.value === 'previous'));
      if (Number(page) < Number(total)) { assert.ok(content.choices.some(choice => choice.value === 'next')); return 'next'; }
      return 'back';
    };
    assert.equal(await shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => { transportLoads++; } }), null);
    for (const entry of blocked) assert.equal([...seen.get(entry.name).entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join(''), `${entry.file}:${entry.line}${entry.reason}`);
    assert.ok(pages > blocked.length * 2); assert.equal(transportLoads, 0); assert.equal(bundle.calls.length, 1);
  }
});

test('a Core that does not confirm selected types cannot create a share code', async () => {
  for (const echoedKinds of [undefined, allKinds]) {
    const ui = mockUI({ typeChoices: [['skill', 'agent']], choices: ['share'] }), bundle = backend(); let transportLoads = 0;
    bundle.previewLibraryExport = () => ({ ...review(), kinds: echoedKinds });
    await assert.rejects(shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => { transportLoads++; } }), /Update BZZY Core and CLI together/);
    assert.equal(transportLoads, 0); assert.equal(ui.menus.length, 0); assert.equal(bundle.calls.at(-1).operation, 'discard');
  }
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

test('actual terminal type checkboxes use Space and Enter to review only agents and skills', async () => {
  const session = createSession({ id: 'codex', backend: 'codex' }, cwd, 'offline-checkbox-fixture');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 36, columns: 110 }); output.on('data', () => {});
  const ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id);
  Object.assign(ui.tui, { value: 'Unsent draft', cursor: 5 }); const bundle = backend(); let transportLoads = 0, task;
  const until = async check => { for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Expected interactive type selection did not appear'); };
  try {
    task = shareLibrary(cwd, ui, { loadBundle: async () => bundle, relayLoader: async () => { transportLoads++; } });
    await until(() => ui.tui.selection?.scope === 'library-types');
    const rendered = ui.tui.content(100).join('\n');
    assert.match(rendered, /Space toggles.*Enter reviews.*Esc goes back/);
    assert.match(rendered, /Only the selected Library types enter the review and expiring Relay code\./);
    assert.ok(!rendered.includes('Every participant reviews')); assert.ok(!rendered.includes('Enter starts'));
    assert.deepEqual([...ui.tui.selection.selected].sort(), allKinds); assert.equal(bundle.calls.length, 0);
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'down' }); ui.tui.key(' ', { name: 'space' });
    ui.tui.key('', { name: 'down' }); ui.tui.key(' ', { name: 'space' });
    assert.deepEqual([...ui.tui.selection.selected].sort(), ['agent', 'skill']); ui.tui.key('', { name: 'return' });
    await until(() => ui.tui.selection?.title === 'Share BZZY Library' && !ui.tui.selection.loading);
    assert.deepEqual(bundle.calls[0].input.kinds, ['agent', 'skill']);
    assert.deepEqual(ui.tui.selection.choices.filter(choice => choice.value.startsWith('entry:')).map(choice => choice.value), ['entry:0', 'entry:1']);
    assert.match(ui.tui.selection.description, /Selected types: Agents, Skills/);
    ui.tui.key('', { name: 'escape' }); assert.equal(await task, null);
    assert.equal(transportLoads, 0); assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 5);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.reader?.close(); ui.tui.finishSelection(null); await task?.catch(() => {}); ui.close(); input.destroy(); output.destroy(); }
});

test('actual tab table uses name checkboxes, an Export button, mouse input and preserves the draft', async () => {
  createSkill({ name: 'first-checks', description: 'Private detailed fixture.', instructions: 'Inspect supplied offline controls.' }, { scope: 'global' });
  createSkill({ name: 'second-checks', description: 'Private detailed fixture.', instructions: 'Inspect supplied offline controls.' }, { scope: 'global' });
  const session = createSession({ id: 'codex', backend: 'codex' }, cwd, 'offline-checkbox-fixture');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 24, columns: 80 }); output.resume();
  const ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id);
  Object.assign(ui.tui, { value: 'Unsent draft', cursor: 5 }); const transport = []; let task;
  try {
    task = transferLibraryTab('export', 'skill', cwd, ui, { loadBundle: async () => libraryBackend, relayLoader: async () => sourceTransport(transport) });
    for (let attempt = 0; !ui.tui.selection && attempt < 500; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(ui.tui.selection?.scope, 'library-export');
    const rendered = ui.tui.content(70).join('\n');
    assert.match(rendered, /NAME/); assert.match(rendered, /\[ Export \].*\[ Back \]/);
    assert.doesNotMatch(rendered, /Private detailed fixture|Every participant reviews|Confirm|Create expiring/);
    ui.tui.key(' ', { name: 'space' });
    assert.equal(ui.tui.selection.selected.size, 1);
    ui.tui.render(); const button = ui.tui.hitTargets.find(hit => hit.type === 'confirm'); assert.ok(button);
    ui.tui.mouse(0, button.left, button.row); await task;
    assert.deepEqual(transport.find(call => call.operation === 'create').input.excludeEntries.map(row => row.name), ['first-checks']);
    assert.equal(ui.tui.value, 'Unsent draft'); assert.equal(ui.tui.cursor, 5); assert.equal(listRecords('execution').length, 0);
  } finally { ui.reader?.close(); ui.tui.finishSelection(null); await task?.catch(() => {}); ui.close(); input.destroy(); output.destroy(); }
});

test('actual compact terminal can open and read every safe diagnostic line before returning without sharing', async () => {
  const session = createSession({ id: 'codex', backend: 'codex' }, cwd, 'offline-diagnostic-fixture');
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 20, columns: 50 }); output.on('data', () => {});
  const ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id);
  const bundle = backend(), reason = 'An account address is embedded. Parameterize it in the reusable text.', file = 'scripts/long-fixture-diagnostic-resource.py';
  let task, transportLoads = 0; const visible = [];
  const until = async check => { for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail('Expected compact diagnostic state did not appear'); };
  bundle.previewLibraryExport = () => { throw Object.assign(new Error('Selected skill cannot be shared.'), { code: 'LIBRARY_BLOCKED_ENTRIES', blockedEntries: [{
    kind: 'skill', scope: 'global', name: 'fixture-skill', id: 'skill:fixture-skill', revision: 1, version: 'b'.repeat(64), reason, file, line: 27,
  }] }); };
  try {
    task = shareLibrary(cwd, ui, { kinds: ['skill'], loadBundle: async () => bundle, relayLoader: async () => { transportLoads++; } });
    await until(() => ui.tui.selection?.title === 'Some selected entries cannot be shared' && !ui.tui.selection.loading);
    ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
    await until(() => ui.tui.selection?.title.startsWith('Blocked ·') && !ui.tui.selection.loading);
    while (true) {
      const picker = ui.tui.selection; ui.tui.selectionHeight = 7;
      assert.ok(ui.tui.content(48).join('\n').includes(picker.description), 'the whole diagnostic page is visible in the compact picker');
      visible.push(picker.description);
      if (!picker.choices.some(choice => choice.value === 'next')) { ui.tui.key('', { name: 'escape' }); break; }
      ui.tui.key('', { name: 'down' }); ui.tui.key('', { name: 'return' });
      await until(() => ui.tui.selection?.title.startsWith('Blocked ·') && ui.tui.selection.title !== picker.title && !ui.tui.selection.loading);
    }
    assert.equal(visible.join(''), `${file}:27${reason}`);
    await until(() => ui.tui.selection?.title === 'Some selected entries cannot be shared' && !ui.tui.selection.loading);
    ui.tui.key('', { name: 'escape' }); assert.equal(await task, null); assert.equal(transportLoads, 0);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); await task?.catch(() => {}); input.destroy(); output.destroy(); }
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
