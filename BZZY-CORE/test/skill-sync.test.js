import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSkillRoots, discoverCodexSkills, syncCodexSkills, skillSyncReport, previewCodexSkills, importCodexSkills } from '../src/engine/skill-sync.js';
import { inspectSkill, setSkillEnabled, importSkill, readSkill, listSkills, createSkill } from '../src/engine/skills.js';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { conversationPrompt } from '../src/engine/conversation.js';
import { listRecords } from '../src/engine/database.js';

let directory, options, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-sync-')));
  const project = path.join(directory, 'project'), cwd = path.join(project, 'packages', 'app'); fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(project, '.git'));
  options = { cwd, userHome: path.join(directory, 'user'), codexHome: path.join(directory, 'configured-codex'), bzzyCodexHome: null,
    adminRoot: path.join(directory, 'etc', 'codex', 'skills'), platform: 'linux' };
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function skill(root, name, body = 'Read references/check.txt and report the findings.', folder = name) {
  const target = path.join(root, folder); fs.mkdirSync(path.join(target, 'references'), { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  Review this project with the shared workflow.\n---\n${body}\n`);
  fs.writeFileSync(path.join(target, 'references', 'check.txt'), 'Inspect actual changes and cite evidence.');
  return target;
}

test('macOS and Linux discovery includes project ancestors to the repository boundary and both user skill locations', () => {
  for (const platform of ['linux', 'darwin']) {
    const roots = codexSkillRoots({ ...options, platform });
    assert.deepEqual(roots.filter(root => root.scope === 'project').map(root => root.path), [options.cwd, path.dirname(options.cwd), path.join(directory, 'project')].map(root => path.join(root, '.agents', 'skills')));
    assert.ok(roots.some(root => root.path === path.join(options.userHome, '.agents', 'skills')));
    assert.ok(roots.some(root => root.path === path.join(options.userHome, '.codex', 'skills')));
    assert.ok(roots.some(root => root.path === path.join(options.codexHome, 'skills')));
    assert.ok(roots.some(root => root.path === options.adminRoot));
  }
  assert.throws(() => codexSkillRoots({ ...options, platform: 'win32' }), /macOS and Linux/);
  const outside = skill(path.join(directory, '.agents', 'skills'), 'outside-repository');
  assert.equal(discoverCodexSkills(options).candidates.some(item => item.source === outside), false);
});

test('sync copies complete packages from project, user, configured, legacy/system and machine roots without executing helpers', () => {
  for (const [root, name] of [[path.join(options.cwd, '.agents', 'skills'), 'project-skill'], [path.join(options.userHome, '.agents', 'skills'), 'user-skill'],
    [path.join(options.codexHome, 'skills'), 'configured-skill'], [path.join(options.userHome, '.codex', 'skills', '.system'), 'system-skill'], [options.adminRoot, 'admin-skill']]) skill(root, name);
  const source = path.join(options.cwd, '.agents', 'skills', 'project-skill');
  fs.mkdirSync(path.join(source, 'agents')); fs.writeFileSync(path.join(source, 'agents', 'openai.yaml'), 'interface:\n  display_name: Shared review\n');
  const marker = path.join(directory, 'unexpected-execution');
  fs.mkdirSync(path.join(source, 'scripts')); fs.writeFileSync(path.join(source, 'scripts', 'run.sh'), `#!/bin/sh\ntouch "${marker}"\n`);
  const first = syncCodexSkills(options); assert.equal(first.imported, 5); assert.equal(first.rejected, 0);
  assert.equal(listSkills().total, 5); assert.equal(listSkills({ enabledOnly: true }).total, 0);
  const copied = inspectSkill('project-skill'); assert.ok(copied.files.some(file => file.path === 'agents/openai.yaml'));
  assert.match(readSkill(copied.name, { file: 'scripts/run.sh', enabledOnly: false }).text, /unexpected-execution/);
  assert.equal(fs.existsSync(marker), false);
  const enabled = setSkillEnabled(copied.name, true, copied.revision);
  const second = syncCodexSkills(options); assert.equal(second.unchanged, 5); assert.equal(second.imported, 0);
  assert.equal(inspectSkill(copied.name).revision, enabled.revision); assert.equal(inspectSkill(copied.name).enabled, true);
  const report = skillSyncReport(second); assert.equal(JSON.stringify(report).includes(directory), false);
  assert.equal(listRecords('execution').length, 0);
});

test('sync updates only its own unchanged library copies, disables changed instructions for review, and keeps local changes/deletions', () => {
  const root = path.join(options.userHome, '.agents', 'skills'), source = skill(root, 'update-skill');
  syncCodexSkills(options); let saved = inspectSkill('update-skill'); saved = setSkillEnabled(saved.name, true, saved.revision);
  fs.writeFileSync(path.join(source, 'references', 'check.txt'), 'Updated checklist.');
  const oldVersion = saved.version, changed = syncCodexSkills(options); assert.equal(changed.updated, 1);
  saved = inspectSkill(saved.name); assert.equal(saved.enabled, false); assert.notEqual(saved.version, oldVersion);
  assert.equal(readSkill(saved.name, { file: 'references/check.txt', enabledOnly: false }).text, 'Updated checklist.');
  const local = skill(path.join(directory, 'local'), saved.name, 'Locally customized BZZY instructions.');
  importSkill(local, { expectedRevision: saved.revision });
  const conflict = syncCodexSkills(options); assert.equal(conflict.conflicts, 1);
  assert.match(readSkill(saved.name, { enabledOnly: false }).text, /Locally customized/);
  fs.rmSync(source, { recursive: true }); syncCodexSkills(options);
  assert.match(readSkill(saved.name, { enabledOnly: false }).text, /Locally customized/);
});

test('preview never installs a skill and a changed source cannot replace the previewed package', () => {
  const source = skill(path.join(options.userHome, '.agents', 'skills'), 'preview-skill');
  const preview = importSkill(source, { preview: true });
  assert.equal(listSkills().total, 0); assert.equal(preview.enabled, false);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'skills')), []);
  fs.writeFileSync(path.join(source, 'references', 'check.txt'), 'Changed since preview.');
  assert.throws(() => importSkill(source, { expectedVersion: preview.version }), /source changed/);
  assert.equal(listSkills().total, 0);
  fs.writeFileSync(path.join(source, 'SKILL.md'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => importSkill(source, { preview: true }), /UTF-8 Markdown/);
  assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'skills')), []);
});

