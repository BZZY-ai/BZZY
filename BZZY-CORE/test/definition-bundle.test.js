import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { home } from '../src/engine/files.js';
import { getRecord, putRecord, listRecords, digest, database } from '../src/engine/database.js';
import { importSkill, createSkill, inspectSkill, readSkill, setSkillEnabled, skillStorageId } from '../src/engine/skills.js';
import { saveSubagentDefinition, getSubagentDefinition, listSubagentDefinitions } from '../src/engine/subagent-definitions.js';
import { resolveProjectIdentity } from '../src/engine/project-identity.js';
import { previewDefinitionExport, exportDefinitionBundle, previewDefinitionImport, importDefinitionBundle,
  discardDefinitionBundleReview, readDefinitionBundleFile } from '../src/engine/definition-bundle.js';

let directory, project, sourceHome, previous, reviews;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-definition-bundle-')));
  sourceHome = path.join(directory, 'source-home'); process.env.BZZY_HOME = sourceHome;
  project = path.join(directory, 'project'); fs.mkdirSync(project); reviews = [];
});
test.afterEach(() => {
  for (const review of reviews) discardDefinitionBundleReview(review);
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function skill(name, scope = 'global', extra = {}) {
  const source = path.join(directory, 'packages', randomUUID()); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: Inspect supplied offline fixture records.\n---\nReview the supplied positive and negative controls. Preserve uncertainty.\n`);
  for (const [relative, data] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true }); fs.writeFileSync(path.join(source, relative), data); }
  return importSkill(source, { scope, projectRoot: project });
}
function agent(name, scope = 'global') {
  return saveSubagentDefinition({ name, description: 'Review supplied offline fixture records.', instructions: 'Compare the supplied controls. Report supported conclusions and uncertainty.',
    provider: 'deepseek', model: 'deepseek-flash', effort: 'low', policy: { mode: 'read-only', network: 'disabled' }, limits: { tokenBudget: 7000, runtimeSeconds: 90 } }, { cwd: project, scope });
}
function exportBundle(options = {}) { const review = previewDefinitionExport({ cwd: project, ...options }); reviews.push(review); return exportDefinitionBundle(review, { cwd: project }); }
function recipient() { const cwd = path.join(directory, 'recipient-' + randomUUID()); fs.mkdirSync(cwd); process.env.BZZY_HOME = path.join(directory, 'recipient-home-' + randomUUID()); return cwd; }
function preview(file, cwd) { const review = previewDefinitionImport(file, { cwd }); reviews.push(review); return review; }
function unzip(file) {
  const result = spawnSync('python3', ['-c', 'import base64,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z: print(json.dumps({i.filename:base64.b64encode(z.read(i)).decode() for i in z.infolist()}))', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return Object.fromEntries(Object.entries(JSON.parse(result.stdout)).map(([name, data]) => [name, Buffer.from(data, 'base64')]));
}
function zip(entries, label = randomUUID()) {
  const target = path.join(directory, label + '.zip');
  const rows = Array.isArray(entries) ? entries : Object.entries(entries).map(([name, data]) => ({ name, data }));
  const payload = rows.map(item => ({ ...item, data: Buffer.from(item.data).toString('base64') }));
  const result = spawnSync('python3', ['-c', 'import base64,json,stat,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for e in json.load(sys.stdin):\n  i=zipfile.ZipInfo(e["name"]);i.create_system=3;i.external_attr=e.get("mode",stat.S_IFREG|0o600)<<16;i.compress_type=zipfile.ZIP_DEFLATED;z.writestr(i,base64.b64decode(e["data"]))', target], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return target;
}
const records = kind => listRecords(kind).map(row => JSON.stringify(row)).sort();

test('a damaged registry inventory cannot export a ZIP that omits immutable package resources', () => {
  const installed = skill('complete-inventory', 'global', { 'references/required.txt': 'A required control.' });
  const saved = getRecord('core.skill', installed.id);
  putRecord('core.skill', installed.id, { ...saved, files: saved.files.filter(file => file.path === 'SKILL.md') });
  assert.throws(() => previewDefinitionExport({ cwd: project }), { code: 'STALE_REVIEW' });
  assert.equal(fs.readdirSync(project).some(file => file.endsWith('.zip')), false);
});

test('one reviewed ZIP preserves both scopes, complete immutable resources and portable agent selections without history or activation', () => {
  const binary = Buffer.from([0, 255, 3, 128, 9]);
  const local = skill('response-analysis', 'project', { 'references/checks.txt': 'Compare supplied controls.\n', 'scripts/check.py': 'print("offline fixture helper; never auto-execute")\n', 'assets/sample.bin': binary });
  skill('response-analysis', 'global'); agent('response-analyst', 'project'); agent('response-analyst', 'global');
  const other = path.join(directory, 'other-project'); fs.mkdirSync(other);
  createSkill({ name: 'unrelated-project', description: 'Unrelated project behavior.', instructions: 'Inspect only the supplied offline input.' }, { scope: 'project', projectRoot: other });
  const enabled = setSkillEnabled(local.id, true, local.revision, { projectRoot: project, scope: 'project' });
  putRecord('session', randomUUID(), { secretHistory: 'This private chat must never enter a definition ZIP.' });
  putRecord('core.agent', randomUUID(), { name: 'Persistent phone agent is excluded.' });
  const before = records('core.skill'), review = previewDefinitionExport({ cwd: project }); reviews.push(review);
  assert.deepEqual(review.totals, { skills: 2, agents: 2, files: 7, bytes: review.totals.bytes });
  assert.deepEqual(review.entries.filter(item => item.kind === 'agent')[0].selection, { provider: 'deepseek', model: 'deepseek-flash', effort: 'low' });
  assert.deepEqual(records('core.skill'), before); assert.equal(fs.existsSync(review.outputPath), false);
  const localIndex = review.entries.findIndex(item => item.kind === 'skill' && item.scope === 'project');
  assert.equal(readDefinitionBundleFile(review, { cwd: project, entryIndex: localIndex, file: 'assets/sample.bin' }).binary, true);
  assert.match(readDefinitionBundleFile(review, { cwd: project, entryIndex: localIndex, file: 'SKILL.md', limit: 25 }).text, /name/);
  const output = exportDefinitionBundle(review, { cwd: project }); assert.equal(path.dirname(output.path), project);
  const archive = unzip(output.path); assert.ok(archive['skills/project/response-analysis/scripts/check.py']);
  assert.deepEqual(archive['skills/project/response-analysis/assets/sample.bin'], binary);
  assert.doesNotMatch(Buffer.concat(Object.values(archive)).toString('utf8'), /secretHistory|Persistent phone|unrelated-project|source-home|projectId|enabled|revision|createdAt.*session/);
  const cwd = recipient(), imported = preview(output.path, cwd); assert.equal(imported.conflicts.length, 0);
  const agentIndex = imported.entries.findIndex(item => item.kind === 'agent');
  assert.match(readDefinitionBundleFile(imported, { cwd, entryIndex: agentIndex, file: 'definition.json' }).text, /"tokenBudget": 7000/);
  assert.equal(listRecords('core.skill').length, 0); assert.equal(listSubagentDefinitions({ cwd }).total, 0);
  const installed = importDefinitionBundle(imported, { cwd }); assert.equal(installed.skills.length, 2); assert.equal(installed.agents.length, 2);
  const restored = inspectSkill('response-analysis', { projectRoot: cwd, scope: 'project' });
  assert.equal(restored.version, enabled.version); assert.equal(restored.enabled, false);
  assert.equal(inspectSkill('response-analysis', { scope: 'global' }).enabled, false);
  assert.equal(readSkill(restored.id, { projectRoot: cwd, enabledOnly: false, file: 'references/checks.txt' }).text, 'Compare supplied controls.\n');
  const definition = getSubagentDefinition('response-analyst', { cwd, scope: 'project' });
  assert.equal(definition.provider, 'deepseek'); assert.equal(definition.model, 'deepseek-flash'); assert.equal(definition.effort, 'low');
  assert.deepEqual(definition.policy, { mode: 'read-only', network: 'disabled', writablePaths: [] });
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('assignment').length, 0);
});

test('import conflicts never overwrite even identical definitions, and reviewed skip imports only other names', () => {
  skill('existing-skill'); skill('new-skill', 'project'); agent('new-agent'); const output = exportBundle(), cwd = recipient();
  const existing = createSkill({ name: 'existing-skill', description: 'Keep the recipient behavior.', instructions: 'Keep the existing local implementation.' }, { scope: 'global' });
  const review = preview(output.path, cwd), before = records('core.skill');
  assert.deepEqual(review.conflicts, [{ kind: 'skill', name: 'existing-skill', scope: 'global' }]);
  assert.throws(() => importDefinitionBundle(review, { cwd }), { code: 'CONFLICT' });
  assert.deepEqual(records('core.skill'), before); assert.equal(listRecords('core.subagent.definition').length, 0);
  const result = importDefinitionBundle(review, { cwd, skipConflicts: true });
  assert.equal(result.skills.length, 1); assert.equal(result.agents.length, 1); assert.equal(result.skipped.length, 1);
  assert.equal(inspectSkill('existing-skill').version, existing.version);
  const again = preview(output.path, cwd); assert.equal(again.conflicts.length, 3);
  assert.throws(() => importDefinitionBundle(again, { cwd }), { code: 'CONFLICT' });
});

test('changed source revisions, Core homes, projects, destinations and tampered review objects require a new preview', () => {
  const item = skill('reviewed-skill'), first = previewDefinitionExport({ cwd: project }); reviews.push(first);
  setSkillEnabled(item.id, true, item.revision);
  assert.throws(() => exportDefinitionBundle(first, { cwd: project }), { code: 'STALE_REVIEW' }); assert.equal(fs.existsSync(first.outputPath), false);
  const review = previewDefinitionExport({ cwd: project }); reviews.push(review);
  assert.throws(() => exportDefinitionBundle({ ...review, totals: { ...review.totals, files: 0 } }, { cwd: project }), { code: 'STALE_REVIEW' });
  assert.throws(() => exportDefinitionBundle(review, { cwd: project, outputPath: path.join(project, 'another.zip') }), { code: 'STALE_REVIEW' });
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  assert.throws(() => exportDefinitionBundle(review, { cwd: other }), { code: 'STALE_REVIEW' });
  process.env.BZZY_HOME = path.join(directory, 'another-home');
  assert.throws(() => exportDefinitionBundle(review, { cwd: project }), { code: 'STALE_REVIEW' });
});

test('publication is no-overwrite for regular and dangling-link outputs, and default previews have distinct tracked stages', () => {
  skill('safe-skill'); const stages = [];
  for (let i = 0; i < 20; i++) { const review = previewDefinitionExport({ cwd: project, outputPath: 'same-reviewed.zip' }); reviews.push(review); stages.push(review.id); }
  assert.equal(new Set(stages).size, 20); assert.equal(fs.readdirSync(path.join(home(), 'definition-bundles')).length, 16);
  const review = reviews.at(-1), sentinel = Buffer.from('Existing file kept.'); fs.writeFileSync(review.outputPath, sentinel);
  assert.throws(() => exportDefinitionBundle(review, { cwd: project }), /destination already exists/); assert.deepEqual(fs.readFileSync(review.outputPath), sentinel);
  fs.unlinkSync(review.outputPath); fs.symlinkSync(path.join(directory, 'missing-target'), review.outputPath);
  assert.throws(() => exportDefinitionBundle(review, { cwd: project }), /destination already exists/); assert.equal(fs.lstatSync(review.outputPath).isSymbolicLink(), true);
  const a = previewDefinitionExport({ cwd: project }), b = previewDefinitionExport({ cwd: project }); reviews.push(a, b);
  assert.notEqual(a.outputPath, b.outputPath);
});

test('expired crash stages are cleaned on preview while fresh reviews remain private and intact', () => {
  skill('safe-skill'); const review = previewDefinitionExport({ cwd: project }); reviews.push(review);
  const parent = path.join(home(), 'definition-bundles'), old = path.join(parent, '.review-old123'), fresh = path.join(parent, '.review-new123');
  for (const target of [old, fresh]) { fs.mkdirSync(target, { mode: 0o700 }); fs.writeFileSync(path.join(target, 'private-stage.txt'), 'Reviewed generic behavior.'); }
  const expired = new Date(Date.now() - 31 * 60 * 1000); fs.utimesSync(old, expired, expired);
  const next = previewDefinitionExport({ cwd: project }); reviews.push(next);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(fresh), true);
  assert.match(readDefinitionBundleFile(review, { cwd: project, entryIndex: 0, file: 'SKILL.md' }).text, /safe-skill/);
});

test('normal process exit removes its review staging without deleting installed definitions', () => {
  const module = new URL('../src/engine/definition-bundle.js', import.meta.url).href, skills = new URL('../src/engine/skills.js', import.meta.url).href;
  const isolated = path.join(directory, 'exit-home');
  const code = `import{createSkill}from${JSON.stringify(skills)};import{previewDefinitionExport}from${JSON.stringify(module)};createSkill({name:'exit-skill',description:'Inspect supplied inputs.',instructions:'Inspect the supplied offline input.'},{scope:'global'});previewDefinitionExport({cwd:process.argv[1]});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, project], { encoding: 'utf8', env: { ...process.env, BZZY_HOME: isolated } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readdirSync(path.join(isolated, 'definition-bundles')).length, 0);
  assert.ok(fs.readdirSync(path.join(isolated, 'skills', 'exit-skill')).length);
});

