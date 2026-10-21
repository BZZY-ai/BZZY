import { diagnosticError } from './diagnostic-error.js';

// Intervals must neither overlap async work nor turn a transient I/O failure into
// an uncaught exception. The owner decides whether it can retry or must stop.
export function guardedInterval(operation, milliseconds, { label = 'Background task', onError } = {}) {
  let running = false, failures = 0, lastLog = 0;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try { await operation(); failures = 0; }
    catch (error) {
      failures++;
      if (Date.now() - lastLog >= 10000) { lastLog = Date.now(); process.stderr.write(`${label}: ${diagnosticError(error)}\n`); }
      try { await onError?.(error, failures); } catch { /* The persistence layer may still be unavailable. */ }
    } finally { running = false; }
  }, milliseconds);
}