test('duplicate names are reported without merging, and invalid/linked/secret packages do not interrupt valid imports', () => {
  const project = path.join(options.cwd, '.agents', 'skills'), user = path.join(options.userHome, '.agents', 'skills');
  skill(project, 'duplicate-skill', 'Project instructions.'); skill(user, 'duplicate-skill', 'Different user instructions.');
  skill(path.join(options.codexHome, 'skills'), 'duplicate-skill', 'Project instructions.');
  skill(options.adminRoot, 'duplicate-skill', 'Different user instructions.');
  const unsafe = skill(user, 'unsafe-skill'); fs.writeFileSync(path.join(unsafe, 'binding.txt'), 'sk-' + 'fixturesecret'.repeat(3));
  const target = skill(path.join(directory, 'links'), 'linked-skill'); fs.symlinkSync(target, path.join(user, 'linked-skill'));
  const malformed = skill(user, 'malformed'); fs.writeFileSync(path.join(malformed, 'SKILL.md'), 'no metadata');
  const result = syncCodexSkills(options); assert.equal(result.imported, 2); assert.equal(result.conflicts, 1); assert.equal(result.duplicates, 1); assert.equal(result.rejected, 2); assert.equal(result.unavailable, 1);
  assert.match(readSkill('duplicate-skill', { enabledOnly: false, projectRoot: options.cwd }).text, /Project instructions/);
  assert.match(readSkill('duplicate-skill', { enabledOnly: false, scope: 'global' }).text, /Different user instructions/);
  assert.equal(JSON.stringify(skillSyncReport(result)).includes('fixturesecret'), false);
});

