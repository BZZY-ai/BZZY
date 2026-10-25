import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { listRecords } from '../src/engine/database.js';
import { workflowsCLI } from '../src/engine/workflows-cli.js';

let previous, directory, cwd, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-workflow-cli-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'), cwd, 'offline-model'); saveSession(session);
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
function command(args) { let result; workflowsCLI(args, { cwd }, { event(type, data) { result = data.result; } }); return result; }

test('owner workflow commands create, inspect, import and explicitly select reusable text without executing models', () => {
  fs.writeFileSync(path.join(cwd, 'process.json'), JSON.stringify({ name: 'local-process', description: 'Inspect supplied evidence.', instructions: 'Keep the exact original requirement.' }));
  const created = command(['create', 'process.json']); assert.equal(created.scope, 'project');
  assert.equal(command(['show', created.name]).version, created.version);
  assert.equal(command(['list']).total, 1);
  fs.writeFileSync(path.join(cwd, 'process.md'), 'A separate global reusable procedure.');
  const imported = command(['import', 'process.md', '--name', 'global-process', '--description', 'A global method.', '--global']);
  assert.equal(imported.scope, 'global');
  const selected = command(['use', imported.name, '--session', session.id, '--revision', '0', '--workflow-revision', '1', '--global']);
  assert.equal(selected.selected.id, imported.id);
  assert.equal(command(['selection', '--session', session.id]).revision, 1);
  assert.equal(command(['clear', '--session', session.id, '--revision', '1']).selected, null);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
});

test('workflow command parsing rejects missing sessions/revisions and cannot overwrite an existing name implicitly', () => {
  fs.writeFileSync(path.join(cwd, 'process.json'), JSON.stringify({ name: 'local-process', description: '', instructions: 'Review only supplied evidence.' }));
  command(['create', 'process.json']);
  assert.throws(() => command(['create', 'process.json']), { code: 'CONFLICT' });
  for (const args of [['use', 'local-process'], ['clear', '--session', session.id], ['delete', 'local-process'],
    ['update', 'process.json', '--revision', '0'], ['create', 'process.json', '--revision', '1'], ['list', '--global', '--global']]) assert.throws(() => command(args));
  assert.equal(command(['delete', 'local-process', '--revision', '1']).deletedAt.length > 0, true);
});