test('literal credentials, private binding files, project case evidence and symbolic resource links fail closed', () => {
  for (const [index, body] of ['password: fixture-private-value', 'API_KEY=fixture-private-value', 'password="fixture-private-value"', 'email: person@private.example',
    '{"api_key":["fixture-private-value"]}', '{"authorization":{"value":"fixture-private-value"}}', 'token: fixture-private-value', 'OAUTH_TOKEN=fixture-private-value',
    'client.api_key = "fixture-private-value"', 'config["api_key"] = "fixture-private-value"'].entries()) {
    const item = skill(`unsafe-${index}`, 'project', { 'references/example.txt': body });
    assert.throws(() => previewDefinitionExport({ cwd: project }), new RegExp(item.name));
    database().prepare("DELETE FROM records WHERE kind='core.skill' AND id=?").run(item.id);
  }
  const item = skill('private-case', 'project', { 'references/run-records.jsonl': '{"observation":"private case"}\n' });
  assert.throws(() => previewDefinitionExport({ cwd: project }), /private-case.*private case/);
  database().prepare("DELETE FROM records WHERE kind='core.skill' AND id=?").run(item.id);
  const binding = skill('private-binding-file', 'project', { 'references/service-credentials.json': '{"value":"private account configuration"}' });
  assert.throws(() => previewDefinitionExport({ cwd: project }), /private-binding-file.*private case/);
  database().prepare("DELETE FROM records WHERE kind='core.skill' AND id=?").run(binding.id);
  const safe = skill('linked-resource', 'global', { 'references/guide.txt': 'A generic method.' });
  const raw = getRecord('core.skill', safe.id), file = path.join(home(), 'skills', safe.name, raw.version, 'references/guide.txt');
  fs.unlinkSync(file); fs.symlinkSync(path.join(directory, 'outside'), file);
  assert.throws(() => previewDefinitionExport({ cwd: project }), /linked-resource.*safe, intact/);
});