test('one synced workflow and its references are available unchanged to different models on every supported provider', async () => {
  skill(path.join(options.userHome, '.agents', 'skills'), 'cross-model-review'); syncCodexSkills(options);
  const saved = inspectSkill('cross-model-review'); setSkillEnabled(saved.name, true, saved.revision);
  const bodies = new Set();
  for (const provider of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter']) for (const model of ['first-selected-model', 'another-selected-model']) {
    const session = createSession(getProvider(provider), directory, model), host = new ToolHost(session, { event() {} });
    assert.ok(taskTools(session).some(tool => tool.name === 'read_skill'));
    assert.equal((await host.call('list_skills', {})).skills[0].name, saved.name);
    bodies.add((await host.call('read_skill', { name: saved.name })).text);
    assert.match((await host.call('read_skill', { name: saved.name, file: 'references/check.txt' })).text, /cite evidence/);
    assert.match(conversationPrompt(session, '$cross-model-review inspect this change'), /provider-independent library for every model/);
  }
  assert.equal(bodies.size, 1); assert.equal(listSkills().total, 1); assert.equal(listRecords('execution').length, 0);
});

const byName = result => new Map(result.results.map(item => [item.name, item]));
const pick = (result, ...names) => result.results.filter(item => names.includes(item.name)).map(({ sourceId, version }) => ({ sourceId, version }));

test('a Codex scan lists every local skill with its location and import status without installing anything', () => {
  const project = path.join(directory, 'project');
  skill(path.join(options.cwd, '.agents', 'skills'), 'project-skill');
  skill(path.join(options.userHome, '.agents', 'skills'), 'user-skill');
  skill(path.join(options.codexHome, 'skills'), 'configured-skill');
  skill(path.join(options.userHome, '.codex', 'skills', '.system'), 'system-skill');
  const underscore = skill(path.join(options.userHome, '.codex', 'skills'), 'under_score_skill');
  const malformed = skill(path.join(options.userHome, '.codex', 'skills'), 'malformed'); fs.writeFileSync(path.join(malformed, 'SKILL.md'), 'no metadata');
  const scan = previewCodexSkills(options), items = byName(scan);
  assert.deepEqual([...items.keys()].sort(), ['configured-skill', 'malformed', 'project-skill', 'system-skill', 'under-score-skill', 'user-skill']);
  for (const name of ['project-skill', 'user-skill', 'configured-skill', 'system-skill', 'under-score-skill']) assert.equal(items.get(name).status, 'new', name);
  assert.equal(items.get('malformed').status, 'rejected');
  assert.deepEqual(Object.fromEntries([...items].filter(([name]) => name !== 'malformed').map(([name, item]) => [name, item.label])), {
    'project-skill': 'this project', 'user-skill': '~/.agents', 'configured-skill': '$CODEX_HOME', 'system-skill': 'Codex system', 'under-score-skill': '~/.codex' });
  assert.equal(items.get('project-skill').target, 'project'); assert.equal(items.get('user-skill').target, 'global');
  assert.equal(items.get('under-score-skill').rawName, 'under_score_skill');
  assert.equal(items.get('system-skill').system, true);
  assert.equal(listSkills().total, 0); assert.equal(listRecords('core.skill.codex-sync').length, 0);
  assert.equal(fs.existsSync(path.join(project, '.bzzy')) || fs.existsSync(path.join(options.cwd, '.bzzy')), false, 'a scan never creates project identity state');
  assert.match(fs.readFileSync(path.join(underscore, 'SKILL.md'), 'utf8'), /name: under_score_skill/);
  assert.equal(JSON.stringify(skillSyncReport(scan)).includes(directory), false);
});

