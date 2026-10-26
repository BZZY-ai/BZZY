import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digest, getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { importSkill, setSkillEnabled } from '../src/engine/skills.js';
import { saveSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { saveWorkflow, getWorkflow, workflowSelection, selectWorkflow } from '../src/engine/workflows.js';
import { saveGoalTemplate } from '../src/engine/goal-templates.js';
import { createSession } from '../src/engine/store.js';
import { previewLibraryImport, importLibraryBundle, previewLibraryExport, listLibraryExportChoices, previewSelectedLibraryExport, buildLibraryArchive, readDefinitionBundleFile, discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';

let directory, cwd, previousHome, reviews;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-selection-')));
  process.env.BZZY_HOME = path.join(directory, 'core');
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd); reviews = [];
});
test.afterEach(() => {
  for (const review of reviews) discardDefinitionBundleReview(review);
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const pinFields = ['kind', 'scope', 'name', 'id', 'revision', 'version'];
const pin = value => Object.fromEntries(pinFields.map(key => [key, value[key]]));
function preview(options = {}) {
  const review = previewLibraryExport({ cwd, ...options }); reviews.push(review); return review;
}
function skill(name = 'blocked-checks', files = {}) {
  const source = path.join(directory, 'skill-' + randomUUID()); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Review offline supplied evidence.\n---\nInspect the supplied controls.\n`);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true }); fs.writeFileSync(path.join(source, file), content);
  }
  return importSkill(source, { scope: 'global', projectRoot: cwd });
}
function agent() {
  return saveSubagentDefinition({ name: 'portable-reviewer', description: 'Review supplied evidence.', instructions: 'Compare the supplied positive and negative controls.' }, { cwd, scope: 'global' });
}
function output() {
  const folder = path.join(process.env.BZZY_HOME, 'relay', 'shares', randomUUID()); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return path.join(folder, 'project.zip');
}
function build(review, options = {}) {
  const file = output();
  buildLibraryArchive(file, { cwd, expectedDigest: review.sourceDigest, kinds: review.kinds, excludeEntries: review.excludeEntries, excludeGoalIds: review.excludeGoalIds, ...options });
  return file;
}
function blocked(options = {}) {
  let caught;
  try { preview(options); } catch (error) { caught = error; }
  assert.equal(caught?.code, 'LIBRARY_BLOCKED_ENTRIES'); return caught;
}
function archive(file) {
  const result = spawnSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps({i.filename:z.read(i).decode() for i in z.infolist()}))', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}

test('name selection uses metadata only and excludes unreadable unselected packages and later additions', () => {
  const kept = skill('chosen-checks'), broken = skill('broken-checks'); agent();
  fs.rmSync(path.join(process.env.BZZY_HOME, 'skills', broken.name, broken.version), { recursive: true });
  const catalog = listLibraryExportChoices({ cwd, kinds: ['skill'] });
  assert.deepEqual(catalog.entries.map(row => row.name), ['broken-checks', 'chosen-checks']);
  for (const entry of catalog.entries) assert.deepEqual(Object.keys(entry).sort(), [...pinFields].sort());
  const later = skill('later-checks');
  const review = previewSelectedLibraryExport({ cwd, kinds: ['skill'], selectedEntries: catalog.entries.filter(row => row.id === kept.id) }); reviews.push(review);
  assert.deepEqual(review.entries.map(row => row.name), ['chosen-checks']);
  assert.deepEqual(review.excludeEntries.map(row => row.id).sort(), [broken.id, later.id].sort());
  const files = archive(build(review));
  assert.deepEqual(Object.keys(files).sort(), ['manifest.json', 'skills/global/chosen-checks/SKILL.md']);
  assert.ok(!JSON.stringify(files).includes('broken-checks')); assert.ok(!JSON.stringify(files).includes('later-checks'));
});

test('name selection rejects stale, unknown, empty and duplicate pins before export', () => {
  const source = skill('chosen-checks');
  const { entries } = listLibraryExportChoices({ cwd, kinds: ['skill'] });
  for (const selectedEntries of [[], [entries[0], entries[0]], [{ ...entries[0], name: 'unknown-checks' }]]) {
    assert.throws(() => previewSelectedLibraryExport({ cwd, kinds: ['skill'], selectedEntries }));
  }
  setSkillEnabled(source.id, true, source.revision);
  assert.throws(() => previewSelectedLibraryExport({ cwd, kinds: ['skill'], selectedEntries: entries }), { code: 'STALE_REVIEW' });
});

test('only selected kinds are scanned, so unrelated broken or private entries cannot prevent agent sharing', () => {
  const source = skill('unreadable-checks'); agent();
  fs.rmSync(path.join(process.env.BZZY_HOME, 'skills', source.name, source.version), { recursive: true });
  saveWorkflow({ name: 'private-flow', instructions: 'Read /Users/fixture-owner/private-case first.' }, { cwd, scope: 'global' });
  saveGoalTemplate({ objective: 'Use /Users/fixture-owner/private-goal' });
  const review = preview({ kinds: ['agent'] });
  assert.deepEqual(review.kinds, ['agent']); assert.deepEqual(review.entries.map(entry => entry.kind), ['agent']);
  assert.deepEqual(review.excludeEntries, []); assert.deepEqual(review.excludedEntries, []);
  assert.ok(readDefinitionBundleFile(review, { cwd, entryIndex: 0, file: 'definition.json' }).text.includes('portable-reviewer'));
  const files = archive(build(review)); assert.deepEqual(Object.keys(files).sort(), ['agents/global/portable-reviewer.json', 'manifest.json']);
  assert.equal(blocked({ kinds: ['skill', 'agent'] }).blockedEntries[0].reasonCode, 'RESOURCE_IO');
});

test('blocked entries expose only safe pinned metadata and source locations, and explicit exclusion omits the entire package', () => {
  const privateValue = 'fixture-private-account-value';
  skill('blocked-checks', { 'references/first.txt': 'Benign first resource.\n', 'references/setup.py': `# Setup\ntoken = "${privateValue}"\n` });
  agent();
  const error = blocked({ kinds: ['skill', 'agent'] }), entry = error.blockedEntries[0];
  assert.equal(error.blockedEntries.length, 1);
  assert.deepEqual(Object.keys(entry).sort(), [...pinFields, 'reason', 'reasonCode', 'file', 'line'].sort());
  assert.equal(entry.kind, 'skill'); assert.equal(entry.scope, 'global'); assert.equal(entry.name, 'blocked-checks');
  assert.equal(entry.reasonCode, 'CREDENTIAL_LITERAL'); assert.equal(entry.file, 'references/setup.py'); assert.equal(entry.line, 2);
  const diagnostic = JSON.stringify({ message: error.message, ...error });
  for (const omitted of [privateValue, directory, process.env.BZZY_HOME, 'token =']) assert.ok(!diagnostic.includes(omitted));
  const excludeEntries = [pin(entry)], review = preview({ kinds: ['agent', 'skill'], excludeEntries });
  assert.deepEqual(review.kinds, ['agent', 'skill']); assert.deepEqual(review.excludeEntries, excludeEntries);
  assert.equal(review.excludedEntries.length, 1); assert.equal(review.totals.skills, 0); assert.equal(review.totals.agents, 1);
  const files = archive(build(review)), serialized = JSON.stringify(files);
  assert.equal(Object.keys(files).some(file => file.startsWith('skills/')), false);
  for (const omitted of [entry.name, privateValue, 'Benign first resource', entry.version, 'excludedEntries']) assert.ok(!serialized.includes(omitted));
});

test('exclusions require exact identity and revision, and changed omitted entries invalidate file review and archive creation', () => {
  const source = skill('blocked-checks', { 'references/setup.txt': 'password = "fixture-private-value"\n' }); agent();
  const entry = pin(blocked({ kinds: ['skill', 'agent'] }).blockedEntries[0]);
  for (const changed of [{ id: entry.id + '-other' }, { name: 'missing-checks' }, { scope: 'project' }, { revision: entry.revision + 1 }, { version: '0'.repeat(64) }]) {
    assert.throws(() => preview({ kinds: ['agent', 'skill'], excludeEntries: [{ ...entry, ...changed }] }), { code: 'STALE_REVIEW' });
  }
  const review = preview({ kinds: ['agent', 'skill'], excludeEntries: [entry] });
  setSkillEnabled(source.id, true, source.revision);
  assert.throws(() => build(review), { code: 'STALE_REVIEW' });
  assert.throws(() => readDefinitionBundleFile(review, { cwd, entryIndex: 0, file: 'definition.json' }), { code: 'STALE_REVIEW' });
});

test('selected kinds and explicit omissions are digest-bound even when the exported resources are identical', () => {
  agent();
  const narrow = preview({ kinds: ['agent'] }), broad = preview({ kinds: ['skill', 'agent'] });
  assert.deepEqual(narrow.entries, broad.entries); assert.notEqual(narrow.sourceDigest, broad.sourceDigest);
  assert.throws(() => build(narrow, { kinds: broad.kinds }), { code: 'STALE_REVIEW' });
  const safe = skill('safe-checks'), record = getRecord('core.skill', safe.id);
  const exclusion = { kind: 'skill', scope: 'global', name: record.name, id: record.id || record.name, revision: record.revision, version: record.version };
  const omitted = preview({ kinds: ['agent', 'skill'], excludeEntries: [exclusion] });
  assert.deepEqual(omitted.entries, narrow.entries); assert.notEqual(omitted.sourceDigest, broad.sourceDigest);
  assert.throws(() => build(omitted, { excludeEntries: [] }), { code: 'STALE_REVIEW' });
  putRecord('core.skill', safe.id, { ...record, revision: record.revision + 1 });
  assert.throws(() => build(omitted), { code: 'STALE_REVIEW' });
});

test('kind and omission selectors reject unknown, duplicate, sparse or malformed values before collection', () => {
  agent();
  for (const kinds of [[], ['agent', 'agent'], ['agents'], ['agent', undefined], new Array(1), null, 'agent']) {
    assert.throws(() => preview({ kinds }), /Library kinds/);
  }
  const entry = { kind: 'skill', scope: 'global', name: 'missing-checks', id: 'missing-checks', revision: 1, version: digest('missing') };
  for (const excludeEntries of [null, new Array(1), [entry, entry], [{ ...entry, extra: true }], [{ ...entry, revision: 0 }], [{ ...entry, id: 'bad\nidentity' }]]) {
    assert.throws(() => preview({ kinds: ['agent', 'skill'], excludeEntries }));
  }
  assert.throws(() => preview({ kinds: ['agent'], excludeEntries: [entry] }), /selected Library kinds/);
  assert.throws(() => preview({ kinds: ['agent'], excludeGoalIds: ['template:' + 'a'.repeat(64)] }), /goal Library kind/);
  assert.throws(() => preview({ kinds: ['agent'], excludeGoalIds: new Array(1) }), /bounded list/);
});

test('unsafe source file names and private workflow contents are diagnosed without echoing private values', () => {
  const privateFile = 'references/reviewer@fixture-account.invalid.txt';
  skill('unsafe-file-name', { [privateFile]: 'Harmless resource bytes.\n' });
  saveWorkflow({ name: 'private-flow', instructions: 'Inspect /Users/fixture-owner/private-case.' }, { cwd, scope: 'global' });
  agent();
  const error = blocked({ kinds: ['workflow', 'skill', 'agent'] });
  assert.deepEqual(error.blockedEntries.map(row => row.reasonCode), ['PRIVATE_ACCOUNT', 'PRIVATE_HOST_PATH']);
  assert.ok(error.blockedEntries.every(row => row.file === undefined));
  const diagnostic = JSON.stringify({ message: error.message, ...error });
  for (const omitted of [privateFile, 'reviewer@fixture-account.invalid', '/Users/fixture-owner/private-case']) assert.ok(!diagnostic.includes(omitted));
  const review = preview({ kinds: ['skill', 'agent', 'workflow'], excludeEntries: error.blockedEntries.map(pin) });
  assert.deepEqual(review.entries.map(row => row.kind), ['agent']);
});

test('reusable skill account-address blockers identify the first exact source line without exposing any address', () => {
  const addresses = ['operator@fixture-mail.invalid', 'reviewer@fixture-mail.invalid', 'default@fixture-mail.invalid'];
  const source = path.join(directory, 'account-fixture'); fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: account-fixture\ndescription: Review supplied account controls.\n---\nUse the supplied offline fixtures.\n\nAccount: ${addresses[0]}\n\nFallback: ${addresses[1]}\n`);
  fs.writeFileSync(path.join(source, 'scripts', 'fixture.py'), `# Offline fixture\nDEFAULT_EMAIL = "${addresses[2]}"\n`);
  importSkill(source, { scope: 'global', projectRoot: cwd });
  const error = blocked({ kinds: ['skill'] }), entry = error.blockedEntries[0];
  assert.equal(entry.reasonCode, 'PRIVATE_ACCOUNT'); assert.equal(entry.file, 'SKILL.md'); assert.equal(entry.line, 7);
  const diagnostic = JSON.stringify({ message: error.message, ...error });
  for (const value of [...addresses, directory, 'Account:', 'DEFAULT_EMAIL']) assert.ok(!diagnostic.includes(value));
});

test('damaged inventories and workflow content are actionable as whole-entry exclusions while their original pins remain mandatory', () => {
  const source = skill('damaged-checks'), saved = getRecord('core.skill', source.id);
  putRecord('core.skill', source.id, { ...saved, files: saved.files.slice(0, -1) });
  const flow = saveWorkflow({ name: 'damaged-flow', instructions: 'Review supplied controls.' }, { cwd, scope: 'global' });
  putRecord('core.workflow.definition', flow.id, { ...flow, instructions: 'Changed outside Core.' });
  agent();
  const error = blocked({ kinds: ['skill', 'workflow', 'agent'] });
  assert.deepEqual(error.blockedEntries.map(row => row.reasonCode), ['CONTENT_CHANGED', 'CONTENT_CHANGED']);
  const review = preview({ kinds: ['skill', 'workflow', 'agent'], excludeEntries: error.blockedEntries.map(pin) });
  assert.deepEqual(review.entries.map(row => row.kind), ['agent']);
  assert.deepEqual(Object.keys(archive(build(review))).sort(), ['agents/global/portable-reviewer.json', 'manifest.json']);
});


test('workflow and goal checkboxes pin only selected entries, including later additions and blocked unchecked text', () => {
  const chosenGoal = saveGoalTemplate({ objective: 'Review the supplied HTTP response controls.' });
  const otherGoal = saveGoalTemplate({ objective: 'Review a different supplied fixture.' });
  const privateGoal = saveGoalTemplate({ objective: 'Inspect /Users/fixture-owner/private-case.' });
  const chosenFlow = saveWorkflow({ name: 'chosen-process', instructions: 'Use supplied positive and negative controls.' }, { cwd, scope: 'project' });
  saveWorkflow({ name: 'private-process', instructions: 'Read /Users/fixture-owner/private-context.' }, { cwd, scope: 'global' });
  const kinds = ['goal', 'workflow'], catalog = listLibraryExportChoices({ cwd, kinds });
  const chosen = catalog.entries.filter(row => row.id === 'template:' + chosenGoal.id || row.id === chosenFlow.id);
  assert.equal(chosen.length, 2);
  const goalPin = chosen.find(row => row.kind === 'goal');
  assert.equal(catalog.labels[JSON.stringify(['goal', 'global', goalPin.name])], chosenGoal.objective);
  assert.ok(catalog.entries.every(row => Object.keys(row).length === pinFields.length));
  saveGoalTemplate({ objective: 'An objective created after opening Export.' });
  saveWorkflow({ name: 'later-process', instructions: 'Review later supplied evidence.' }, { cwd, scope: 'global' });
  const review = previewSelectedLibraryExport({ cwd, kinds, selectedEntries: chosen }); reviews.push(review);
  assert.deepEqual(review.totals.goals, 1); assert.deepEqual(review.totals.workflows, 1);
  assert.ok(review.excludeGoalIds.includes('template:' + otherGoal.id));
  assert.ok(review.excludeGoalIds.includes('template:' + privateGoal.id));
  const files = archive(build(review)), manifest = JSON.parse(files['manifest.json']);
  assert.deepEqual([manifest.skills.length, manifest.agents.length, manifest.workflows.length, manifest.goals.length], [0, 0, 1, 1]);
  assert.deepEqual(JSON.parse(files[manifest.goals[0].file]), { objective: chosenGoal.objective });
  assert.match(files[manifest.workflows[0].file], /supplied positive and negative controls/);
  assert.ok(!JSON.stringify(files).includes('/Users/fixture-owner')); assert.ok(!JSON.stringify(files).includes('later-process'));
});

test('goal and workflow selections reject malformed, duplicate, changed and unavailable pins before publishing', () => {
  const template = saveGoalTemplate({ objective: 'Review supplied immutable goal text.' });
  const flow = saveWorkflow({ name: 'review-process', instructions: 'Review supplied controls.' }, { cwd, scope: 'global' });
  const goal = listLibraryExportChoices({ cwd, kinds: ['goal'] }).entries[0];
  for (const selectedEntries of [[goal, goal], [{ ...goal, revision: 1 }], [{ ...goal, scope: 'project' }],
    [{ ...goal, name: 'changed-goal' }], [{ ...goal, id: 1 }], [{ ...goal, extra: true }], new Array(1)]) {
    assert.throws(() => previewSelectedLibraryExport({ cwd, kinds: ['goal'], selectedEntries }));
  }
  const flowPin = listLibraryExportChoices({ cwd, kinds: ['workflow'] }).entries[0];
  saveWorkflow({ name: flow.name, instructions: 'Changed supplied workflow controls.' }, { cwd, scope: 'global', expectedRevision: flow.revision });
  assert.throws(() => previewSelectedLibraryExport({ cwd, kinds: ['workflow'], selectedEntries: [flowPin] }), { code: 'STALE_REVIEW' });
  putRecord('core.goal.template', template.id, { ...template, createdAt: '2026-10-01T01:00:00Z' });
  assert.throws(() => previewSelectedLibraryExport({ cwd, kinds: ['goal'], selectedEntries: [goal] }), { code: 'STALE_REVIEW' });
  const current = listLibraryExportChoices({ cwd, kinds: ['goal'] }).entries;
  const review = previewSelectedLibraryExport({ cwd, kinds: ['goal'], selectedEntries: current }); reviews.push(review);
  putRecord('core.goal.template', template.id, { ...template, createdAt: '2026-10-02T01:00:00Z' });
  assert.throws(() => build(review), { code: 'STALE_REVIEW' });
});

test('selected goal and workflow imports skip existing text and scoped names without selecting or executing them', () => {
  const first = saveGoalTemplate({ objective: 'An existing recipient objective.' });
  const second = saveGoalTemplate({ objective: 'A missing recipient objective.' });
  saveWorkflow({ name: 'shared-process', instructions: 'SOURCE_GLOBAL_INSTRUCTIONS' }, { cwd, scope: 'global' });
  saveWorkflow({ name: 'shared-process', instructions: 'SOURCE_PROJECT_INSTRUCTIONS' }, { cwd, scope: 'project' });
  const kinds = ['goal', 'workflow'];
  const review = previewSelectedLibraryExport({ cwd, kinds, selectedEntries: listLibraryExportChoices({ cwd, kinds }).entries }); reviews.push(review);
  const file = build(review), sourceHome = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'recipient');
  try {
    saveGoalTemplate({ objective: first.objective });
    const existing = saveWorkflow({ name: 'shared-process', instructions: 'RECIPIENT_OWN_INSTRUCTIONS' }, { cwd, scope: 'global' });
    const session = createSession({ id: 'codex', backend: 'codex' }, cwd, 'offline-fixture');
    const selected = selectWorkflow(session.id, existing.name, { scope: 'global', expectedRevision: 0 });
    const importedReview = previewLibraryImport(file, { cwd }); reviews.push(importedReview);
    const result = importLibraryBundle(importedReview, { cwd, enable: true, reportReceipt: true });
    assert.equal(result.goals.length, 1); assert.equal(result.goals[0].version, second.version);
    assert.deepEqual(result.workflows.map(row => [row.name, row.scope]), [['shared-process', 'project']]);
    assert.equal(result.skipped.length, 2);
    assert.equal(getWorkflow(existing.name, { cwd, scope: 'global' }).instructions, existing.instructions);
    assert.deepEqual(workflowSelection(session.id), selected);
    const retry = previewLibraryImport(file, { cwd }); reviews.push(retry);
    assert.equal(importLibraryBundle(retry, { cwd, enable: true, reportReceipt: true }).alreadyImported, true);
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  } finally { process.env.BZZY_HOME = sourceHome; }
});
