import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebugContextBudget, debugExportLimits } from '../src/engine/debug-export-budget.js';

test('optional bytes preserve manifest headroom near the hard stage limit', () => {
  const budget = createDebugContextBudget(), limits = debugExportLimits;
  const mandatory = limits.stageBytes - limits.manifestReserveBytes - 25;
  assert.equal(budget.hasManifestHeadroom(mandatory), true);
  assert.equal(budget.hasManifestHeadroom(limits.stageBytes - limits.manifestReserveBytes), true);
  assert.equal(budget.hasManifestHeadroom(limits.stageBytes - limits.manifestReserveBytes + 1), false,
    'Mandatory data must leave the full bounded metadata reserve before optional omissions are admitted.');
  assert.equal(budget.remainingBytes(mandatory), 25);
  assert.equal(budget.reason(26, mandatory), 'context_stage_headroom');
  assert.equal(budget.reason(25, mandatory), null);
  budget.capture(25);
  assert.equal(budget.remainingBytes(mandatory + 25), 0);
  assert.equal(budget.reason(1, mandatory + 25), 'context_stage_headroom');
  assert.ok(mandatory + 25 + limits.manifestReserveBytes <= limits.stageBytes);
  budget.reserveManifestBase(12 * 1024 ** 2);
  assert.ok(budget.snapshot().manifestReserveBytes > 12 * 1024 ** 2);
  assert.equal(budget.hasManifestHeadroom(mandatory), false);
  assert.equal(budget.remainingBytes(mandatory + 25), 0);
});

test('optional metadata is bounded even for empty files and omitted path lists', () => {
  const budget = createDebugContextBudget({ limitBytes: 100, metadataLimitBytes: 10 });
  assert.equal(budget.metadata(6), true); budget.capture(0);
  assert.equal(budget.metadata(5), false);
  assert.equal(budget.reason(0, 0), 'context_manifest_budget');
  budget.omit({ subtree: true, unlisted: true });
  assert.deepEqual({ files: budget.snapshot().omittedFiles, subtrees: budget.snapshot().omittedSubtrees,
    pathsComplete: budget.snapshot().omittedPathsComplete }, { files: 0, subtrees: 1, pathsComplete: false });
  assert.equal(budget.snapshot().capturedBytes, 0);
});

test('trusted callers can reduce optional context but cannot enlarge the default capture cap', () => {
  assert.equal(createDebugContextBudget({ limitBytes: 0 }).reason(1, 0), 'context_byte_budget');
  for (const limitBytes of [-1, NaN, Infinity, '10', debugExportLimits.contextBytes + 1])
    assert.throws(() => createDebugContextBudget({ limitBytes }), /context budget/);
});
