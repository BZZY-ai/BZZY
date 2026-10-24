import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codexSkillRoots, discoverCodexSkills, syncCodexSkills, skillSyncReport } from '../src/engine/skill-sync.js';
import { inspectSkill, setSkillEnabled, importSkill, readSkill, listSkills } from '../src/engine/skills.js';
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
