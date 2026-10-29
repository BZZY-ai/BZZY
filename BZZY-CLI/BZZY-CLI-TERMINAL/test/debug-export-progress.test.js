import test from 'node:test';
import assert from 'node:assert/strict';
import { safeDebugExportProgress, debugExportProgressLines, createDebugExportProgressReporter, debugExportContextNotice, debugExportSummary } from '../src/debug-export-progress.js';

test('capture summaries distinguish complete and bounded mode and captured data from ZIP size', () => {
  assert.equal(debugExportSummary({ full: true, captureMode: 'complete', files: 1000, uncompressedBytes: 5 * 1024 ** 3, bytes: 2 * 1024 ** 3 }),
    'Complete capture · 1,000 files · 5.00 GiB captured · 2.00 GiB ZIP');
  assert.equal(debugExportSummary({ full: true, captureMode: 'bounded', files: 0, uncompressedBytes: 0, bytes: 0 }),
    'Bounded capture · 0 files · 0 B captured · 0 B ZIP');
  assert.equal(debugExportSummary({ full: false }), null);
  assert.equal(debugExportSummary({ full: true, captureMode: 'PRIVATE', files: -1, uncompressedBytes: Infinity, bytes: 'PRIVATE' }), 'Full capture');
  assert.match(debugExportProgressLines({ phase: 'history' }, { captureMode: 'complete' }).join('\n'), /complete capture/);
  assert.match(debugExportProgressLines({ phase: 'history' }, { captureMode: 'bounded' }).join('\n'), /bounded capture/);
  assert.doesNotMatch(debugExportProgressLines({ phase: 'history' }, { captureMode: 'PRIVATE' }).join('\n'), /PRIVATE/);
});

test('successful context-limited export distinguishes retained diagnostics from omitted project files', () => {
  const message = debugExportContextNotice({ full: true, contextLimited: true, contextBudget: { reason: 'PRIVATE_TEXT' } });
  assert.match(message, /Project file capture reached its budget/);
  assert.match(message, /Saved session history and memory streams are retained/);
  assert.match(message, /project or evidence files are omitted/);
  assert.match(message, /manifest\.exclusions/); assert.doesNotMatch(message, /PRIVATE_TEXT/);
  for (const result of [undefined, {}, { full: true }, { full: true, contextLimited: false }, { full: true, contextLimited: 'true' }, { full: false, contextLimited: true }]) {
    assert.equal(debugExportContextNotice(result), null);
  }
});

test('progress renders only trusted phases and numeric counters with truthful waiting time', () => {
  assert.equal(safeDebugExportProgress({ phase: 'toString', path: 'PRIVATE' }), null);
  const progress = safeDebugExportProgress({ phase: 'packaging', files: -1, bytes: Infinity, records: 'PRIVATE',
    packagedFiles: 12, packagedBytes: 1024 ** 2, exclusions: 2, path: 'PRIVATE', message: 'PRIVATE' });
  const text = debugExportProgressLines(progress, { elapsedMs: 65000, quietMs: 12000 }).join('\n');
  assert.match(text, /Packaging ZIP.*1m 05s elapsed/); assert.match(text, /12 files packaged.*1\.0 MiB processed/);
  assert.match(text, /2 capture omissions/); assert.match(text, /Last progress update 12s ago/);
  assert.doesNotMatch(text, /PRIVATE|Infinity|NaN|-1|%/);
});

test('command progress uses its separate stream, throttles repeated updates and stops on close', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0, text = '';
  const reporter = createDebugExportProgressReporter({ stream: { write: value => { text += value; } }, now: () => clock });
  reporter.update({ phase: 'history', records: 10 }); const initial = text;
  reporter.update({ phase: 'history', records: 11 }); assert.equal(text, initial);
  clock = 15000; t.mock.timers.tick(1000);
  assert.match(text, /11 records/); assert.match(text, /Last progress update 15s ago/);
  reporter.close(); const final = text; clock = 30000; t.mock.timers.tick(10000);
  reporter.update({ phase: 'complete' }); assert.equal(text, final);
});

test('broken progress display cannot fail the export callback', () => {
  const reporter = createDebugExportProgressReporter({ stream: { isTTY: true, write: () => { throw new Error('closed output'); } } });
  assert.doesNotThrow(() => reporter.update({ phase: 'history', records: 10 }));
  assert.doesNotThrow(() => reporter.close());
});

test('a narrow command terminal keeps quiet-worker feedback ahead of counters', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let clock = 0, text = '';
  const reporter = createDebugExportProgressReporter({ stream: { isTTY: true, columns: 72, write: value => { text += value; } }, now: () => clock });
  reporter.update({ phase: 'workspace', records: 999999, events: 999999, files: 999999, bytes: 1024 ** 3 });
  clock = 15000; t.mock.timers.tick(1000);
  assert.match(text.split('\r').at(-1), /15s elapsed · last update 15s ago/);
  reporter.close();
});
