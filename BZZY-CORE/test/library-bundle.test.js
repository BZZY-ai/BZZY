import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { database, getRecord, putRecord, listRecords, digest } from '../src/engine/database.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { newGoal } from '../src/engine/goals.js';
import { importSkill, inspectSkill, readSkill, createSkill, setSkillEnabled } from '../src/engine/skills.js';
import { saveSubagentDefinition, getSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { saveWorkflow, getWorkflow } from '../src/engine/workflows.js';
import { listSavedGoals, getSavedGoal } from '../src/engine/saved-goals.js';
import { normalizeGoalTemplate, saveGoalTemplate, getGoalTemplate } from '../src/engine/goal-templates.js';
import { previewLibraryExport, buildLibraryArchive, previewLibraryImport, importLibraryBundle,
  readDefinitionBundleFile, discardDefinitionBundleReview, previewDefinitionImport, libraryImportEntryIndexes } from '../src/engine/definition-bundle.js';

let directory, cwd, sourceHome, previousHome, reviews;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-library-bundle-')));
  sourceHome = path.join(directory, 'source'); process.env.BZZY_HOME = sourceHome;
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd); reviews = [];
});
test.afterEach(() => {
  for (const review of reviews) discardDefinitionBundleReview(review);
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
const provider = { id: 'codex', backend: 'codex' };
const remember = value => { reviews.push(value); return value; };
function skill(name = 'shared-checks', scope = 'global', extra = {}) {
  const source = path.join(directory, 'skill-' + randomUUID()); fs.mkdirSync(path.join(source, 'references'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Review supplied offline controls.\n---\nInspect supplied response evidence.\n`);
  fs.writeFileSync(path.join(source, 'references', 'checks.txt'), 'Compare positive and negative controls.\n');
  for (const [relative, data] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true }); fs.writeFileSync(path.join(source, relative), data); }
  return importSkill(source, { scope, projectRoot: cwd });
}
function agent(name = 'shared-reviewer', scope = 'project') {
  return saveSubagentDefinition({ name, description: 'Review supplied controls.', instructions: 'Inspect the supplied controls and retain uncertainty.',
    provider: 'deepseek', model: 'deepseek-flash', effort: 'low', policy: { mode: 'read-only', network: 'disabled' } }, { cwd, scope });
}
function workflow(name = 'shared-flow', scope = 'project') {
  return saveWorkflow({ name, description: 'Review supplied evidence.', instructions: 'Read the goal and check the supplied positive and negative controls.' }, { cwd, scope });
}
function goal(objective = 'Inspect supplied HTTP responses\nKeep Unicode Ω and complete criteria.', target = cwd) {
  const session = createSession(provider, target, 'sender-only-model', 'Private sender alias');
  session.goal = newGoal(objective); session.goal.status = 'complete'; session.goal.evidence = ['sender-only-evidence'];
  saveSession(session); return session;
}
function output() {
  const folder = path.join(process.env.BZZY_HOME, 'relay', 'shares', randomUUID()); fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return path.join(folder, 'project.zip');
}
function bundle() {
  const review = remember(previewLibraryExport({ cwd })), file = output();
  const result = buildLibraryArchive(file, { cwd, expectedDigest: review.sourceDigest }); return { review, file, result };
}
function recipient() {
  const target = path.join(directory, 'recipient-' + randomUUID()); fs.mkdirSync(target);
  process.env.BZZY_HOME = path.join(directory, 'receiver-' + randomUUID()); return target;
}
function unzip(file) {
  const result = spawnSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps({i.filename:z.read(i).decode() for i in z.infolist()}))', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function rewrite(file, mutate) {
  const files = unzip(file); mutate(files);
  const target = path.join(directory, randomUUID() + '.zip');
  const result = spawnSync('python3', ['-c', 'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z:\n for n,v in json.load(sys.stdin).items(): z.writestr(n,v)', target], { input: JSON.stringify(files), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return target;
}
function snapshot() {
  return { records: database().prepare('SELECT * FROM records ORDER BY kind,id').all(),
    events: database().prepare('SELECT * FROM events ORDER BY seq').all() };
}

test('selected imports install only chosen entries with independent durable receipts and retained owner choices', () => {
  skill(); agent(); workflow(); goal(); const { file } = bundle(), target = recipient();
  const preview = () => remember(previewLibraryImport(file, { cwd: target }));
  const review = preview(), selected = review.entries.findIndex(row => row.kind === 'skill');
  const first = importLibraryBundle(review, { cwd: target, enable: true, entryIndexes: [selected] });
  assert.deepEqual([first.skills.length, first.agents.length, first.workflows.length, first.goals.length], [1, 0, 0, 0]);
  assert.equal(listRecords('core.subagent.definition').length, 0); assert.equal(listRecords('core.workflow.definition').length, 0);
  const saved = first.skills[0]; setSkillEnabled(saved.id, false, saved.revision);
  assert.deepEqual(importLibraryBundle(preview(), { cwd: target, enable: true, entryIndexes: [selected] }), first);
  assert.equal(inspectSkill('shared-checks', { scope: 'global' }).enabled, false);
  const other = review.entries.findIndex(row => row.kind === 'agent');
  const second = importLibraryBundle(preview(), { cwd: target, enable: true, entryIndexes: [other] });
  assert.equal(second.agents.length, 1); assert.equal(second.skills.length, 0);
  assert.equal(listRecords('core.library.import').length, 2);
  assert.equal(listRecords('core.goal.template').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('invalid import selections cannot mutate registries and all-entry selection retains the legacy receipt', () => {
  skill(); agent(); const { file } = bundle(), target = recipient(), review = remember(previewLibraryImport(file, { cwd: target }));
  const before = snapshot();
  for (const entryIndexes of [[], [0, 0], [-1], [2], [0.5], ['0'], new Array(1), null]) {
    assert.throws(() => importLibraryBundle(review, { cwd: target, entryIndexes })); assert.deepEqual(snapshot(), before);
  }
  const input = [1, 0], normalized = libraryImportEntryIndexes(input, 2); input[0] = 9;
  assert.deepEqual(normalized, [0, 1]);
  const first = importLibraryBundle(review, { cwd: target, entryIndexes: normalized });
  assert.deepEqual(importLibraryBundle(remember(previewLibraryImport(file, { cwd: target })), { cwd: target }), first);
  assert.equal(listRecords('core.library.import').length, 1);
});

test('all four portable resource kinds retain exact resources and remap scopes without sender identity or execution', () => {
  skill(); skill('project-checks', 'project'); agent(); agent('global-reviewer', 'global'); workflow(); workflow('global-flow', 'global');
  const sourceGoal = goal(), other = path.join(directory, 'another-project'); fs.mkdirSync(other); goal('resume', other);
  const { review, file, result } = bundle();
  assert.deepEqual([review.totals.skills, review.totals.agents, review.totals.workflows, review.totals.goals], [2, 2, 2, 2]);
  assert.equal(result.bytes, fs.statSync(file).size); assert.equal(result.sha256, digest(fs.readFileSync(file)));
  const files = unzip(file), manifest = JSON.parse(files['manifest.json']);
  assert.equal(manifest.version, 2);
  const serialized = JSON.stringify(files);
  for (const omitted of [sourceGoal.id, sourceGoal.goal.id, cwd, sourceHome, 'sender-only-evidence', 'sender-only-model', 'Private sender alias', 'deepseek-flash']) assert.ok(!serialized.includes(omitted), omitted);
  const agentText = JSON.parse(files['agents/project/shared-reviewer.json']);
  assert.equal(agentText.provider, undefined); assert.equal(agentText.model, undefined); assert.equal(agentText.effort, undefined);
  const readable = readDefinitionBundleFile(review, { cwd, entryIndex: review.entries.findIndex(entry => entry.kind === 'goal'), file: 'definition.json' });
  assert.ok(readable.text.includes('objective'));
  const target = recipient(), importedReview = remember(previewLibraryImport(file, { cwd: target }));
  assert.equal(importedReview.conflicts.length, 0);
  assert.throws(() => previewDefinitionImport(file, { cwd: target }), /manifest|unsupported|Unsupported/);
  const imported = importLibraryBundle(importedReview, { cwd: target });
  assert.deepEqual([imported.skills.length, imported.agents.length, imported.workflows.length, imported.goals.length], [2, 2, 2, 2]);
  assert.equal(inspectSkill('shared-checks', { scope: 'global' }).enabled, false);
  const localSkill = imported.skills.find(record => record.name === 'project-checks');
  assert.equal(readSkill(localSkill.id, { enabledOnly: false, file: 'references/checks.txt' }).text, 'Compare positive and negative controls.\n');
  const localAgent = getSubagentDefinition('shared-reviewer', { cwd: target, scope: 'project' });
  assert.equal(localAgent.enabled, false); assert.equal(localAgent.provider, undefined); assert.equal(localAgent.model, undefined);
  assert.deepEqual(localAgent.policy, { mode: 'read-only', network: 'disabled', writablePaths: [] });
  assert.equal(getWorkflow('shared-flow', { cwd: target, scope: 'project' }).projectRoot, target);
  assert.equal(listRecords('core.workflow.selection').length, 0);
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
  const choices = listSavedGoals(); assert.equal(choices.total, 2);
  assert.ok(choices.goals.every(row => row.source === 'template' && row.sessionId === null && row.status === null));
  assert.deepEqual(getSavedGoal(choices.goals[0].id, { revision: choices.goals[0].revision }), choices.goals[0]);
});

test('only-missing import skips changed recipient definitions and existing historical goal text without overwriting', () => {
  skill(); agent(); workflow(); goal('An already saved objective'); const { file } = bundle(), target = recipient();
  const keptSkill = createSkill({ name: 'shared-checks', description: 'Keep local behavior.', instructions: 'Keep the recipient instructions.' }, { scope: 'global' });
  const keptAgent = saveSubagentDefinition({ name: 'shared-reviewer', description: 'Keep local reviewer.', instructions: 'Keep the existing reviewer implementation.' }, { cwd: target, scope: 'project' });
  const keptFlow = saveWorkflow({ name: 'shared-flow', instructions: 'Keep the receiver workflow unchanged.' }, { cwd: target, scope: 'project' });
  goal('An already saved objective', target);
  const before = snapshot(), review = remember(previewLibraryImport(file, { cwd: target }));
  assert.equal(review.conflicts.length, 4);
  const result = importLibraryBundle(review, { cwd: target, enable: true });
  assert.equal(result.skipped.length, 4); assert.equal(result.goals.length, 0);
  assert.equal(inspectSkill('shared-checks').version, keptSkill.version);
  assert.equal(getSubagentDefinition('shared-reviewer', { cwd: target }).version, keptAgent.version);
  assert.equal(getWorkflow('shared-flow', { cwd: target }).version, keptFlow.version);
  assert.equal(inspectSkill('shared-checks').enabled, false, 'an existing disabled skill stays disabled even when new imports are enabled');
  assert.deepEqual(snapshot().events, before.events);
  assert.equal(listRecords('core.goal.template').length, 0);
});

test('reviewed enable is atomic, audit-preserving and exact accepted retries cannot toggle the recipient again', () => {
  skill(); agent(); workflow(); goal('Reusable goal text'); const { file } = bundle(), target = recipient();
  const review = remember(previewLibraryImport(file, { cwd: target }));
  const first = importLibraryBundle(review, { cwd: target, enable: true });
  assert.equal(inspectSkill('shared-checks').enabled, true);
  assert.equal(getSubagentDefinition('shared-reviewer', { cwd: target }).enabled, true);
  const local = inspectSkill('shared-checks'); setSkillEnabled(local.id, false, local.revision);
  const before = snapshot(), retry = remember(previewLibraryImport(file, { cwd: target }));
  assert.deepEqual(importLibraryBundle(retry, { cwd: target, enable: true }), first);
  assert.equal(inspectSkill('shared-checks').enabled, false, 'a later owner edit is never undone by replay');
  assert.deepEqual(snapshot(), before);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { previewLibraryImport, importLibraryBundle } from ${JSON.stringify(new URL('../src/engine/definition-bundle.js', import.meta.url).href)};
    const [file,cwd] = process.argv.slice(1);
    console.log(JSON.stringify(importLibraryBundle(previewLibraryImport(file,{cwd}),{cwd,enable:true})));
  `, file, target], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout), first);
  assert.deepEqual(snapshot(), before, 'an accepted receipt survives a fresh Core process without rewriting registry state');
  const different = remember(previewLibraryImport(file, { cwd: target }));
  assert.throws(() => importLibraryBundle(different, { cwd: target, enable: false }), { code: 'CONFLICT' });
  assert.equal(listRecords('core.goal.template').length, 1);
});