test('placeholder configuration references remain portable while scripts and files are never executed', () => {
  const marker = path.join(directory, 'must-not-run');
  skill('placeholder-skill', 'global', { 'references/config.txt': 'API_KEY=${API_KEY}\npassword: <private-binding>\n',
    'references/schema.json': '{"properties":{"password":{"type":"string","description":"Use a private runtime binding."}}}',
    'scripts/never-run.py': 'raise RuntimeError("Importing a skill must never run its script")\n' });
  const output = exportBundle(), cwd = recipient(); importDefinitionBundle(preview(output.path, cwd), { cwd });
  assert.equal(fs.existsSync(marker), false); assert.equal(listRecords('execution').length, 0);
});

test('ZIP traversal, symlinks, duplicates, excess bytes and unmanifested resources are rejected before registry changes', () => {
  skill('safe-skill'); const output = exportBundle(), original = unzip(output.path), cwd = recipient();
  const entries = Object.entries(original).map(([name, data]) => ({ name, data }));
  const malformed = [
    [...entries, { name: '../outside.txt', data: 'escape' }],
    [...entries, { name: 'links/private', data: 'outside', mode: 0o120777 }],
    [...entries, { name: 'MANIFEST.JSON', data: original['manifest.json'] }],
    [...entries, { name: 'extra.txt', data: 'Not in the manifest.' }],
    [...entries, { name: 'oversize.txt', data: Buffer.alloc(1024 * 1024 + 1) }],
  ];
  for (const archive of malformed) assert.throws(() => previewDefinitionImport(zip(archive), { cwd }));
  assert.equal(listRecords('core.skill').length, 0); assert.equal(listRecords('core.subagent.definition').length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'outside.txt')), false);
});

