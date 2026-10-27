import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { database, putRecord, appendEvent, now } from '../src/engine/database.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { normalizePolicy, normalizeContract } from '../src/engine/contracts.js';
import { importSkill, createSkill, setSkillEnabled, deleteSkill } from '../src/engine/skills.js';
import { saveSubagentDefinition, setSubagentEnabled } from '../src/engine/subagent-definitions.js';
import { exportSessionDebug } from '../src/engine/session-debug.js';
import { sessionMetrics } from '../src/engine/session-metrics.js';
import { ToolHost } from '../src/engine/tools.js';
import { CodexEngine } from '../src/engine/engines/codex.js';
import { ClaudeEngine } from '../src/engine/engines/claude.js';
import { RunnerUI } from '../src/engine/runtime-ui.js';
import { conversationPrompt } from '../src/engine/conversation.js';
import { diagnosticRedactor } from '../src/engine/diagnostic-redaction.js';

let directory, parent, previous;
const envKeys = ['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_HOME', 'BZZY_CLAUDE_BIN', 'BZZY_TEST_LOG', 'BZZY_TEST_SCENARIO', 'BZZY_ENV_ALLOW', 'SESSION_DEBUG_TOKEN'];
test.beforeEach(() => {
  previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debug-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); delete process.env.SESSION_DEBUG_TOKEN;
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  parent = createSession(getProvider('codex'), cwd, 'offline-model', 'long-session');
  parent.policy = normalizePolicy(); parent.contract = normalizeContract({}, 'Inspect the local fixture.'); initializeProject(parent); saveSession(parent);
});
test.afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(directory, { recursive: true, force: true });
});
const parseReport = file => fs.readFileSync(file, 'utf8').split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
const snapshot = () => Object.fromEntries(['records', 'events', 'requests'].map(table => [table, database().prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()]));
const skill = (name = 'review-fixture', instructions = 'Follow the complete review fixture method.') => {
  let row = createSkill({ name, description: 'Review local recorded evidence.', instructions }, { scope: 'global' });
  return setSkillEnabled(row.name, true, row.revision, { scope: 'global' });
};
const specialist = (name = 'fixture-reviewer') => saveSubagentDefinition({ name, description: 'Review supplied offline fixtures independently.',
  instructions: 'Inspect only the supplied fixture. Retain uncertainty and report evidence.' }, { cwd: parent.cwd });
function beginRun() {
  parent.executionState = 'running'; saveSession(parent);
  const run = { id: randomUUID(), sessionId: parent.id, state: 'running', goalMode: false, startedAt: now() }; putRecord('run', parent.id, run);
  return { runId: run.id, goalMode: false, prompt: 'Inspect the local fixture.', launch() {} };
}