test('a late registry failure rolls back skill/agent creation, enable audits, templates and import receipt', () => {
  const sourceSkill = skill(); agent(); workflow(); goal(); const { file } = bundle(), target = recipient();
  for (let index = 0; index < 512; index++) putRecord('core.workflow.definition', `capacity-${index}`, { id: `capacity-${index}`, name: `capacity-${index}` });
  const review = remember(previewLibraryImport(file, { cwd: target })), before = snapshot();
  assert.throws(() => importLibraryBundle(review, { cwd: target, enable: true }), /limit/);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'skills', sourceSkill.name, sourceSkill.version)), false);
  for (const kind of ['core.skill', 'core.subagent.definition', 'core.goal.template', 'core.library.import']) assert.equal(listRecords(kind).length, 0);
});

test('source and destination context/revision changes invalidate review, while private output paths cannot escape Relay storage', () => {
  const source = skill(), review = remember(previewLibraryExport({ cwd }));
  assert.throws(() => buildLibraryArchive(path.join(cwd, 'outside.zip'), { cwd, expectedDigest: review.sourceDigest }), /private Relay/);
  assert.equal(fs.existsSync(path.join(cwd, 'outside.zip')), false);
  setSkillEnabled(source.id, true, source.revision);
  assert.throws(() => buildLibraryArchive(output(), { cwd, expectedDigest: review.sourceDigest }), { code: 'STALE_REVIEW' });
  const updated = bundle(), target = recipient(), incoming = remember(previewLibraryImport(updated.file, { cwd: target }));
  createSkill({ name: 'shared-checks', description: 'A new local definition.', instructions: 'Keep this concurrently created local definition.' }, { scope: 'global' });
  assert.throws(() => importLibraryBundle(incoming, { cwd: target }), { code: 'STALE_REVIEW' });
  assert.equal(listRecords('core.library.import').length, 0);
});

