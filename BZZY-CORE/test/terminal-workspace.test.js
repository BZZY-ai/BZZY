import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createChatSession, createTaskSession, newConversation, openOrCreateChatSession, prepareConversationTurn } from '../src/engine/host-commands.js';
import { getProvider } from '../src/engine/providers.js';
import { createSession, loadSession, saveSession, setSessionAlias } from '../src/engine/store.js';
import { listRecords } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { projectIdentityForSession } from '../src/engine/project-identity.js';

let directory, previous, parent, cwd, elsewhere;
const provider = getProvider('codex');
const options = () => ({ cwd, model: 'offline-fixture' });
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-terminal-workspace-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  parent = path.join(directory, 'projects'); cwd = path.join(parent, 'nasa'); elsewhere = path.join(directory, 'elsewhere');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(elsewhere);
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});
function markParent() {
  const session = createSession(provider, parent, 'offline-fixture'); initializeProject(session); saveSession(session);
  fs.writeFileSync(path.join(parent, '.bzzy', 'constraints.json'), JSON.stringify({ constraints: ['PARENT_ONLY'], policy: { mode: 'read-only', writablePaths: [] } }));
  return session;
}

test('an idle terminal immediately owns its launch directory beneath another marked workspace', async () => {
  const outer = markParent();
  fs.mkdirSync(path.join(cwd, 'findings')); fs.writeFileSync(path.join(cwd, 'findings', 'previous.txt'), 'retained input');
  const session = createChatSession(provider, options());
  assert.equal(session.cwd, cwd); assert.equal(session.projectRoot, cwd); assert.notEqual(session.projectId, outer.projectId);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.bzzy', 'project.json'))).id, session.projectId);
  assert.equal(fs.readFileSync(path.join(cwd, '.bzzy', '.gitignore'), 'utf8'), '*\n');
  assert.equal(session.goal, null); assert.equal(session.engineThreadId, null); assert.equal(listRecords('execution').length, 0);
  assert.equal(loadSession(session.id).projectRoot, cwd);
  const named = setSessionAlias(session.id, 'nasa');
  const attached = await openOrCreateChatSession('nasa', { cwd: elsewhere, model: 'different-model' });
  assert.equal(named.cwd, cwd); assert.equal(attached.created, false); assert.equal(attached.session.id, session.id);
  assert.equal(attached.session.projectRoot, cwd); assert.equal(fs.existsSync(path.join(elsewhere, '.bzzy')), false);
  prepareConversationTurn(session, options(), 'Inspect supplied files');
  assert.equal(session.contract.constraints.includes('PARENT_ONLY'), false); assert.notEqual(session.policy.mode, 'read-only');
  assert.equal(fs.readFileSync(path.join(cwd, 'findings', 'previous.txt'), 'utf8'), 'retained input');
});

for (const request of [false, true]) for (const readOnly of [false, true]) {
  test(`task launch pins its own workspace (${request ? 'request retry' : 'ordinary'}, ${readOnly ? 'read-only' : 'writable'})`, () => {
    const outer = markParent(), settings = { ...options(), readOnly, ...(request ? { requestId: randomUUID() } : {}) };
    const { session } = createTaskSession(provider, settings, 'Inspect supplied files', { goal: true });
    assert.equal(session.cwd, cwd); assert.equal(session.projectRoot, cwd); assert.notEqual(session.projectId, outer.projectId);
    assert.ok(fs.existsSync(path.join(cwd, '.bzzy', 'project.json')));
    assert.equal(session.contract.constraints.includes('PARENT_ONLY'), false);
    if (readOnly) { assert.equal(session.policy.mode, 'read-only'); assert.deepEqual(session.policy.writablePaths, []); }
    if (request) {
      fs.rmSync(path.join(cwd, '.bzzy'), { recursive: true });
      const retry = createTaskSession(provider, settings, 'Inspect supplied files', { goal: true });
      assert.equal(retry.session.id, session.id); assert.equal(retry.session.projectRoot, cwd);
      assert.equal(fs.existsSync(path.join(cwd, '.bzzy')), false, 'Accepted retries do not repeat workspace setup');
      assert.equal(projectIdentityForSession(retry.session).root, cwd, 'A missing marker cannot adopt the parent project');
    }
  });
}

