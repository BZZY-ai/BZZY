import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreAssistant } from '../src/assistant.js';
import { backgroundModelSettings, configureBackgroundModel } from '../src/engine/background-model.js';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider, saveConfig, config } from '../src/engine/providers.js';
import { getRecord, listRecords, appendEvent } from '../src/engine/database.js';
import { queueSessionCompaction, processSessionCompactions, sessionCompactionSettings, pauseSessionCompaction } from '../src/engine/session-compactor.js';
import { synthesizeDebateConsensus } from '../src/engine/debate-consensus.js';

let root, previousHome;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-background-model-')));
  process.env.BZZY_HOME = path.join(root, 'private');
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});
const core = (provider = 'codex', model = 'core-one', effort = 'default') => {
  const assistant = new CoreAssistant();
  return assistant.configure({ source: 'core', provider, model, effort }, { expectedRevision: assistant.settings().revision, requestId: randomUUID() });
};
const custom = (provider = 'deepseek', model = 'background-one', effort = 'low') => configureBackgroundModel({ source: 'custom', provider, model, effort }, { expectedRevision: backgroundModelSettings().revision });
const source = () => createSession(getProvider('codex'), root, 'terminal-model');
const queue = session => {
  for (let index = 0; index < 8; index++) appendEvent(session.id, index % 2 ? 'text' : 'message.user', {
    text: `Observation ${index}: ${'Preserve uncertainty and controlled negative evidence. '.repeat(8)}` });
  queueSessionCompaction(session, { force: true });
  return listRecords('core.session.compactor.job', { sessionId: session.id })[0];
};
const consensus = session => synthesizeDebateConsensus(session, { goalSatisfaction: 'inconclusive', assessment: { passed: false }, unresolvedDisagreement: ['Controls remain incomplete.'] }, {
  runModel: async () => ({ text: 'Controls remain incomplete; the original messages are required for verification.', tokens: 50, usageAvailable: true }),
});

test('default background selection inherits live Core settings and never chooses terminal defaults', () => {
  saveConfig({ version: 1, defaultProvider: 'deepseek', defaultSelection: { provider: 'deepseek', model: 'terminal-default', effort: 'high' }, providers: {} });
  assert.deepEqual(backgroundModelSettings(), { source: 'core', revision: 0, configured: false, selection: null, coordinatorRevision: 0 });
  assert.equal(getRecord('core.background-model', 'default'), null);
  core(); assert.deepEqual(backgroundModelSettings().selection, { provider: 'codex', model: 'core-one', effort: 'default' });
  core('claude', 'core-two');
  assert.equal(backgroundModelSettings().selection.model, 'core-two'); assert.equal(backgroundModelSettings().coordinatorRevision, 2);
  assert.equal(backgroundModelSettings().revision, 0); assert.equal(config().defaultSelection.model, 'terminal-default');
  assert.equal(getRecord('core.background-model', 'default'), null); assert.equal(listRecords('execution').length, 0);
});

test('custom background selection works with unconfigured Core and changes no assistant or terminal defaults', () => {
  const before = config(), selected = custom('deepseek', null, 'low');
  assert.deepEqual(selected, { source: 'custom', revision: 1, configured: true, selection: { provider: 'deepseek', model: getProvider('deepseek').model, effort: 'low' }, coordinatorRevision: null });
  assert.equal(new CoreAssistant().settings().configured, false); assert.equal(getRecord('core.assistant', 'default'), null);
  assert.deepEqual(config(), before); assert.equal(listRecords('session').length, 0); assert.equal(listRecords('execution').length, 0);
  assert.deepEqual(Object.keys(getRecord('core.background-model', 'default')).sort(), ['revision', 'selection', 'source', 'updatedAt']);
});

