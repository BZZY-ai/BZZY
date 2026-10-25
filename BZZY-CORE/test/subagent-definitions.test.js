import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRecords, getRecord, putRecord, digest } from '../src/engine/database.js';
import { getSubagentDefinition, listSubagentDefinitions, saveSubagentDefinition,
  deleteSubagentDefinition, getSubagentDefinitionVersion, assertSubagentDefinitionPin } from '../src/engine/subagent-definitions.js';
import { subagentsCLI } from '../src/engine/subagents-cli.js';

let directory, cwd, other, saved;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-subagent-definitions-')));
  saved = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(directory, 'private');
  cwd = path.join(directory, 'project'); other = path.join(directory, 'other');
  fs.mkdirSync(cwd); fs.mkdirSync(other);
});
test.afterEach(() => {
  if (saved === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = saved;
  fs.rmSync(directory, { recursive: true, force: true });
});
const definition = (name = 'http-response-analyzer') => ({ name, description: 'Inspect HTTP response evidence.',
  instructions: 'Inspect only the supplied in-scope HTTP response evidence. Distinguish observations from hypotheses and return evidence references.' });

test('project-scoped definitions shadow globals without leaking to other projects or launching work', () => {
  const global = saveSubagentDefinition(definition(), { scope: 'global' });
  assert.equal(getSubagentDefinition(global.name, { cwd }).id, global.id);
  const local = saveSubagentDefinition({ ...definition(), instructions: 'Perform project-specific HTTP response review.' }, { cwd });
  assert.notEqual(local.id, global.id);
  assert.equal(getSubagentDefinition(local.name, { cwd }).id, local.id);
  assert.equal(getSubagentDefinition(local.name, { cwd: other }).id, global.id);
  assert.equal(listSubagentDefinitions({ cwd }).subagents.length, 1);
  assert.equal(listSubagentDefinitions({ cwd }).subagents[0].instructions, undefined);
  assert.equal(listSubagentDefinitions({ cwd, scope: 'global' }).subagents[0].id, global.id);
  assert.throws(() => getSubagentDefinition(local.name, { cwd: other, scope: 'project' }), { code: 'NOT_FOUND' });
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
});

test('definitions pin immutable content, enforce edit revisions, retain history and do not silently fall back after deletion', () => {
  saveSubagentDefinition(definition(), { scope: 'global' });
  const original = saveSubagentDefinition(definition(), { cwd });
  original.instructions = 'Mutation of returned object';
  assert.notEqual(getSubagentDefinition(original.name, { cwd }).instructions, original.instructions);
  assert.throws(() => saveSubagentDefinition(definition(), { cwd }), { code: 'CONFLICT' });
  const updated = saveSubagentDefinition({ ...definition(), instructions: 'Updated specialist instructions.' }, { cwd, expectedRevision: 1 });
  assert.equal(updated.revision, 2); assert.notEqual(updated.version, original.version);
  assert.equal(getSubagentDefinitionVersion(original.id, original.version).instructions, definition().instructions);
  assert.throws(() => deleteSubagentDefinition(original.name, { cwd, expectedRevision: 1 }), { code: 'CONFLICT' });
  assert.equal(deleteSubagentDefinition(original.name, { cwd, expectedRevision: 2 }).revision, 3);
  assert.throws(() => getSubagentDefinition(original.name, { cwd }), { code: 'NOT_FOUND' });
  assert.equal(listSubagentDefinitions({ cwd }).total, 0);
  assert.equal(getSubagentDefinitionVersion(original.id, original.version).version, original.version);
  assert.throws(() => saveSubagentDefinition(definition(), { cwd }), { code: 'CONFLICT' });
  assert.equal(saveSubagentDefinition(definition(), { cwd, expectedRevision: 3 }).revision, 4);
});

test('canonical project aliases resolve the same definition while foreign paths do not', () => {
  const local = saveSubagentDefinition(definition(), { cwd }), alias = path.join(directory, 'project-alias');
  fs.symlinkSync(cwd, alias);
  assert.equal(getSubagentDefinition(local.name, { cwd: alias }).id, local.id);
  assert.throws(() => getSubagentDefinition(local.name, { cwd: other }), { code: 'NOT_FOUND' });
  assert.throws(() => listSubagentDefinitions({ cwd: '../relative' }), /absolute/);
});

test('pins remain valid across no-op edits and reviewed content reverts, while scope and content stay immutable', () => {
  const original = saveSubagentDefinition(definition(), { cwd });
  const repeated = saveSubagentDefinition(definition(), { cwd, expectedRevision: 1 });
  assert.equal(repeated.version, original.version); assert.equal(repeated.revision, 2);
  assert.equal(getSubagentDefinitionVersion(original.id, original.version).revision, 1);
  assert.deepEqual(assertSubagentDefinitionPin(repeated), repeated);
  saveSubagentDefinition({ ...definition(), instructions: 'Revised specialist instructions.' }, { cwd, expectedRevision: 2 });
  const reverted = saveSubagentDefinition(definition(), { cwd, expectedRevision: 3 });
  assert.equal(reverted.version, original.version); assert.equal(reverted.revision, 4);
  assert.deepEqual(assertSubagentDefinitionPin(reverted), reverted);
  for (const extra of [{ instructions: 'Forged behavior' }, { projectRoot: other }, { scope: 'global' }, { revision: 0 }, { credentials: 'forbidden' }]) {
    assert.throws(() => assertSubagentDefinitionPin({ ...reverted, ...extra }));
  }
});

test('strict portable definitions reject private bindings, unknown grants, malformed paths and credentials', () => {
  const inputs = [
    { credentials: 'not-allowed' }, { scope: 'global' }, { cwd: other }, { tools: ['shell'] }, { schedule: {} },
    { name: '../escape' }, { name: 'XSS' }, { provider: 'missing-provider' }, { model: 'model with whitespace' },
    { effort: '-bad' }, { policy: { network: 'enabled' } }, { policy: { writablePaths: ['../other'] } },
    { policy: { writablePaths: ['x/./y'] } }, { policy: { writablePaths: ['/tmp'] } },
    { policy: { mode: 'read-only', writablePaths: ['.'] } }, { policy: { grant: 'all' } },
    { limits: { tokenBudget: 0 } }, { limits: { runtimeSeconds: 3601 } }, { limits: { concurrency: 100 } },
    { description: 'description\nwith newline' }, { instructions: 'x'.repeat(16001) },
    { instructions: 'password=literal-private-password' }, { instructions: 'Use private.person@corp.test for identity.' },
    { instructions: 'Use sk-1234567890abcdefghijklmnop' },
  ];
  for (const extra of inputs) assert.throws(() => saveSubagentDefinition({ ...definition(), ...extra }, { cwd }));
  const previous = process.env.BZZY_TEST_SECRET;
  process.env.BZZY_TEST_SECRET = 'private-fixture-secret-value';
  try { assert.throws(() => saveSubagentDefinition({ ...definition(), instructions: process.env.BZZY_TEST_SECRET }, { cwd }), /credential/); }
  finally { if (previous === undefined) delete process.env.BZZY_TEST_SECRET; else process.env.BZZY_TEST_SECRET = previous; }
  assert.equal(listSubagentDefinitions({ cwd }).total, 0);
});

test('optional selection and narrowed policy stay portable and inherit unspecified fields at execution', () => {
  const local = saveSubagentDefinition({ ...definition(), provider: 'codex', model: 'specialist-model', effort: 'high',
    policy: { network: 'disabled' }, limits: { runtimeSeconds: 90, tokenBudget: 12000 } }, { cwd });
  assert.deepEqual(local.policy, { network: 'disabled' });
  assert.deepEqual(local.limits, { runtimeSeconds: 90, tokenBudget: 12000 });
  assert.equal(local.model, 'specialist-model'); assert.equal(local.effort, 'high');
  assert.deepEqual(saveSubagentDefinition({ ...definition('read-only-analyzer'), policy: { mode: 'read-only' } }, { cwd }).policy,
    { mode: 'read-only', writablePaths: [] });
});

test('bounded discovery pages omit instructions and pinned storage detects altered content', () => {
  for (let index = 0; index < 5; index++) saveSubagentDefinition(definition(`analyzer-${index}`), { cwd });
  const first = listSubagentDefinitions({ cwd, query: 'analyzer', limit: 2 });
  assert.equal(first.total, 5); assert.equal(first.nextOffset, 2);
  assert.deepEqual(listSubagentDefinitions({ cwd, offset: first.nextOffset, limit: 2 }).subagents.map(row => row.name), ['analyzer-2', 'analyzer-3']);
  for (const options of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { query: [] }]) assert.throws(() => listSubagentDefinitions({ cwd, ...options }));
  const local = getSubagentDefinition('analyzer-0', { cwd }), id = digest([local.id, local.version]);
  putRecord('core.subagent.definition.version', id, { ...getRecord('core.subagent.definition.version', id), instructions: 'tampered' });
  assert.throws(() => getSubagentDefinitionVersion(local.id, local.version), /integrity/);
});