test('manifest hashes, exact schemas and agent policies are revalidated and private binding data cannot be smuggled into a modified ZIP', () => {
  skill('safe-skill'); agent('safe-agent'); const output = exportBundle(), original = unzip(output.path), cwd = recipient();
  const manifest = JSON.parse(original['manifest.json']);
  for (const edit of [value => { value.skills[0].files[0].sha256 = '0'.repeat(64); }, value => { value.providers = { unsafe: { baseUrl: 'https://invalid.example' } }; }]) {
    const changed = structuredClone(manifest); edit(changed);
    assert.throws(() => previewDefinitionImport(zip({ ...original, 'manifest.json': Buffer.from(JSON.stringify(changed)) }), { cwd }));
  }
  const changed = structuredClone(manifest), agentFile = changed.agents[0].file;
  const definition = JSON.parse(original[agentFile]); definition.policy.mode = 'full-access';
  const data = Buffer.from(JSON.stringify(definition)); Object.assign(changed.agents[0], { bytes: data.length, sha256: digest(data), version: digest(definition) });
  assert.throws(() => previewDefinitionImport(zip({ ...original, [agentFile]: data, 'manifest.json': Buffer.from(JSON.stringify(changed)) }), { cwd }));
  assert.equal(listRecords('core.skill').length, 0); assert.equal(listRecords('core.subagent.definition').length, 0);
});

