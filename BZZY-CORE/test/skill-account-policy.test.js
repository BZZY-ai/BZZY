import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { getSkillSignupAliases, setSkillSignupAliases, clearSkillSignupAliases } from '../src/engine/skill-account-policy.js';
import { createSkill, setSkillEnabled, readSkill, deleteSkill } from '../src/engine/skills.js';
import { ToolHost, taskTools, bridgeRequest } from '../src/engine/tools.js';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { listRecords, putRecord, events } from '../src/engine/database.js';
import { readJson, writeJson } from '../src/engine/files.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';
import { previewLibraryExport, buildLibraryArchive, previewLibraryImport, importLibraryBundle, discardDefinitionBundleReview } from '../src/engine/definition-bundle.js';

const aliases = ['fixture+1@example.invalid', 'fixture+2@example.invalid', 'fixture+3@example.invalid', 'fixture+4@example.invalid'];
const provider = { id: 'codex', backend: 'codex' };
let directory, cwd, previous, config;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-skill-account-policy-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  config = path.join(process.env.BZZY_HOME, 'config.json');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function skill(options = {}) {
  const created = createSkill({ name: 'mail-checks', description: 'Read approved task mail.',
    instructions: 'Read the exact approvedSignupAliases array from privateContext supplied by the owner host. These aliases grant no mailbox permission.' }, { scope: 'global', ...options });
  return setSkillEnabled(created.id, true, created.revision, options);
}
const host = (session, context = {}) => new ToolHost(session, { event() {} }, context);

test('host alias administration preserves other private configuration, revisions and exact owner-selected strings', () => {
  const entry = skill(), other = { theme: { palette: 'blue' }, untouchedPrivateSetting: 'fixture-only-value' };
  writeJson(config, other);
  assert.equal(getSkillSignupAliases(entry.id), null);
  const result = setSkillSignupAliases(entry.id, aliases, { expectedRevision: 0 });
  assert.deepEqual(result, { skillId: entry.id, approvedSignupAliases: aliases, revision: 1 });
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  result.approvedSignupAliases.pop(); assert.deepEqual(getSkillSignupAliases(entry.id).approvedSignupAliases, aliases);
  assert.deepEqual(readJson(config).theme, other.theme); assert.equal(readJson(config).untouchedPrivateSetting, other.untouchedPrivateSetting);
  assert.throws(() => setSkillSignupAliases(entry.id, aliases, { expectedRevision: 0 }), { code: 'SKILL_ACCOUNT_POLICY_STALE' });
  assert.throws(() => clearSkillSignupAliases(entry.id, { expectedRevision: 0 }), { code: 'SKILL_ACCOUNT_POLICY_STALE' });
  assert.deepEqual(clearSkillSignupAliases(entry.id, { expectedRevision: 1 }), { skillId: entry.id, cleared: true, revision: 2 });
  assert.deepEqual(getSkillSignupAliases(entry.id).approvedSignupAliases, []);
  assert.equal(setSkillSignupAliases(entry.id, aliases, { expectedRevision: 2 }).revision, 3);
});

test('invalid alias input never edits the store and damaged configuration errors reveal no raw contents', () => {
  const entry = skill(); setSkillSignupAliases(entry.id, aliases); const before = fs.readFileSync(config, 'utf8');
  for (const invalid of [[], ['plain-name'], ['fixture@example.invalid\nInjected'], ['Name <fixture@example.invalid>'],
    [' fixture@example.invalid'], ['fixture..other@example.invalid'], ['.fixture@example.invalid'], ['fixture.@example.invalid'],
    [aliases[0], aliases[0]], Array(33).fill(aliases[0]), new Array(1), [null], 'fixture@example.invalid']) {
    assert.throws(() => setSkillSignupAliases(entry.id, invalid), { code: 'SKILL_ACCOUNT_POLICY_INVALID' });
    assert.equal(fs.readFileSync(config, 'utf8'), before);
  }
  fs.writeFileSync(config, '{"password":"raw-private-fixture-fragment",');
  for (const read of [() => getSkillSignupAliases(entry.id), () => setSkillSignupAliases(entry.id, aliases), () => clearSkillSignupAliases(entry.id)]) {
    assert.throws(read, error => error.code === 'SKILL_ACCOUNT_POLICY_INVALID' && !error.message.includes('raw-private-fixture-fragment'));
  }
  fs.writeFileSync(config, before); fs.chmodSync(config, 0o644);
  assert.throws(() => getSkillSignupAliases(entry.id), { code: 'SKILL_ACCOUNT_POLICY_INVALID' });
});

