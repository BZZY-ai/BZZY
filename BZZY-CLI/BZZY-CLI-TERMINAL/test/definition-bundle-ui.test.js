import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { subagentsCommand, subagentRows } from '../src/subagents-ui.js';
import { definitionBundleAction } from '../src/definition-bundle-ui.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { listRecords } from '../src/database.js';
import { clean } from '../src/terminal-format.js';
import { importSkill, inspectSkill, readSkill } from '@bzzy/core/engine/skills.js';
import { saveSubagentDefinition, getSubagentDefinition } from '@bzzy/core/engine/subagent-definitions.js';

let directory, project, previous, ui, input, calls, api;
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const entries = () => [
  { kind: 'skill', name: 'http-review', scope: 'project', version: 'a'.repeat(64), files: [
    { path: 'SKILL.md', bytes: 80, sha256: 'b'.repeat(64) }, { path: 'references/method.md', bytes: 20, sha256: 'c'.repeat(64) }] },
  { kind: 'agent', name: 'response-analyst', scope: 'global', version: 'd'.repeat(64), files: [{ path: 'AGENT.json', bytes: 90, sha256: 'e'.repeat(64) }] },
];
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-bundle-ui-'))); previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private'); project = path.join(directory, 'project'); fs.mkdirSync(project);
  const session = createSession(BUILTINS.codex, project, 'current-model', 'Bundle review');
  input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 100, rows: 36 }); output.resume();
  ui = new UI({ input, output, error: output, pet: false }); ui.setSession(session.id); ui.updateSession(session);
  ui.tui.value = 'Unsent chat draft'; ui.tui.cursor = 6; calls = [];
  const review = (kind, options = {}) => ({ kind, id: 'f'.repeat(64), entries: entries(), totals: { skills: 1, agents: 1, files: 3, bytes: 190 },
    outputPath: options.outputPath || path.join(project, 'bzzy-definitions-fixture.zip'), conflicts: [] });
  api = {
    previewDefinitionExport(options) { calls.push(['preview-export', options]); return review('definition-export', options); },
    exportDefinitionBundle(value, options) { calls.push(['export', value, options]); return { path: options.outputPath, sha256: 'f'.repeat(64), bytes: 190, skills: 1, agents: 1 }; },
    previewDefinitionImport(file, options) { calls.push(['preview-import', file, options]); return { ...review('definition-import'), archiveSha256: 'a'.repeat(64) }; },
    importDefinitionBundle(value, options) { calls.push(['import', value, options]); return { skills: [{}], agents: [{}], skipped: [] }; },
  };
});
test.afterEach(() => {
  ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
const command = (panel, action) => (panel === 'skills' ? skillsCommand : subagentsCommand)(`/${panel} ${action}`, ui, { bundleApi: api });
const back = () => { ui.tui.render(); const hit = ui.tui.hitTargets.find(item => item.type === 'back'); assert.ok(hit); input.write(`\x1b[<0;${hit.left};${hit.row}M`); };
const rowsFor = panel => panel === 'skills' ? skillRows(ui) : subagentRows(ui);

test('both libraries offer the same ZIP review, exact manifest, and explicit write without model work', async () => {
  for (const panel of ['skills', 'agents']) {
    await command(panel, 'library');
    assert.ok(rowsFor(panel).some(row => row.text === 'Export skills & agents ZIP' && row.action === 'bundle-export'));
    assert.ok(rowsFor(panel).some(row => row.text === 'Import skills & agents ZIP' && row.action === 'bundle-import'));
    await command(panel, 'bundle-export');
    assert.equal(calls.filter(call => call[0] === 'export').length, panel === 'skills' ? 0 : 1);
    const text = rowsFor(panel).map(row => row.text).join('\n');
    assert.match(text, /1 skill · 1 agent · 3 files · 190 bytes/);
    assert.match(text, /Skill · http-review · This project/); assert.match(text, /Agent · response-analyst · BZZY Core \/ global/);
    assert.match(text, /version aaaaaaaaaaaa/); assert.match(text, /Existing files are never overwritten/);
    await command(panel, 'bundle-files');
    assert.match(rowsFor(panel).map(row => row.text).join('\n'), /references\/method.md · 20 bytes/);
    assert.match(rowsFor(panel).map(row => row.text).join('\n'), new RegExp('SHA256 ' + 'c'.repeat(64)));
    back(); assert.equal(ui.definitionBundleDraft.section, 'review'); assert.equal(ui.tui.panel, panel);
    await command(panel, 'bundle-confirm'); assert.equal(ui.definitionBundleDraft, null);
    const committed = calls.filter(call => call[0] === 'export').at(-1);
    assert.equal(committed[2].cwd, project); assert.equal(path.dirname(committed[2].outputPath), project);
    back(); assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'Unsent chat draft'); assert.equal(ui.tui.cursor, 6);
  }
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('Back/Escape cancel ZIP path prompts and reviews while preserving the original chat draft', async () => {
  await command('skills', 'bundle-export'); const original = ui.definitionBundleDraft.review;
  const rename = command('skills', 'bundle-output'); await settle();
  input.write('unconfirmed-name.zip'); input.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 40)); await rename;
  assert.equal(ui.definitionBundleDraft.review, original); assert.equal(calls.filter(call => call[0] === 'export').length, 0);
  assert.equal(ui.tui.value, 'Unsent chat draft'); assert.equal(ui.tui.cursor, 6);
  back(); assert.equal(ui.definitionBundleDraft, null); assert.equal(ui.tui.panel, 'skills');
  const importing = command('agents', 'bundle-import'); await settle(); ui.tui.render();
  const promptBack = ui.tui.hitTargets.find(item => item.type === 'back'); assert.ok(promptBack);
  input.write(`\x1b[<0;${promptBack.left};${promptBack.row}M`); await importing;
  assert.equal(calls.filter(call => call[0] === 'preview-import').length, 0); assert.equal(ui.definitionBundleDraft, null);
  assert.equal(ui.tui.value, 'Unsent chat draft'); assert.equal(ui.tui.cursor, 6);
});

test('imports preview conflicts and require the explicit skip action; all-conflict reviews cannot import', async () => {
  api.previewDefinitionImport = (file, options) => {
    calls.push(['preview-import', file, options]); return { kind: 'definition-import', id: 'f'.repeat(64), entries: entries(),
      totals: { skills: 1, agents: 1, files: 3, bytes: 190 }, conflicts: [{ kind: 'skill', name: 'http-review', scope: 'project' }] };
  };
  const importing = command('agents', 'bundle-import'); await settle(); ui.tui.value = 'review.zip'; input.write('\r'); await importing;
  assert.equal(calls.find(call => call[0] === 'preview-import')[1], path.join(project, 'review.zip'));
  assert.equal(calls.filter(call => call[0] === 'import').length, 0);
  const rows = rowsFor('agents'); assert.ok(rows.some(row => /Skills import disabled; agent definitions/.test(row.text)));
  assert.ok(rows.some(row => row.action === 'bundle-confirm-skip')); assert.ok(!rows.some(row => row.action === 'bundle-confirm'));
  await assert.rejects(definitionBundleAction('bundle-confirm', ui, 'agents', { api }), /conflicts/);
  await command('agents', 'bundle-confirm-skip'); assert.equal(calls.find(call => call[0] === 'import')[2].skipConflicts, true);
  const again = command('skills', 'bundle-import'); await settle(); ui.tui.value = 'review.zip'; input.write('\r'); await again;
  ui.definitionBundleDraft.review.conflicts.push({ kind: 'agent', name: 'response-analyst', scope: 'global' });
  assert.ok(!rowsFor('skills').some(row => row.action === 'bundle-confirm-skip'));
  assert.match(rowsFor('skills').map(row => row.text).join('\n'), /All definitions conflict/);
  await assert.rejects(definitionBundleAction('bundle-confirm-skip', ui, 'skills', { api }), /Every definition conflicts/);
});

test('changed home, project, active session and cancelled async previews cannot write into another context', async () => {
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  for (const mutate of [() => { ui.tui.cwd = other; }, () => { process.env.BZZY_HOME = path.join(directory, 'other-private'); },
    () => { ui.activeTab = createSession(BUILTINS.codex, other, 'other-model').id; }]) {
    await command('skills', 'bundle-export'); mutate();
    await assert.rejects(definitionBundleAction('bundle-confirm', ui, 'skills', { api }), /changed/);
    process.env.BZZY_HOME = path.join(directory, 'private'); ui.activeTab = null; ui.tui.cwd = project; ui.definitionBundleDraft = null;
  }
  assert.equal(calls.filter(call => call[0] === 'export').length, 0);
  let resolvePreview; api.previewDefinitionExport = () => new Promise(resolve => { resolvePreview = resolve; });
  const pending = command('agents', 'bundle-export'); await settle(); back(); assert.equal(ui.definitionBundleDraft, null);
  resolvePreview({ kind: 'definition-export', id: 'f'.repeat(64), entries: entries(), totals: { skills: 1, agents: 1, files: 3, bytes: 190 } }); await pending;
  assert.equal(ui.definitionBundleDraft, null); assert.equal(ui.tui.panel, 'agents');
});

test('cold backend loading is cancelled by Back and cannot reopen an import prompt or resurrect an old operation', async () => {
  await command('agents', 'library');
  let resolveLoad;
  const pending = definitionBundleAction('bundle-import', ui, 'agents', { loadApi: () => new Promise(resolve => { resolveLoad = resolve; }) });
  assert.equal(ui.definitionBundleDraft.loading, true); back(); assert.equal(ui.definitionBundleDraft, null);
  await command('agents', 'bundle-export'); const replacement = ui.definitionBundleDraft;
  resolveLoad(api); await pending;
  assert.equal(ui.definitionBundleDraft, replacement); assert.equal(ui.tui.promptDraft, undefined);
  assert.equal(calls.filter(call => call[0] === 'preview-import').length, 0);
  let resolveStale;
  const stale = definitionBundleAction('bundle-export', ui, 'agents', { loadApi: () => new Promise(resolve => { resolveStale = resolve; }) });
  ui.tui.cwd = path.join(directory, 'other-project'); resolveStale(api);
  await assert.rejects(stale, /changed/); assert.equal(ui.definitionBundleDraft, null);
});

test('the actual Core ZIP round trip through both library workflows preserves resources and installs without model work', async () => {
  const source = path.join(directory, 'portable-source'); fs.mkdirSync(path.join(source, 'references'), { recursive: true }); fs.mkdirSync(path.join(source, 'assets'));
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: portable-response-review\ndescription: Compare controlled response samples.\n---\nReview the supplied samples and record uncertainty.\n');
  fs.writeFileSync(path.join(source, 'references/method.md'), 'Compare two supplied controls and retain uncertain outcomes.');
  fs.writeFileSync(path.join(source, 'assets/sample.bin'), Buffer.from([0, 255, 1]));
  const skill = importSkill(source, { scope: 'project', projectRoot: project });
  const agent = saveSubagentDefinition({ name: 'portable-response-analyst', description: 'Analyze supplied HTTP responses.', instructions: 'Compare the supplied controls. Report uncertainty without inventing evidence.', provider: 'codex', model: 'fixture-specialist', effort: 'low' },
    { cwd: project, scope: 'global', expectedRevision: 0 });
  api = undefined;
  await command('skills', 'bundle-export'); const review = ui.definitionBundleDraft?.review;
  assert.ok(review); assert.equal(path.dirname(review.outputPath), project); assert.equal(fs.existsSync(review.outputPath), false);
  assert.equal(review.totals.skills, 1); assert.equal(review.totals.agents, 1);
  assert.match(rowsFor('skills').map(row => row.text).join('\n'), /Model: codex · fixture-specialist · low effort/);
  await command('skills', 'bundle-files');
  const reference = rowsFor('skills').find(row => row.text.startsWith('references/method.md'));
  await command('skills', reference.action); assert.equal(ui.definitionBundleDraft.filePreview.text, 'Compare two supplied controls and retain uncertain outcomes.');
  back(); assert.equal(ui.definitionBundleDraft.filePreview, null); assert.equal(ui.definitionBundleDraft.section, 'files');
  const binary = rowsFor('skills').find(row => row.text.startsWith('assets/sample.bin'));
  await command('skills', binary.action); assert.equal(ui.definitionBundleDraft.filePreview.text, null);
  assert.match(rowsFor('skills').map(row => row.text).join('\n'), /Binary resource/); back(); back();
  await command('skills', 'bundle-confirm'); assert.equal(fs.existsSync(review.outputPath), true);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  const target = path.join(directory, 'recipient-project'); fs.mkdirSync(target); process.env.BZZY_HOME = path.join(directory, 'recipient-private');
  const session = createSession(BUILTINS.codex, target, 'recipient-model', 'Recipient'); ui.setSession(session.id); ui.updateSession(session);
  const importing = command('agents', 'bundle-import'); await settle();
  for (let attempt = 0; !ui.tui.promptDraft && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  ui.tui.value = review.outputPath; input.write('\r'); await importing;
  assert.ok(ui.definitionBundleDraft?.review); assert.equal(ui.definitionBundleDraft.review.conflicts.length, 0);
  assert.throws(() => inspectSkill(skill.name, { scope: 'project', projectRoot: target }), /not found|unknown|unavailable/i);
  await command('agents', 'bundle-confirm');
  const imported = inspectSkill(skill.name, { scope: 'project', projectRoot: target });
  assert.equal(imported.enabled, false); assert.equal(imported.version, skill.version); assert.deepEqual(imported.files, skill.files);
  assert.equal(readSkill(imported.id, { projectRoot: target, scope: 'project', enabledOnly: false, file: 'references/method.md' }).text,
    'Compare two supplied controls and retain uncertain outcomes.');
  assert.equal(getSubagentDefinition(agent.name, { cwd: target, scope: 'global' }).instructions, agent.instructions);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  assert.equal(fs.existsSync(source), true);
});