test('changed archives and late destination conflicts fail before any definition is imported', () => {
  skill('first-skill'); skill('second-skill', 'project'); const output = exportBundle(), cwd = recipient(), review = preview(output.path, cwd);
  const installed = createSkill({ name: 'second-skill', description: 'Keep this new local definition.', instructions: 'Keep local behavior.' }, { scope: 'project', projectRoot: cwd });
  assert.throws(() => importDefinitionBundle(review, { cwd }), { code: 'STALE_REVIEW' });
  assert.equal(listRecords('core.skill').length, 1); assert.equal(inspectSkill(installed.id, { projectRoot: cwd }).version, installed.version);
  const next = preview(output.path, cwd); fs.appendFileSync(output.path, 'changed');
  assert.throws(() => importDefinitionBundle(next, { cwd, skipConflicts: true }), { code: 'STALE_REVIEW' });
  assert.equal(listRecords('core.skill').length, 1);
});

test('a failure after skill materialization rolls back all registry/history changes and removes only this operation’s new version directory', () => {
  const exported = skill('first-skill'); agent('last-agent'); const output = exportBundle(), cwd = recipient();
  for (let index = 0; index < 512; index++) putRecord('core.subagent.definition', digest(['capacity', index]), { name: `reserved-${index}`, scope: 'global', revision: 1 });
  const before = records('core.subagent.definition'), review = preview(output.path, cwd);
  const target = path.join(home(), 'skills', 'first-skill', exported.version);
  assert.throws(() => importDefinitionBundle(review, { cwd }), /host subagent definition limit/);
  assert.equal(listRecords('core.skill').length, 0); assert.equal(listRecords('core.skill.version').length, 0); assert.equal(listRecords('core.skill.history').length, 0);
  assert.equal(fs.existsSync(target), false); assert.deepEqual(records('core.subagent.definition'), before);
});