test('exports an already-running legacy session, full definitions and only its linked workers without changing saved state', () => {
  const method = skill(); specialist();
  const disabled = skill('disabled-method'); setSkillEnabled(disabled.name, false, disabled.revision, { scope: 'global' });
  beginRun();
  parent.goal = { id: randomUUID(), objective: 'ORIGINAL_OBJECTIVE', status: 'active' };
  parent.contract.context = 'PINNED_WORKFLOW_TEXT'; saveSession(parent);
  appendEvent(parent.id, 'message.user', { text: 'Inspect the authorized local project.', kind: 'goal' });
  appendEvent(parent.id, 'text', { text: 'First visible ' }); appendEvent(parent.id, 'text', { text: 'observation.' });
  appendEvent(parent.id, 'skill.loaded', { skillId: method.id, version: method.version, file: 'SKILL.md', offset: 0 });
  const worker = createSession(getProvider('codex'), parent.cwd, 'offline-worker');
  const assignmentId = randomUUID(); Object.assign(worker, { parentSessionId: parent.id, assignmentId, role: 'executor' }); saveSession(worker);
  putRecord('assignment', assignmentId, { id: assignmentId, parentSessionId: parent.id, workerSessionId: worker.id, goalId: parent.goal.id,
    subagentDefinition: { id: 'pin', name: 'old-specialist', version: 'a'.repeat(64), instructions: 'IMMUTABLE_WORKER_INSTRUCTIONS' } });
  appendEvent(worker.id, 'text', { text: 'LINKED_WORKER_REPORT' });
  const other = createSession(getProvider('codex'), parent.cwd, 'unrelated'); appendEvent(other.id, 'text', { text: 'UNRELATED_CHAT_MUST_NOT_TRAVEL' });
  putRecord('core.binding', 'private-owner-binding', { token: 'PRIVATE_BINDING_MUST_NOT_TRAVEL' });
  const before = snapshot(), result = exportSessionDebug(parent.id, { at: new Date(2026, 9, 26) }), report = parseReport(result.outputPath);
  assert.equal(path.basename(result.outputPath), 'long-session_debug_26102026.md'); assert.equal(path.dirname(result.outputPath), parent.cwd);
  assert.deepEqual(snapshot(), before, 'Export must not update identity records, metrics, session state or events');
  const text = fs.readFileSync(result.outputPath, 'utf8');
  for (const expected of ['ORIGINAL_OBJECTIVE', 'PINNED_WORKFLOW_TEXT', 'LINKED_WORKER_REPORT', 'IMMUTABLE_WORKER_INSTRUCTIONS', 'Follow the complete review fixture method.', 'disabled-method']) assert.ok(text.includes(expected), expected);
  assert.doesNotMatch(text, /UNRELATED_CHAT_MUST_NOT_TRAVEL|PRIVATE_BINDING_MUST_NOT_TRAVEL/);
  assert.ok(report.some(row => row.kind === 'event' && row.data.text === 'First visible observation.' && row.throughSeq > row.seq));
  const summary = report.find(row => row.kind === 'summary'); assert.equal(summary.complete, true);
  assert.ok(summary.coverage.reasons.includes('historical_backend_delivery_not_recorded'));
  assert.ok(summary.coverage.reasons.includes('historical_run_catalogs_not_recorded'));
  assert.equal(report.find(row => row.kind === 'manifest').liveSnapshot, true);
  assert.equal(fs.statSync(result.outputPath).mode & 0o077, 0);
});

test('exports every skill text resource without truncating at a read boundary and scrubs a credential crossing that boundary', () => {
  const source = path.join(directory, 'source'); fs.mkdirSync(source); fs.mkdirSync(path.join(source, 'references')); fs.mkdirSync(path.join(source, 'scripts'));
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: resource-method\ndescription: Read the full local resource.\n---\nUse references/long.txt and scripts/check.py.');
  const synthetic = 'synthetic_boundary_binding_1234567890';
  fs.writeFileSync(path.join(source, 'references/long.txt'), 'x'.repeat(32760) + synthetic + 'é'.repeat(40000) + 'END_OF_FULL_RESOURCE');
  fs.writeFileSync(path.join(source, 'scripts/check.py'), 'print("SCRIPT_SOURCE_ONLY")\n');
  importSkill(source, { scope: 'global' }); process.env.SESSION_DEBUG_TOKEN = synthetic;
  const result = exportSessionDebug(parent.id), rows = parseReport(result.outputPath);
  const parts = rows.filter(row => row.kind === 'skill.resource' && row.file === 'references/long.txt');
  const text = parts.map(row => row.text).join('');
  assert.ok(parts.length >= 3); assert.ok(text.endsWith('END_OF_FULL_RESOURCE')); assert.ok(text.includes('[redacted]'));
  assert.ok(!text.includes(synthetic)); assert.ok(!text.includes(synthetic.slice(0, 8))); assert.ok(!text.includes(synthetic.slice(8)));
  assert.ok(rows.some(row => row.kind === 'skill.resource' && row.file === 'scripts/check.py' && row.text.includes('SCRIPT_SOURCE_ONLY')));
  assert.equal(rows.find(row => row.kind === 'summary').redaction.shortenedValues, 0);
});

test('retains a loaded immutable skill after owner deletion and labels changed or binary resources', () => {
  const original = skill(); appendEvent(parent.id, 'skill.loaded', { skillId: original.id, version: original.version, file: 'SKILL.md' });
  deleteSkill(original.id, original.revision, { scope: 'global' });
  let result = exportSessionDebug(parent.id), rows = parseReport(result.outputPath);
  assert.ok(rows.some(row => row.kind === 'skill.version' && row.data.version === original.version && row.basis.includes('recorded-resource-read')));
  assert.ok(rows.some(row => row.kind === 'skill.resource' && row.text.includes('complete review fixture')));
  const changed = skill('changed-method');
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'skills', changed.name, changed.version, 'SKILL.md'), 'TAMPERED_CONTENT_MUST_NOT_BE_EXPORTED');
  result = exportSessionDebug(parent.id); rows = parseReport(result.outputPath);
  assert.ok(rows.some(row => row.kind === 'skill.resource.omitted' && row.id === changed.id));
  assert.doesNotMatch(fs.readFileSync(result.outputPath, 'utf8'), /TAMPERED_CONTENT_MUST_NOT_BE_EXPORTED/);
});

