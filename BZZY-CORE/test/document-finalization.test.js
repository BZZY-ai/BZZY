import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { listRecords } from '../src/engine/database.js';
import { markBackendStartupFailure, backendStartupFailure } from '../src/engine/backend-startup.js';
import { runRestrictedDocumentModel, documentFinalizationFailure } from '../src/engine/document-model.js';
import { sessionCompactorUsage, sessionCompactionCost } from '../src/engine/compaction-cost.js';

let directory, previousHome, source, remove, rename;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-document-finalize-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  source = createSession(getProvider('codex'), directory, 'offline-document-fixture');
  remove = fs.rmSync; rename = fs.renameSync;
});
test.afterEach(() => {
  fs.rmSync = remove; fs.renameSync = rename;
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function runner({ primary, closeFailure, prepare } = {}) {
  return class {
    constructor(_provider, draft, _options, ui) { this.draft = draft; this.ui = ui; }
    async run() {
      prepare?.(this.draft);
      if (primary) throw primary;
      this.draft.usage = { tokens: 7, available: true };
      this.ui.event('text', { text: 'Synthetic assessment text.' });
      return { tokens: 7 };
    }
    async close() { if (closeFailure) closeFailure(); }
  };
}
const invoke = Engine => runRestrictedDocumentModel({ source, prompt: 'Only supplied synthetic state.', instructions: 'Assess supplied state without tools.', Engine });
const primary = () => markBackendStartupFailure(new Error('SYNTHETIC_PRIVATE_INITIALIZATION_DETAIL'), 'initialize');
test('final measured document usage reaches the source compactor ledger even without detailed streaming telemetry', async () => {
  await runRestrictedDocumentModel({ source, prompt: 'Summarize supplied synthetic text.', instructions: 'Use supplied text only.',
    task: { kind: 'session-compaction', id: 'abcd' }, Engine: runner() });
  const usage = sessionCompactorUsage(source.id);
  assert.equal(usage.tokens, 7); assert.equal(usage.complete, true);
  assert.equal(sessionCompactionCost(source.id).estimatedUsd, null);
});

test('close failures, including malformed thrown values, cannot replace the trusted primary startup error', async () => {
  for (const cleanupError of [new Error('SYNTHETIC_PRIVATE_CLEANUP_DETAIL'), { path: 'SYNTHETIC_PRIVATE_PATH' }, undefined]) {
    const initial = primary();
    await assert.rejects(invoke(runner({ primary: initial, closeFailure() { throw cleanupError; } })), error => {
      assert.equal(error, initial); assert.equal(backendStartupFailure(error).stage, 'initialize');
      assert.equal(documentFinalizationFailure(error), null); return true;
    });
  }
  const drafts = listRecords('session').filter(row => row.role === 'learning-review');
  assert.equal(drafts.length, 3);
  for (const draft of drafts) {
    assert.deepEqual(draft.documentCleanupFailure, { version: 1, phase: 'close' });
    assert.equal(draft.backendFailure.stage, 'initialize'); assert.equal(fs.existsSync(draft.cwd), false);
  }
  assert.doesNotMatch(JSON.stringify(drafts), /SYNTHETIC_PRIVATE/);
});

test('state and filesystem cleanup failures preserve the primary error and still attempt later cleanup', async () => {
  for (const phase of ['state', 'workdir', 'backend_home', 'catalog']) {
    const initial = primary(); let target, intercepted = false;
    const Engine = runner({ primary: initial, prepare(draft) {
      const root = path.join(process.env.BZZY_HOME, 'runtime');
      const targets = { state: path.join(process.env.BZZY_HOME, 'sessions', draft.id + '.json'),
        workdir: path.join(root, 'learning', draft.id), backend_home: path.join(root, 'agent-backends', draft.id),
        catalog: path.join(root, draft.id + '-models.json') };
      target = targets[phase];
      fs.mkdirSync(targets.backend_home, { recursive: true }); fs.writeFileSync(targets.catalog, '{}');
      if (phase === 'state') fs.renameSync = function (from, to) {
        if (to === target && !intercepted) { intercepted = true; throw { path: 'SYNTHETIC_PRIVATE_PATH' }; }
        return rename(from, to);
      };
      else fs.rmSync = function (file, options) {
        if (file === target && !intercepted) { intercepted = true; throw { path: 'SYNTHETIC_PRIVATE_PATH' }; }
        return remove(file, options);
      };
    } });
    try {
      await assert.rejects(invoke(Engine), error => { assert.equal(error, initial); return true; });
      assert.equal(intercepted, true);
    } finally { fs.rmSync = remove; fs.renameSync = rename; }
    const draft = listRecords('session').find(row => row.documentCleanupFailure?.phase === phase);
    assert.equal(draft.backendFailure.stage, 'initialize');
    assert.deepEqual(draft.documentCleanupFailure, { version: 1, phase });
    for (const [candidate, exists] of [[path.dirname(draft.cwd), phase === 'workdir'],
      [path.join(process.env.BZZY_HOME, 'runtime', 'agent-backends', draft.id), phase === 'backend_home'],
      [path.join(process.env.BZZY_HOME, 'runtime', draft.id + '-models.json'), phase === 'catalog']]) assert.equal(fs.existsSync(candidate), exists);
  }
  assert.doesNotMatch(JSON.stringify(listRecords('session')), /SYNTHETIC_PRIVATE/);
});

test('successful text cannot become a completed assessment when finalization fails', async () => {
  await assert.rejects(invoke(runner({ closeFailure() { throw new Error('SYNTHETIC_PRIVATE_CLEANUP_DETAIL'); } })), error => {
    assert.equal(error.code, 'DOCUMENT_CLEANUP');
    assert.deepEqual(documentFinalizationFailure(error), { version: 1, phase: 'close' });
    assert.equal(backendStartupFailure(error), null, 'A post-inference cleanup failure cannot claim zero model usage');
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|Synthetic assessment/); return true;
  });
  assert.equal(documentFinalizationFailure(Object.assign(new Error('Untrusted'), { code: 'DOCUMENT_CLEANUP',
    documentCleanupFailure: { version: 1, phase: 'close' } })), null);
});