test('an existing historical content directory is checked before reuse and is never overwritten or deleted on failure', () => {
  const original = skill('historical-skill'), output = exportBundle(), cwd = recipient();
  const first = importDefinitionBundle(preview(output.path, cwd), { cwd }).skills[0];
  database().prepare("DELETE FROM records WHERE kind='core.skill' AND id=?").run(first.id);
  const target = path.join(home(), 'skills', first.name, original.version, 'SKILL.md');
  const changed = 'Unreviewed historical bytes must stay untouched.'; fs.writeFileSync(target, changed);
  const versions = records('core.skill.version'), history = records('core.skill.history'), review = preview(output.path, cwd);
  assert.equal(review.conflicts.length, 0);
  assert.throws(() => importDefinitionBundle(review, { cwd }));
  assert.equal(getRecord('core.skill', first.id), null); assert.equal(fs.readFileSync(target, 'utf8'), changed);
  assert.deepEqual(records('core.skill.version'), versions); assert.deepEqual(records('core.skill.history'), history);
});

test('a file replaced at the archive publication boundary is not advertised as the reviewed ZIP or deleted', () => {
  skill('safe-skill'); const review = previewDefinitionExport({ cwd: project }); reviews.push(review);
  const original = childProcess.spawnSync, replacement = Buffer.from('A different file at the output path.');
  childProcess.spawnSync = (...args) => {
    const result = original(...args);
    if (args[0] === 'python3' && args[1][0].endsWith('definition-archive.py') && JSON.parse(args[2].input).operation === 'create' && result.status === 0) {
      fs.unlinkSync(review.outputPath); fs.writeFileSync(review.outputPath, replacement);
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => exportDefinitionBundle(review, { cwd: project }), { code: 'STALE_REVIEW' });
    assert.deepEqual(fs.readFileSync(review.outputPath), replacement);
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test('case-colliding resource names cannot create an export that another supported filesystem rejects', t => {
  const probe = path.join(directory, 'case-probe'); fs.mkdirSync(probe); fs.writeFileSync(path.join(probe, 'Guide.md'), 'one'); fs.writeFileSync(path.join(probe, 'guide.md'), 'two');
  if (fs.readdirSync(probe).length !== 2) { t.skip('The local filesystem already rejects distinct case-colliding resources.'); return; }
  skill('case-sensitive-skill', 'global', { 'references/Guide.md': 'One reference.', 'references/guide.md': 'A different reference.' });
  assert.throws(() => previewDefinitionExport({ cwd: project }), /collide/);
});

test('reviewed file pages are scoped, immutable and UTF-8 bounded, and disappearing storage links never escape the library', () => {
  skill('reviewed-skill', 'project', { 'references/long.txt': '🐝你abc\n'.repeat(1000) }); const output = exportBundle(), cwd = recipient(), review = preview(output.path, cwd);
  let offset = 0, text = '';
  do { const page = readDefinitionBundleFile(review, { cwd, entryIndex: 0, file: 'references/long.txt', offset, limit: 97 }); assert.equal(page.binary, false); text += page.text; offset = page.nextOffset; } while (offset !== null);
  assert.equal(text, '🐝你abc\n'.repeat(1000));
  assert.throws(() => readDefinitionBundleFile(review, { cwd, entryIndex: 0, file: '../private' }));
  assert.throws(() => readDefinitionBundleFile(review, { cwd, entryIndex: 0, file: 'unlisted.txt' }));
  const outside = path.join(directory, 'outside-library'); fs.mkdirSync(outside); fs.mkdirSync(path.join(home(), 'skills'), { recursive: true });
  const projectId = resolveProjectIdentity(cwd).id; fs.mkdirSync(path.join(home(), 'skills', '_projects'), { recursive: true });
  fs.symlinkSync(outside, path.join(home(), 'skills', '_projects', digest(projectId)));
  assert.throws(() => importDefinitionBundle(review, { cwd }), /storage contains a link/);
  assert.equal(fs.readdirSync(outside).length, 0); assert.equal(listRecords('core.skill').length, 0);
});