test('a selective Codex import installs only checked skills, disabled, and later scans report their state', () => {
  const user = path.join(options.userHome, '.agents', 'skills'), configured = path.join(options.codexHome, 'skills');
  const source = skill(user, 'user-skill'); skill(configured, 'configured-skill');
  const underscore = skill(path.join(options.userHome, '.codex', 'skills'), 'under_score_skill');
  let scan = previewCodexSkills(options);
  const result = importCodexSkills(pick(scan, 'user-skill', 'under-score-skill'), options);
  assert.equal(result.imported, 2, JSON.stringify(result)); assert.equal(result.results.length, 2, 'only checked skills are reported');
  assert.equal(inspectSkill('user-skill').enabled, false); assert.equal(inspectSkill('under-score-skill').enabled, false);
  assert.throws(() => inspectSkill('configured-skill'), /not found/);
  assert.match(readSkill('under-score-skill', { enabledOnly: false }).text, /name: under-score-skill/);
  assert.match(fs.readFileSync(path.join(underscore, 'SKILL.md'), 'utf8'), /name: under_score_skill/, 'the Codex folder is untouched');
  assert.equal(fs.readdirSync(path.join(process.env.BZZY_HOME, 'skills')).some(name => name.startsWith('.')), false, 'staging is cleaned up');

  scan = previewCodexSkills(options); let items = byName(scan);
  assert.equal(items.get('user-skill').status, 'unchanged'); assert.equal(items.get('under-score-skill').status, 'unchanged');
  assert.equal(items.get('configured-skill').status, 'new');

  // The managed copy updates for review; an independent BZZY skill is never replaced.
  const enabled = inspectSkill('user-skill'); setSkillEnabled(enabled.id, true, enabled.revision);
  fs.writeFileSync(path.join(source, 'references', 'check.txt'), 'Updated checklist.');
  createSkill({ name: 'configured-skill', description: 'Independent BZZY skill.', instructions: 'Keep this BZZY copy.' }, { scope: 'global' });
  scan = previewCodexSkills(options); items = byName(scan);
  assert.equal(items.get('user-skill').status, 'update');
  assert.equal(items.get('configured-skill').status, 'conflict'); assert.equal(items.get('configured-skill').conflictWith, 'library');
  const second = importCodexSkills(pick(scan, 'user-skill', 'configured-skill'), options);
  assert.equal(second.updated, 1); assert.equal(second.conflicts, 1);
  assert.equal(inspectSkill('user-skill').enabled, false, 'a changed package needs review again');
  assert.match(readSkill('configured-skill', { enabledOnly: false }).text, /Keep this BZZY copy/);
});

test('a Codex import never installs a package that changed or disappeared after the scan', () => {
  const user = path.join(options.userHome, '.agents', 'skills');
  const changed = skill(user, 'changed-skill'), removed = skill(user, 'removed-skill');
  const scan = previewCodexSkills(options);
  fs.writeFileSync(path.join(changed, 'references', 'check.txt'), 'Changed after the scan.');
  fs.rmSync(removed, { recursive: true });
  const result = importCodexSkills(pick(scan, 'changed-skill', 'removed-skill'), options);
  assert.equal(result.imported, 0); assert.equal(result.rejected, 2);
  assert.ok(result.results.some(item => item.status === 'rejected' && /changed/i.test(item.reason)));
  assert.ok(result.results.some(item => item.status === 'rejected' && /no longer available/i.test(item.reason)));
  assert.equal(listSkills().total, 0);
  for (const invalid of [[], [{ sourceId: 'x', version: 'y' }], 'all', null]) assert.throws(() => importCodexSkills(invalid, options), /current scan/);
});

test('project discoveries import into this project only when checked, and another folder is scanned without rescoping standard ones', () => {
  const extra = path.join(directory, 'copied-codex', 'skills');
  skill(path.join(options.cwd, '.agents', 'skills'), 'project-skill'); skill(extra, 'copied-skill');
  const userRoot = path.join(options.userHome, '.agents', 'skills'); skill(userRoot, 'user-skill');
  const scan = previewCodexSkills({ ...options, extraRoots: [extra, userRoot] }), items = byName(scan);
  assert.equal(items.get('copied-skill').label, 'other folder'); assert.equal(items.get('copied-skill').target, 'global');
  assert.equal(items.get('user-skill').label, '~/.agents', 'a standard location keeps its own label');
  const result = importCodexSkills(pick(scan, 'project-skill', 'copied-skill'), { ...options, extraRoots: [extra] });
  assert.equal(result.imported, 2, JSON.stringify(result));
  assert.equal(inspectSkill('project-skill', { projectRoot: options.cwd, scope: 'project' }).scope, 'project');
  assert.equal(inspectSkill('copied-skill', { scope: 'global' }).scope, 'global');
  assert.equal(fs.existsSync(path.join(options.cwd, '.bzzy', 'project.json')), true, 'importing a project skill initializes its project');
  assert.throws(() => inspectSkill('user-skill'), /not found/);
});