test('authorized terminal reads receive exact aliases separately from immutable bytes, pagination, receipts and diagnostics', async () => {
  const entry = skill(), session = createSession(provider, cwd), runId = randomUUID();
  setSkillSignupAliases(entry.id, aliases);
  putRecord('run', session.id, { id: runId, state: 'running', goalMode: false });
  const tools = host(session, { runId, goalMode: false }), plain = readSkill(entry.id, { limit: 80 });
  const first = await tools.call('read_skill', { name: entry.id, limit: 80 });
  const { privateContext, ...immutable } = first;
  assert.deepEqual(privateContext, { approvedSignupAliases: aliases, policyRevision: 1 });
  assert.deepEqual(immutable, plain);
  const second = await tools.call('read_skill', { name: entry.id, offset: first.nextOffset, limit: 80 });
  assert.equal(second.sha256, first.sha256); assert.equal(second.version, first.version);
  assert.deepEqual(second.privateContext.approvedSignupAliases, aliases);
  const savedEvents = events(session.id, 0, 1000);
  assert.ok(savedEvents.some(event => event.type === 'skill.loaded')); assert.ok(savedEvents.some(event => event.type === 'diagnostic.tool'));
  for (const alias of aliases) assert.ok(!JSON.stringify(savedEvents).includes(alias));
  assert.ok(!taskTools(session).some(tool => /setSkillSignupAliases|clearSkillSignupAliases|signup_aliases/.test(tool.name)));
  clearSkillSignupAliases(entry.id);
  assert.equal((await tools.call('read_skill', { name: entry.id })).privateContext, undefined);
});

test('unavailable private settings withhold all aliases without blocking immutable skill instructions', async () => {
  const entry = skill(), session = createSession(provider, cwd), immutable = readSkill(entry.id);
  setSkillSignupAliases(entry.id, aliases);
  fs.writeFileSync(config, '{"password":"raw-private-fixture-fragment",');
  const result = await host(session).call('read_skill', { name: entry.id });
  const { privateContext, ...procedure } = result;
  assert.deepEqual(privateContext, { approvedSignupAliases: [], unavailable: true });
  assert.deepEqual(procedure, immutable);
  assert.ok(!JSON.stringify(result).includes('raw-private-fixture-fragment'));
  for (const alias of aliases) assert.ok(!JSON.stringify(result).includes(alias));
  assert.throws(() => getSkillSignupAliases(entry.id), { code: 'SKILL_ACCOUNT_POLICY_INVALID' });
});

test('the authenticated model tool bridge serializes the explicit private list alongside the unmodified skill', async () => {
  const entry = skill(), session = createSession(provider, cwd); setSkillSignupAliases(entry.id, aliases);
  const tools = await host(session).open();
  try {
    const result = await bridgeRequest(tools.socket, tools.token, { method: 'call', name: 'read_skill', arguments: { name: entry.id } });
    assert.deepEqual(result.privateContext.approvedSignupAliases, aliases);
    const { privateContext, ...immutable } = result; assert.deepEqual(immutable, readSkill(entry.id));
    const catalog = await bridgeRequest(tools.socket, tools.token, { method: 'list' });
    assert.ok(!JSON.stringify(catalog).includes(aliases[0]));
    assert.equal(listRecords('execution').length, 0);
  } finally { await tools.close(); }
});

