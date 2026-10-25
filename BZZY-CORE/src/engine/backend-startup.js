// These receipts describe host adapter startup, before any model turn is sent.
// Never persist backend stderr, error messages, arguments or environment values.
const stages = new Set(['version', 'configuration', 'process_spawn', 'initialize', 'permission_profile',
  'thread_start', 'thread_resume', 'permission_activation']);
const systemCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'ENOTDIR', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT']);
const receipts = new WeakMap();

export function markBackendStartupFailure(error, stage) {
  if (!stages.has(stage)) throw new Error('Invalid backend startup stage.');
  const failure = error instanceof Error ? error : new Error('The model backend could not initialize.');
  receipts.set(failure, Object.freeze({ version: 1, backend: 'codex', stage, modelRequestStarted: false,
    ...(systemCodes.has(failure.code) ? { systemCode: failure.code } : {}),
    ...(Number.isSafeInteger(failure.rpcCode) ? { rpcCode: failure.rpcCode } : {}) }));
  return failure;
}

// An arbitrary model response or an untrusted error property cannot manufacture
// a zero-usage receipt. Only an adapter-marked pre-turn failure is recognized.
export function backendStartupFailure(error) {
  const receipt = error && typeof error === 'object' && receipts.get(error);
  return receipt ? { ...receipt } : null;
}
