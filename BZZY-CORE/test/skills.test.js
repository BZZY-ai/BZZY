import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSkill, listSkills, readSkill, importSkill, setSkillEnabled, skillCatalogInstructions } from '../src/engine/skills.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { ToolHost, taskTools } from '../src/engine/tools.js';
import { conversationPrompt } from '../src/engine/conversation.js';
import { enqueueExecution } from '../src/engine/execution-queue.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skills-test-'));
process.env.BZZY_HOME = path.join(directory, 'private');
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('one durable library exposes the same enabled workflow to every provider', async () => {
 let skill = createSkill({ name: 'review-code', description: 'Review code with a checklist.', instructions: 'Read the changed files. Explain the findings and verify the result.' });
 assert.equal(skill.enabled, false); assert.equal(listSkills({ enabledOnly: true }).total, 0);
 assert.throws(() => readSkill(skill.name), /disabled/);
 skill = setSkillEnabled(skill.name, true, skill.revision);
 assert.throws(() => setSkillEnabled(skill.name, false, 1), /changed/);
 for (const provider of ['codex', 'claude', 'deepseek', 'abliteration', 'orcarouter']) {
  const session = createSession(getProvider(provider), directory), host = new ToolHost(session, { event() {} });
  assert.ok(taskTools(session).some(tool => tool.name === 'read_skill'));
  assert.equal((await host.call('list_skills', {})).skills[0].name, skill.name);
  assert.match((await host.call('read_skill', { name: skill.name })).text, /Read the changed files/);
  assert.match(conversationPrompt(session, 'Review this'), /review-code/);
  assert.equal(taskTools(session).some(tool => tool.name === 'set_skill_enabled'), false);
 }
 assert.match(skillCatalogInstructions(), /untrusted workflow guidance/);
 setSkillEnabled(skill.name, false, skill.revision); assert.throws(() => readSkill(skill.name), /disabled/);
});

test('folder references have UTF-8 pagination, immutable hashes and disabled replacement', () => {
 const folder = path.join(directory, 'source'); fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: references-test\ndescription: >\n  Read references when reviewing.\n---\nRead references/check.txt.');
 fs.mkdirSync(path.join(folder, 'references')); fs.writeFileSync(path.join(folder, 'references/check.txt'), 'abcédef');
 let skill = importSkill(folder); assert.throws(() => importSkill(folder), /exists or changed/);
 skill = setSkillEnabled(skill.name, true, skill.revision);
 const first = readSkill(skill.name, { file: 'references/check.txt', limit: 4 });
 assert.equal(first.text, 'abc'); assert.equal(first.nextOffset, 3);
 assert.equal(readSkill(skill.name, { file: 'references/check.txt', offset: 3 }).text, 'édef');
 assert.throws(() => readSkill(skill.name, { file: '../credentials.json' }), /Invalid/);
 fs.writeFileSync(path.join(process.env.BZZY_HOME, 'skills', skill.name, skill.version, 'references/check.txt'), 'tampered');
 assert.throws(() => readSkill(skill.name, { file: 'references/check.txt' }), /changed outside Core/);
 fs.writeFileSync(path.join(folder, 'references/check.txt'), 'new reference');
 const replacement = importSkill(folder, { expectedRevision: skill.revision });
 assert.equal(replacement.enabled, false); assert.notEqual(replacement.version, skill.version);
 assert.throws(() => readSkill(skill.name, { version: skill.version }), /disabled or version changed/);
});

test('folder and ZIP imports reject credentials, links, traversal, oversized files and duplicates', () => {
 const folder = path.join(directory, 'unsafe'); fs.mkdirSync(folder);
 fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: unsafe-test\ndescription: Unsafe fixture.\n---\nDo nothing.');
 fs.symlinkSync('/etc/passwd', path.join(folder, 'link')); assert.throws(() => importSkill(folder), /unsafe/); fs.unlinkSync(path.join(folder, 'link'));
 fs.writeFileSync(path.join(folder, '.env'), 'SECRET=private'); assert.throws(() => importSkill(folder), /unsafe/); fs.unlinkSync(path.join(folder, '.env'));
 fs.writeFileSync(path.join(folder, 'secret.txt'), 'sk-' + 'fakefixture'.repeat(4)); assert.throws(() => importSkill(folder), /credential/); fs.unlinkSync(path.join(folder, 'secret.txt'));
 fs.writeFileSync(path.join(folder, 'large.txt'), Buffer.alloc(1024 * 1024 + 1)); assert.throws(() => importSkill(folder), /bounded regular/);
 for (const mode of ['valid', 'traversal', 'link', 'duplicate']) {
  const zip = path.join(directory, mode + '.zip');
  const made = spawnSync('python3', ['-c', `import zipfile,sys,stat\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('bundle/SKILL.md','---\\nname: zip-test\\ndescription: ZIP fixture.\\n---\\nFollow the workflow.')\n if sys.argv[2]=='traversal': z.writestr('../outside.txt','no')\n if sys.argv[2]=='link':\n  i=zipfile.ZipInfo('bundle/link'); i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'/etc/passwd')\n if sys.argv[2]=='duplicate': z.writestr('bundle/SKILL.md','duplicate')`, zip, mode]);
  assert.equal(made.status, 0);
  if (mode === 'valid') assert.equal(importSkill(zip).name, 'zip-test'); else assert.throws(() => importSkill(zip), /Invalid skill ZIP/);
 }
 assert.equal(fs.existsSync(path.join(directory, 'outside.txt')), false);
});

test('unset terminal cannot enqueue inference through any client', () => {
 const session = createSession(getProvider('codex'), directory); session.modelSelectionRequired = true; saveSession(session);
 assert.throws(() => enqueueExecution(session.id, { prompt: 'hello' }, 'unset-selection', { authorize() {} }), /Select a model/);
});