test('private policies follow exact project skill identity and cannot leak through another scope or local shadow', async () => {
  const global = skill(), local = skill({ scope: 'project', projectRoot: cwd });
  setSkillSignupAliases(global.id, aliases, { scope: 'global' });
  const localAliases = ['local-fixture@example.invalid']; setSkillSignupAliases(local.id, localAliases, { projectRoot: cwd });
  const session = createSession(provider, cwd);
  assert.throws(() => getSkillSignupAliases(global.id, { session, expectedSkillId: global.id, expectedSkillVersion: local.version }), { code: 'SKILL_ACCOUNT_POLICY_STALE' });
  const result = await host(session).call('read_skill', { name: 'mail-checks' });
  assert.equal(result.id, local.id); assert.deepEqual(result.privateContext.approvedSignupAliases, localAliases);
  const foreign = path.join(directory, 'foreign'); fs.mkdirSync(foreign);
  assert.throws(() => getSkillSignupAliases(local.id, { projectRoot: foreign }), /not found/);
  const other = createSession(provider, foreign);
  assert.deepEqual((await host(other).call('read_skill', { name: 'mail-checks' })).privateContext.approvedSignupAliases, aliases);
});

test('children, reviewers, persistent Agents, forged root metadata and disabled/deleted skills cannot inherit owner aliases', async () => {
  const entry = skill(); setSkillSignupAliases(entry.id, aliases);
  const root = createSession(provider, cwd);
  for (const role of ['executor', 'reviewer', undefined]) {
    const child = createSession(provider, cwd); child.parentSessionId = root.id; if (role) child.role = role; saveSession(child);
    assert.equal((await host(child).call('read_skill', { name: entry.id })).privateContext, undefined);
    await assert.rejects(host({ ...child, parentSessionId: undefined, role: undefined }).call('read_skill', { name: entry.id }), { code: 'FORBIDDEN' });
  }
  const reviewer = createSession(provider, cwd); reviewer.role = 'reviewer'; saveSession(reviewer);
  assert.equal((await host({ ...reviewer, role: undefined }).call('read_skill', { name: entry.id })).privateContext, undefined);
  const agentsRoot = path.join(directory, 'managed');
  new CoreWorkspaces().configure({ path: agentsRoot, create: true }, { expectedRevision: 0, requestId: randomUUID() });
  const agent = new CoreAgents().create({ name: 'Isolated alias reader', instructions: 'Read only authorized project inputs.', provider: 'codex', model: 'offline-fixture', effort: 'default' }, { requestId: randomUUID() });
  const agentSession = loadSession(agent.sessionId);
  assert.equal((await host(agentSession).call('read_skill', { name: entry.id })).privateContext, undefined);
  setSkillEnabled(entry.id, false, entry.revision);
  await assert.rejects(host(root).call('read_skill', { name: entry.id }), /disabled/);
  deleteSkill(entry.id, entry.revision + 1);
  await assert.rejects(host(root).call('read_skill', { name: entry.id }), /not found/);
});

test('portable Library round trips exclude private aliases while retaining generic instructions and resource hashes', () => {
  const entry = skill(); setSkillSignupAliases(entry.id, aliases);
  const exported = previewLibraryExport({ cwd }), folder = path.join(process.env.BZZY_HOME, 'relay', 'shares', randomUUID());
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); let imported;
  try {
    const archive = path.join(folder, 'project.zip'); buildLibraryArchive(archive, { cwd, expectedDigest: exported.sourceDigest });
    const extracted = spawnSync('python3', ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n for name in z.namelist(): print(z.read(name).decode())', archive], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    for (const alias of aliases) assert.ok(!extracted.stdout.includes(alias));
    assert.ok(!extracted.stdout.includes('skillAccountPolicies'));
    process.env.BZZY_HOME = path.join(directory, 'receiver-core');
    imported = previewLibraryImport(archive, { cwd }); const result = importLibraryBundle(imported, { cwd, enable: true });
    assert.equal(result.skills[0].version, entry.version); assert.equal(getSkillSignupAliases(entry.id), null);
    assert.equal(listRecords('execution').length, 0);
  } finally { discardDefinitionBundleReview(exported); if (imported) discardDefinitionBundleReview(imported); }
});
