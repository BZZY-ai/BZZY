import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { operatorStopIntent, operatorStopRequested, persistOperatorStopIntent, clearOperatorStopIntent } from '../src/engine/runtime.js';

let directory, previous;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-stop-intent-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
});
test.afterEach(() => {
  if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('legacy stops remain explicit user intent and cannot be cleared as a failed service start', () => {
  const file = path.join(process.env.BZZY_HOME, 'runtime', 'operator-stop.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = JSON.stringify({ version: 1, stopped: true, stoppedAt: '2026-10-25T01:00:00.000Z' }); fs.writeFileSync(file, legacy);
  assert.equal(operatorStopRequested(), true); assert.equal(operatorStopIntent().source, 'operator');
  assert.equal(clearOperatorStopIntent({ expectedSource: 'service_start_failure', expectedAttemptId: randomUUID() }), false);
  persistOperatorStopIntent({ source: 'service_start_failure', attemptId: randomUUID() });
  assert.equal(fs.readFileSync(file, 'utf8'), legacy);
  assert.equal(clearOperatorStopIntent(), true); assert.equal(operatorStopRequested(), false);
});

test('recovery can remove only its exact automatic failure receipt', () => {
  const attemptId = randomUUID(), receipt = persistOperatorStopIntent({ source: 'service_start_failure', attemptId });
  assert.equal(receipt.source, 'service_start_failure'); assert.equal(receipt.attemptId, attemptId);
  assert.equal(clearOperatorStopIntent({ expectedSource: 'service_start_failure', expectedAttemptId: randomUUID() }), false);
  assert.deepEqual(operatorStopIntent(), receipt);
  assert.equal(clearOperatorStopIntent({ expectedId: randomUUID(), expectedSource: 'service_start_failure', expectedAttemptId: attemptId }), false);
  assert.equal(clearOperatorStopIntent({ expectedId: receipt.id, expectedSource: 'service_start_failure', expectedAttemptId: attemptId }), true);
  assert.equal(operatorStopIntent(), null);
});

test('a later explicit Stop wins over automatic start-failure and rollback operations', () => {
  const attemptId = randomUUID(), failed = persistOperatorStopIntent({ source: 'service_start_failure', attemptId });
  const stopped = persistOperatorStopIntent();
  assert.equal(stopped.source, 'operator'); assert.notEqual(stopped.id, failed.id);
  assert.deepEqual(persistOperatorStopIntent({ source: 'service_start_failure', attemptId }), stopped);
  assert.equal(clearOperatorStopIntent({ expectedId: failed.id }), false);
  assert.equal(clearOperatorStopIntent({ expectedSource: 'service_start_failure', expectedAttemptId: attemptId }), false);
  assert.deepEqual(operatorStopIntent(), stopped);
});

test('automatic failure receipts require a valid attempt and do not alter state on invalid provenance', () => {
  for (const options of [{ source: 'unknown' }, { source: 'service_start_failure' }, { source: 'service_start_failure', attemptId: '../other-context' }])
    assert.throws(() => persistOperatorStopIntent(options), /Invalid Core stop provenance/);
  assert.equal(operatorStopIntent(), null);
  assert.equal(fs.existsSync(path.join(process.env.BZZY_HOME, 'runtime')), false);
});
