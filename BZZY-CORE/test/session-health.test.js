import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { getRecord, putRecord, listRecords } from '../src/engine/database.js';
import { sessionHealth } from '../src/engine/session-health.js';

test('health separates scheduling deferral from durable stop reasons without changing records', () => {
  const previous = process.env.BZZY_HOME;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-session-health-')));
  try {
    process.env.BZZY_HOME = path.join(root, 'private');
    const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
    const session = createSession(getProvider('codex'), cwd);
    const states = [
      { state: 'queued', scheduleReason: 'foreground_priority', reasonPaused: null },
      { state: 'paused', scheduleReason: 'foreground_priority', reasonPaused: 'host_shutdown' },
      { state: 'paused', scheduleReason: 'foreground_priority', reasonPaused: 'owner_pause' },
      { state: 'cancelled', scheduleReason: 'foreground_priority', reasonPaused: 'owner_cancel' },
    ];
    const kinds = ['core.learning.job', 'core.session.compactor.job'];
    for (const kind of kinds) for (const [index, state] of states.entries()) {
      putRecord(kind, String(index), { id: String(index), sessionId: session.id, ...state });
    }
    const before = kinds.map(kind => listRecords(kind));
    const health = sessionHealth(session.id);
    for (const jobs of [health.learning.jobs, health.retention.jobs]) {
      assert.equal(jobs.length, states.length);
      for (const state of states) {
        const row = jobs.find(row => row.state === state.state && row.reasonPaused === state.reasonPaused);
        assert.deepEqual(row, { ...state, count: 1, reason: state.reasonPaused ?? state.scheduleReason });
      }
    }
    assert.deepEqual(kinds.map(kind => listRecords(kind)), before);
    assert.equal(getRecord('core.session.compactor.control', session.id), null);
  } finally {
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