test('never exports private provider envelopes, arbitrary events, credentials or private file output', () => {
  const synthetic = 'synthetic_configured_binding_123456'; process.env.SESSION_DEBUG_TOKEN = synthetic;
  appendEvent(parent.id, 'text', { text: `Visible safe text ${synthetic.slice(0, 12)}` });
  appendEvent(parent.id, 'text', { text: synthetic.slice(12) + ' Authorization: Bearer fake_auth_123\nCookie: sid=fake_cookie_one; other=fake_cookie_two\n--password fake_flag_value\nowner@example.invalid' });
  appendEvent(parent.id, 'backend', { method: 'item/completed', params: { item: { id: 'r', type: 'reasoning', text: 'HIDDEN_REASONING_MUST_NOT_TRAVEL' }, credentials: 'RAW_PROVIDER_CONFIG' } });
  appendEvent(parent.id, 'backend', { method: 'turn/completed', params: { turn: { id: 't', status: 'completed', items: [{ type: 'reasoning', text: 'NESTED_REASONING' }] }, environment: { value: 'ENVIRONMENT_DUMP' } } });
  appendEvent(parent.id, 'backend', { method: 'item/completed', params: { item: { type: 'commandExecution', command: 'cat ~/.aws/credentials', aggregatedOutput: 'BARE_PRIVATE_FILE_VALUE' } } });
  appendEvent(parent.id, 'backend', { method: 'item/completed', params: { item: { type: 'mcpToolCall', tool: 'read', arguments: { path: '/fixture/.env' }, result: { content: 'BARE_ENV_FILE_VALUE' } } } });
  appendEvent(parent.id, 'secret.future.event', { text: 'UNALLOWLISTED_SECRET' });
  const result = exportSessionDebug(parent.id), text = fs.readFileSync(result.outputPath, 'utf8');
  for (const value of [synthetic, 'fake_auth_123', 'fake_cookie_one', 'fake_cookie_two', 'fake_flag_value', 'owner@example.invalid', 'HIDDEN_REASONING_MUST_NOT_TRAVEL', 'RAW_PROVIDER_CONFIG', 'NESTED_REASONING', 'ENVIRONMENT_DUMP', 'BARE_PRIVATE_FILE_VALUE', 'BARE_ENV_FILE_VALUE', 'UNALLOWLISTED_SECRET']) assert.ok(!text.includes(value), value);
  const summary = parseReport(result.outputPath).find(row => row.kind === 'summary');
  assert.equal(summary.skippedEventCounts['secret.future.event'], 1); assert.ok(summary.redaction.redactedValues > 0);
  assert.ok(summary.coverage.reasons.includes('unsupported_event_types_omitted'));
});

test('default filenames never replace an export, explicit existing paths and symlinks are protected', () => {
  const destination = path.join(directory, 'current-location'); fs.mkdirSync(destination);
  const at = new Date(2026, 9, 26), first = exportSessionDebug(parent.id, { cwd: destination, at });
  const original = fs.readFileSync(first.outputPath);
  const second = exportSessionDebug(parent.id, { cwd: destination, at });
  assert.equal(path.basename(second.outputPath), 'long-session_debug_26102026_2.md');
  assert.deepEqual(fs.readFileSync(first.outputPath), original);
  assert.throws(() => exportSessionDebug(parent.id, { cwd: destination, output: path.basename(first.outputPath) }), /EEXIST/);
  fs.symlinkSync(first.outputPath, path.join(destination, 'link.md'));
  assert.throws(() => exportSessionDebug(parent.id, { cwd: destination, output: 'link.md' }), /EEXIST/);
  assert.deepEqual(fs.readFileSync(first.outputPath), original);
  assert.throws(() => exportSessionDebug(parent.id, { cwd: destination, output: 'debug.json' }), /\.md or \.txt/);
});