test('Library archives reject extra authority, model settings, modified inventories and secret/private goal text', () => {
  agent(); workflow(); goal(); const { file } = bundle(), target = recipient();
  for (const mutate of [
    files => { const manifest = JSON.parse(files['manifest.json']); manifest.permissions = ['execute']; files['manifest.json'] = JSON.stringify(manifest); },
    files => { const definition = JSON.parse(files['agents/project/shared-reviewer.json']); definition.provider = 'codex'; files['agents/project/shared-reviewer.json'] = JSON.stringify(definition); },
    files => { files['extra.json'] = '{}'; },
    files => { const manifest = JSON.parse(files['manifest.json']); manifest.goals[0].sha256 = '0'.repeat(64); files['manifest.json'] = JSON.stringify(manifest); },
    files => {
      const manifest = JSON.parse(files['manifest.json']), item = manifest.agents[0], definition = JSON.parse(files[item.file]);
      definition.provider = 'codex'; const text = JSON.stringify(definition); files[item.file] = text;
      item.version = digest(definition); item.bytes = Buffer.byteLength(text); item.sha256 = digest(Buffer.from(text));
      files['manifest.json'] = JSON.stringify(manifest);
    },
    files => {
      const manifest = JSON.parse(files['manifest.json']), item = manifest.goals[0], definition = JSON.parse(files[item.file]);
      definition.status = 'complete'; definition.permissions = ['execute']; const text = JSON.stringify(definition); files[item.file] = text;
      item.version = digest(definition); item.bytes = Buffer.byteLength(text); item.sha256 = digest(Buffer.from(text));
      files['manifest.json'] = JSON.stringify(manifest);
    },
  ]) assert.throws(() => previewLibraryImport(rewrite(file, mutate), { cwd: target }));
  assert.equal(listRecords('execution').length, 0);
  process.env.BZZY_HOME = sourceHome;
  goal('Use /Users/private-owner/secrets for this task');
  assert.throws(() => previewLibraryExport({ cwd }), { code: 'LIBRARY_BLOCKED_GOALS' });
  assert.throws(() => normalizeGoalTemplate({ objective: 'Goal text', status: 'complete' }), /only/);
  assert.throws(() => normalizeGoalTemplate({ objective: 'sk-' + 'a'.repeat(32) }), /credential/);
});