test('new conversation setup canonicalizes cwd while existing saved project pins remain unchanged', async () => {
  const outer = markParent(), legacy = createSession(provider, cwd, 'offline-fixture', 'legacy');
  legacy.projectRoot = parent; legacy.projectId = outer.projectId; saveSession(legacy);
  const attached = await openOrCreateChatSession('legacy', { cwd: elsewhere });
  assert.equal(attached.session.projectRoot, parent); assert.equal(fs.existsSync(path.join(cwd, '.bzzy')), false);
  const link = path.join(directory, 'launch-link'); fs.symlinkSync(cwd, link);
  const fresh = newConversation(legacy, { cwd: link });
  assert.equal(fresh.cwd, cwd); assert.equal(fresh.projectRoot, cwd); assert.notEqual(fresh.projectId, outer.projectId);
  assert.ok(fs.existsSync(path.join(cwd, '.bzzy', 'project.json')));
  fs.rmSync(path.join(cwd, '.bzzy'), { recursive: true });
  assert.equal(projectIdentityForSession(fresh).root, cwd);
  assert.equal(projectIdentityForSession(legacy).root, parent);
});

test('unsafe project setup fails before saving a terminal; raw read-only initialization still creates no project files', () => {
  fs.symlinkSync(elsewhere, path.join(cwd, '.bzzy'));
  assert.throws(() => createChatSession(provider, options()), /real directory/);
  assert.equal(listRecords('session').length, 0); assert.deepEqual(fs.readdirSync(elsewhere), []);
  fs.unlinkSync(path.join(cwd, '.bzzy'));
  const reader = createSession(provider, cwd); reader.policy = { mode: 'read-only' }; initializeProject(reader);
  assert.equal(fs.existsSync(path.join(cwd, '.bzzy')), false);
});

test('repeat launches preserve local identity and custom defaults; idle setup leaves first-contract projection available', () => {
  const first = createChatSession(provider, options());
  assert.equal(fs.existsSync(path.join(cwd, '.bzzy', 'constraints.json')), false);
  const contract = path.join(directory, 'contract.json');
  fs.writeFileSync(contract, JSON.stringify({ constraints: ['LOCAL_ONLY'], scope: { allowedTargets: ['fixture.invalid'] } }));
  prepareConversationTurn(first, { ...options(), contract }, 'Inspect supplied files'); initializeProject(first);
  const defaults = fs.readFileSync(path.join(cwd, '.bzzy', 'constraints.json'), 'utf8');
  assert.deepEqual(JSON.parse(defaults).constraints, ['LOCAL_ONLY']);
  assert.deepEqual(JSON.parse(defaults).scope.allowedTargets, ['fixture.invalid']);
  fs.writeFileSync(path.join(cwd, '.bzzy', '.gitignore'), '# custom owner rules\n*\n');
  const second = createChatSession(provider, options());
  assert.equal(second.projectId, first.projectId);
  assert.equal(fs.readFileSync(path.join(cwd, '.bzzy', 'constraints.json'), 'utf8'), defaults);
  assert.equal(fs.readFileSync(path.join(cwd, '.bzzy', '.gitignore'), 'utf8'), '# custom owner rules\n*\n');
});

test('owner launch never follows an existing linked ignore file or overwrites its target', () => {
  const first = createChatSession(provider, options()), ignore = path.join(cwd, '.bzzy', '.gitignore');
  const external = path.join(elsewhere, 'do-not-change'); fs.writeFileSync(external, 'runtime/\n*.sqlite*\n');
  fs.unlinkSync(ignore); fs.symlinkSync(external, ignore);
  assert.throws(() => createChatSession(provider, options()));
  assert.equal(fs.readFileSync(external, 'utf8'), 'runtime/\n*.sqlite*\n');
  assert.deepEqual(listRecords('session').map(session => session.id), [first.id]);
  fs.unlinkSync(ignore); fs.linkSync(external, ignore);
  assert.throws(() => createChatSession(provider, options()), /without links/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'runtime/\n*.sqlite*\n');
  fs.unlinkSync(ignore); fs.writeFileSync(ignore, 'runtime/\n*.sqlite*\n');
  createChatSession(provider, options()); assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n');
  fs.unlinkSync(ignore); execFileSync('mkfifo', [ignore]);
  assert.throws(() => createChatSession(provider, options()), /regular file/);
});