test('new live tool records prove discovery and loads, distinguish disabled-agent rejection, and add no extra metrics', async () => {
  const method = skill(), agent = specialist(); setSubagentEnabled(agent.name, false, { cwd: parent.cwd, expectedRevision: agent.revision });
  const context = beginRun(), ui = new RunnerUI(parent.id), host = await new ToolHost(parent, ui, context).open();
  try {
    const prepared = conversationPrompt(parent, 'Check the local fixture.'); assert.ok(prepared.includes(method.name));
    await host.call('list_skills', {}); await host.call('read_skill', { name: method.name });
    await host.call('list_subagents', {});
    await assert.rejects(host.call('spawn_subagent', { name: agent.name, requestId: 'blocked-agent', objective: 'Inspect fixture.', waitSeconds: 0 }), /disabled/);
    const before = snapshot(), counts = sessionMetrics(parent.id), result = exportSessionDebug(parent.id), rows = parseReport(result.outputPath);
    assert.deepEqual(snapshot(), before); assert.equal(counts.session.skillInvocations, 1); assert.equal(sessionMetrics(parent.id).session.skillInvocations, 1);
    assert.equal(counts.session.subagentInvocations, 0);
    const recorded = rows.filter(row => row.kind === 'event' && row.type === 'diagnostic.tool');
    const failed = recorded.find(row => row.data.name === 'spawn_subagent' && row.data.outcome === 'failed'); assert.ok(failed);
    assert.ok(recorded.some(row => row.data.callId === failed.data.callId && row.data.outcome === 'started' && row.data.input.name === agent.name));
    assert.ok(recorded.some(row => row.data.name === 'list_skills' && row.data.outcome === 'returned' && row.data.discovery.items[0].version === method.version));
    assert.ok(rows.some(row => row.kind === 'event' && row.type === 'diagnostic.catalog' && row.data.provenance === 'prepared-skill-prompt'));
  } finally { await host.close(); }
});