test('owner CLI creates, shows, edits and deletes reviewed JSON with revision checks and no inference', () => {
  const file = path.join(cwd, 'response-analyzer.json'), events = [], ui = { event: (type, data) => events.push({ type, data }) };
  fs.writeFileSync(file, JSON.stringify(definition()));
  assert.equal(subagentsCLI(['create', 'response-analyzer.json'], { cwd }, ui), 0);
  assert.equal(events.at(-1).data.result.revision, 1);
  subagentsCLI(['list'], { cwd }, ui); assert.equal(events.at(-1).data.result.total, 1);
  subagentsCLI(['show', definition().name], { cwd }, ui); assert.equal(events.at(-1).data.result.instructions, definition().instructions);
  fs.writeFileSync(file, JSON.stringify({ ...definition(), description: 'Updated response analysis.' }));
  subagentsCLI(['update', file, '--revision', '1'], { cwd }, ui); assert.equal(events.at(-1).data.result.revision, 2);
  assert.throws(() => subagentsCLI(['update', file, '--revision', '1'], { cwd }, ui), { code: 'CONFLICT' });
  subagentsCLI(['delete', definition().name, '--revision', '2'], { cwd }, ui); assert.ok(events.at(-1).data.result.deletedAt);
  assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
  for (const args of [['create'], ['create', file, '--revision', '1'], ['update', file], ['delete', definition().name], ['list', 'extra'], ['list', '--global', '--global']]) {
    assert.throws(() => subagentsCLI(args, { cwd }, ui), /Usage/);
  }
});

test('owner CLI rejects linked, oversized, invalid UTF-8 or malformed definition files', () => {
  const file = path.join(cwd, 'definition.json'), link = path.join(cwd, 'definition-link.json'), ui = { event() {} };
  fs.writeFileSync(file, JSON.stringify(definition())); fs.symlinkSync(file, link);
  assert.throws(() => subagentsCLI(['create', link], { cwd }, ui));
  fs.unlinkSync(link); fs.linkSync(file, link);
  assert.throws(() => subagentsCLI(['create', file], { cwd }, ui), /without links/);
  fs.unlinkSync(link); fs.writeFileSync(file, 'x'.repeat(24 * 1024 + 1));
  assert.throws(() => subagentsCLI(['create', file], { cwd }, ui), /24 KiB/);
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
  assert.throws(() => subagentsCLI(['create', file], { cwd }, ui), /UTF-8 JSON/);
  fs.writeFileSync(file, 'not json');
  assert.throws(() => subagentsCLI(['create', file], { cwd }, ui), /UTF-8 JSON/);
});