test('private saved goals require explicit pinned exclusion and never appear in archives or diagnostic details', () => {
  skill(); const safe = goal('A safe reusable objective'), privateGoal = goal('Use /Users/private-owner/private-task to inspect the records');
  let blocked;
  try { previewLibraryExport({ cwd }); assert.fail('Private history must not be silently omitted'); }
  catch (error) { blocked = error; }
  assert.equal(blocked.code, 'LIBRARY_BLOCKED_GOALS');
  assert.deepEqual(blocked.blockedGoals.map(row => row.id), [`${privateGoal.id}:${privateGoal.goal.id}`]);
  assert.ok(!JSON.stringify({ message: blocked.message, blockedGoals: blocked.blockedGoals }).includes('/Users/private-owner'));
  const excludeGoalIds = blocked.blockedGoals.map(row => row.id), review = remember(previewLibraryExport({ cwd, excludeGoalIds }));
  assert.deepEqual(review.excludeGoalIds, excludeGoalIds); assert.equal(review.excludedGoals.length, 1); assert.equal(review.totals.goals, 1);
  const file = output(); buildLibraryArchive(file, { cwd, expectedDigest: review.sourceDigest, excludeGoalIds });
  const archive = JSON.stringify(unzip(file));
  assert.ok(!archive.includes(privateGoal.id)); assert.ok(!archive.includes('/Users/private-owner')); assert.ok(!archive.includes(safe.id));
  const goalIndex = review.entries.findIndex(row => row.kind === 'goal');
  assert.ok(readDefinitionBundleFile(review, { cwd, entryIndex: goalIndex, file: 'definition.json' }).text.includes('A safe reusable objective'));
  const safeExcluded = remember(previewLibraryExport({ cwd, excludeGoalIds: [...excludeGoalIds, `${safe.id}:${safe.goal.id}`] }));
  assert.notEqual(review.sourceDigest, safeExcluded.sourceDigest);
  assert.throws(() => buildLibraryArchive(output(), { cwd, expectedDigest: review.sourceDigest, excludeGoalIds: safeExcluded.excludeGoalIds }), { code: 'STALE_REVIEW' });
  assert.throws(() => previewLibraryExport({ cwd, excludeGoalIds: ['invalid-reference'] }), /bounded list/);
  assert.throws(() => previewLibraryExport({ cwd, excludeGoalIds: [`${randomUUID()}:${randomUUID()}`] }), { code: 'STALE_REVIEW' });
});