test('shared settings validate installed providers, effort capabilities and exact CAS revisions', () => {
  for (const expectedRevision of [undefined, -1, 0.5, '0']) assert.throws(() => configureBackgroundModel({ source: 'core' }, { expectedRevision }), { code: 'INVALID_REQUEST' });
  assert.throws(() => configureBackgroundModel({ source: 'core', provider: 'codex' }, { expectedRevision: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => configureBackgroundModel({ source: 'custom', provider: 'not-installed' }, { expectedRevision: 0 }), { code: 'PROVIDER_UNAVAILABLE' });
  assert.throws(() => configureBackgroundModel({ source: 'custom', provider: 'deepseek', effort: 'medium' }, { expectedRevision: 0 }), { code: 'INVALID_REQUEST' });
  assert.throws(() => configureBackgroundModel({ source: 'custom', provider: 'codex', apiKey: 'fixture-no-credentials-accepted' }, { expectedRevision: 0 }), { code: 'INVALID_REQUEST' });
  custom(); assert.throws(() => configureBackgroundModel({ source: 'core' }, { expectedRevision: 0 }), { code: 'CONFLICT' });
  assert.equal(backgroundModelSettings().revision, 1);
});

test('idempotent settings receipts preserve the exact original snapshot and reject changed requests', () => {
  core(); const input = { source: 'custom', provider: 'deepseek', model: 'snapshot-model', effort: 'low' }, requestId = randomUUID();
  const saved = configureBackgroundModel(input, { expectedRevision: 0, requestId });
  configureBackgroundModel({ source: 'core' }, { expectedRevision: 1 }); core('claude', 'later-core');
  assert.deepEqual(configureBackgroundModel(input, { expectedRevision: 0, requestId }), saved);
  assert.equal(backgroundModelSettings().selection.model, 'later-core'); assert.equal(backgroundModelSettings().revision, 2);
  assert.throws(() => configureBackgroundModel({ ...input, model: 'different-model' }, { expectedRevision: 0, requestId }), { code: 'CONFLICT' });
});

test('custom selection remains independent until an explicit return to Core inheritance', () => {
  core(); custom(); core('claude', 'updated-core'); assert.equal(backgroundModelSettings().selection.model, 'background-one');
  const inherited = configureBackgroundModel({ source: 'core' }, { expectedRevision: 1 });
  assert.equal(inherited.selection.model, 'updated-core'); assert.equal(inherited.coordinatorRevision, 2);
  core('codex', 'newest-core'); assert.equal(backgroundModelSettings().selection.model, 'newest-core');
  assert.equal(backgroundModelSettings().revision, 2); assert.equal(backgroundModelSettings().coordinatorRevision, 3);
});

test('compactor pins old selections while fresh jobs and consensus share the current override', async () => {
  core(); const first = source(), original = queue(first); custom(); const second = source(), newer = queue(second);
  assert.equal(original.selectionSource, 'core'); assert.equal(original.backgroundModelRevision, 0); assert.equal(original.coordinatorRevision, 1);
  assert.equal(newer.selectionSource, 'custom'); assert.equal(newer.backgroundModelRevision, 1); assert.equal(newer.coordinatorRevision, null);
  const review = source(); review.goal = { id: randomUUID(), status: 'active' };
  // Persisted session state is authoritative during document model checks.
  saveSession(review);
  const summary = await consensus(review); assert.equal(summary.selection.model, 'background-one'); assert.equal(summary.selectionSource, 'custom'); assert.equal(summary.backgroundModelRevision, 1);
  core('claude', 'changed-core'); configureBackgroundModel({ source: 'core' }, { expectedRevision: 1 });
  const observed = [];
  for (let index = 0; index < 2; index++) {
    const [done] = await processSessionCompactions({ authAvailable: async () => true, runModel: async input => {
      observed.push(input.selection.model); return { text: 'Keep the observations inconclusive and retain original event references.', tokens: 100, usageAvailable: true };
    } });
    assert.equal(done.state, 'completed');
  }
  assert.deepEqual(observed.sort(), ['background-one', 'core-one']); assert.equal(loadSession(first.id).model, 'terminal-model');
  assert.equal(sessionCompactionSettings().selectionSource, 'core'); assert.equal(sessionCompactionSettings().backgroundModelRevision, 2);
  const after = await consensus(review); assert.equal(after.selection.model, 'changed-core'); assert.equal(after.coordinatorRevision, 2);
});

test('a running consensus retains its override snapshot and the following request uses the new revision', async () => {
  core(); custom(); const session = source(); session.goal = { id: randomUUID(), status: 'active' };
  saveSession(session);
  const first = await synthesizeDebateConsensus(session, { assessment: { passed: false }, goalSatisfaction: 'inconclusive' }, { runModel: async input => {
    assert.equal(input.selection.model, 'background-one'); custom('claude', 'background-two', 'default');
    return { text: 'Historical controls still require inspection.', tokens: 20, usageAvailable: true };
  } });
  assert.equal(first.state, 'ready'); assert.equal(first.selection.model, 'background-one'); assert.equal(first.backgroundModelRevision, 1);
  const second = await consensus(session); assert.equal(second.selection.model, 'background-two'); assert.equal(second.backgroundModelRevision, 2);
  assert.equal(new CoreAssistant().settings().selection.model, 'core-one');
});

test('unconfigured pending jobs adopt the explicit shared override without configuring Core or replaying paused work', async () => {
  const session = source(), pending = queue(session);
  const [waiting] = await processSessionCompactions({ runModel: () => assert.fail('No provider is implied by terminal defaults') });
  assert.equal(waiting.state, 'waiting_for_configuration'); assert.equal(waiting.selection, null);
  custom('deepseek', 'explicit-background', 'low');
  const [completed] = await processSessionCompactions({ authAvailable: async provider => { assert.equal(provider.id, 'deepseek'); return true; }, runModel: async input => {
    assert.equal(input.selection.model, 'explicit-background'); return { text: 'Original controls remain inconclusive.', tokens: 100, usageAvailable: true };
  } });
  assert.equal(completed.id, pending.id); assert.equal(completed.state, 'completed'); assert.equal(completed.selectionSource, 'custom');
  assert.equal(completed.backgroundModelRevision, 1); assert.equal(completed.coordinatorRevision, null);
  assert.equal(new CoreAssistant().settings().configured, false);
  const paused = source(); queue(paused);
  pauseSessionCompaction(paused.id, 'owner_pause');
  custom('claude', 'later-background', 'default');
  assert.deepEqual(await processSessionCompactions({ runModel: () => assert.fail('Changing a default must not resume stopped work') }), []);
});
