// Only host transport events create these receipts. Error properties, stderr
// and provider replies are not diagnostic authority.
const failures = new WeakMap();
const signals = new Set(['SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL',
  'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGXCPU', 'SIGXFSZ']);

export function markRpcFailure(error, { kind, exitCode, signal } = {}) {
  if (!(error instanceof Error) || !['timeout', 'process_exit'].includes(kind)) throw new Error('Invalid RPC transport failure.');
  const failure = { kind };
  if (kind === 'process_exit' && Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255) failure.exitCode = exitCode;
  if (kind === 'process_exit' && signals.has(signal)) failure.signal = signal;
  failures.set(error, Object.freeze(failure));
  return error;
}

export function rpcFailure(error) {
  const failure = error && typeof error === 'object' && failures.get(error);
  return failure ? { ...failure } : null;
}