test('actual Codex adapter records BZZY instructions, submitted skill/agent schemas and accepted prompt delivery; resume is explicit', async () => {
  skill(); specialist();
  process.env.BZZY_CODEX_HOME = path.join(directory, 'fixture-auth'); fs.mkdirSync(process.env.BZZY_CODEX_HOME);
  fs.writeFileSync(path.join(process.env.BZZY_CODEX_HOME, 'auth.json'), '{}');
  const wrapper = path.join(directory, 'codex-fixture');
  fs.writeFileSync(wrapper, `#!${process.execPath}\nawait import(${JSON.stringify(new URL('./fixtures/codex.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  process.env.BZZY_CODEX_BIN = wrapper; process.env.BZZY_TEST_SCENARIO = 'complete';
  const context = beginRun(), ui = new RunnerUI(parent.id), host = await new ToolHost(parent, ui, context).open();
  const provider = getProvider('codex');
  try {
    for (let index = 0; index < 2; index++) {
      const engine = new CodexEngine(provider, parent, { toolHost: host, policy: parent.policy, goalMode: false }, ui);
      try { await engine.run('Review only the supplied local fixture.'); } finally { await engine.close(); }
    }
    const rows = parseReport(exportSessionDebug(parent.id).outputPath), recorded = rows.filter(row => row.kind === 'event');
    const setup = recorded.find(row => row.type === 'diagnostic.backend' && row.data.method === 'thread/start' && row.data.outcome === 'prepared');
    assert.ok(setup.data.tools.some(tool => tool.name === 'list_skills' && tool.inputSchema));
    assert.ok(setup.data.tools.some(tool => tool.name === 'spawn_subagent'));
    assert.ok(setup.data.instructions.text.includes('BZZY SPECIALIST SUBAGENTS'));
    assert.ok(recorded.some(row => row.data.setupId === setup.data.setupId && row.data.outcome === 'accepted'));
    assert.ok(recorded.some(row => row.type === 'diagnostic.prompt' && row.data.outcome === 'prepared' && row.data.prompt.text.includes('Current enabled catalog')));
    assert.ok(recorded.some(row => row.type === 'diagnostic.prompt' && row.data.method === 'turn/start' && row.data.outcome === 'accepted'));
    const resume = recorded.find(row => row.type === 'diagnostic.backend' && row.data.method === 'thread/resume' && row.data.outcome === 'prepared');
    assert.ok(resume.data.toolsSource.startsWith('inherited-native-thread')); assert.equal(resume.data.tools, undefined);
    assert.ok(rows.find(row => row.kind === 'summary').coverage.reasons.includes('resumed_native_tools_not_reenumerated'));
  } finally { await host.close(); }
});

test('large event histories retain both ends, expose field limits and do not pretend a quiet period proves a BZZY failure', () => {
  const db = database(); db.exec('BEGIN');
  try {
    for (let index = 0; index < 5000; index++) appendEvent(parent.id, 'activity', { summary: index === 0 ? 'FIRST_RECORDED_ACTIVITY' : index === 4999 ? 'LAST_RECORDED_ACTIVITY' : `Step ${index}`, details: 'Observed local work.' }, db);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  appendEvent(parent.id, 'text', { text: 'x'.repeat(70000) });
  const result = exportSessionDebug(parent.id), text = fs.readFileSync(result.outputPath, 'utf8'), rows = parseReport(result.outputPath);
  assert.match(text, /FIRST_RECORDED_ACTIVITY/); assert.match(text, /LAST_RECORDED_ACTIVITY/);
  assert.equal(rows.filter(row => row.kind === 'event' && row.type === 'activity').length, 5000);
  assert.ok(rows.find(row => row.kind === 'summary').redaction.shortenedValues > 0);
  assert.equal(rows.find(row => row.kind === 'summary').coverage.fullFidelity, false);
});

test('actual Claude adapter records its BZZY MCP allowlist and control/message transport without exporting the MCP credential', async () => {
  skill(); specialist();
  const wrapper = path.join(directory, 'claude-fixture');
  fs.writeFileSync(wrapper, `#!${process.execPath}\nawait import(${JSON.stringify(new URL('./fixtures/workflow-claude.mjs', import.meta.url).href)});\n`, { mode: 0o700 });
  Object.assign(process.env, { BZZY_CLAUDE_BIN: wrapper, BZZY_CLAUDE_HOME: path.join(directory, 'claude-auth'),
    BZZY_TEST_LOG: path.join(directory, 'claude-input.jsonl'), BZZY_ENV_ALLOW: 'BZZY_TEST_LOG' });
  parent.provider = 'claude'; parent.backend = 'claude'; saveSession(parent);
  const context = beginRun(), ui = new RunnerUI(parent.id), host = await new ToolHost(parent, ui, context).open();
  const engine = new ClaudeEngine(getProvider('claude'), parent, { toolHost: host, policy: parent.policy }, ui);
  try {
    await engine.run('Inspect the local fixture.');
    const result = exportSessionDebug(parent.id), rows = parseReport(result.outputPath), text = fs.readFileSync(result.outputPath, 'utf8');
    const setup = rows.find(row => row.kind === 'event' && row.type === 'diagnostic.backend' && row.data.method === 'claude-launch' && row.data.outcome === 'prepared');
    assert.ok(setup.data.tools.some(tool => tool.name === 'spawn_subagent')); assert.equal(setup.data.toolsSource, 'configured-mcp-allowlist');
    assert.ok(rows.some(row => row.type === 'diagnostic.backend' && row.data.outcome === 'control-initialized'));
    assert.ok(rows.some(row => row.type === 'diagnostic.prompt' && row.data.outcome === 'written-to-stdio'));
    assert.ok(!text.includes(host.token)); assert.ok(!text.includes(host.socket));
  } finally { await engine.close(); await host.close(); }
});

test('redaction handles whole private-key blocks and nested bindings before any clipping', () => {
  const redactor = diagnosticRedactor({ secrets: [] });
  const result = redactor.scrub({ privateKey: 'private-binding', nested: { environment: { OWNER_TOKEN: 'binding' }, text: 'safe\n-----BEGIN PRIVATE KEY-----\nprivate key material\n-----END PRIVATE KEY-----\nvisible' } });
  assert.equal(result.privateKey, undefined); assert.equal(result.nested.environment, undefined);
  assert.doesNotMatch(result.nested.text, /private key material/); assert.match(result.nested.text, /visible/);
});