test('workflow-only and goal-only libraries remain importable and goal template edits fail closed', () => {
  workflow(); const first = bundle(), firstTarget = recipient();
  const firstReview = remember(previewLibraryImport(first.file, { cwd: firstTarget }));
  assert.equal(importLibraryBundle(firstReview, { cwd: firstTarget }).workflows.length, 1);
  process.env.BZZY_HOME = path.join(directory, 'goals-only'); saveGoalTemplate({ objective: 'A reusable imported objective' });
  const second = bundle(), secondTarget = recipient();
  const secondReview = remember(previewLibraryImport(second.file, { cwd: secondTarget }));
  assert.equal(importLibraryBundle(secondReview, { cwd: secondTarget }).goals.length, 1);
  const row = listSavedGoals().goals[0], record = getGoalTemplate(row.id.slice('template:'.length));
  putRecord('core.goal.template', record.id, { ...record, objective: 'Tampered goal text' });
  assert.throws(() => getSavedGoal(row.id, { revision: row.revision }), { code: 'CONFLICT' });
  assert.equal(listRecords('session').length, 0);
});

test('resource path metadata cannot carry private account identifiers in source or rehashed receiver archives', () => {
  skill(); const safe = bundle();
  const privateNames = ['references/reader@account-fixture.invalid.txt', 'references/sk-' + 'q'.repeat(32) + '.txt'];
  for (const [index, privateName] of privateNames.entries()) {
    process.env.BZZY_HOME = path.join(directory, 'private-path-source-' + index);
    skill('unsafe-metadata', 'global', { [privateName]: 'Benign resource bytes.\n' });
    assert.throws(() => previewLibraryExport({ cwd }), { code: 'LIBRARY_BLOCKED_ENTRIES' });
  }
  const target = recipient();
  for (const privateName of privateNames) {
    const changed = rewrite(safe.file, files => {
      const manifest = JSON.parse(files['manifest.json']), item = manifest.skills[0];
      const resource = item.files.find(file => file.path === 'references/checks.txt');
      const prefix = `skills/${item.scope}/${item.name}/`;
      files[prefix + privateName] = files[prefix + resource.path]; delete files[prefix + resource.path];
      resource.path = privateName; item.version = digest(item.files);
      files['manifest.json'] = JSON.stringify(manifest);
    });
    assert.throws(() => previewLibraryImport(changed, { cwd: target }), /private|account|credential/);
  }
  assert.equal(listRecords('core.skill').length, 0); assert.equal(listRecords('core.library.import').length, 0);
});
