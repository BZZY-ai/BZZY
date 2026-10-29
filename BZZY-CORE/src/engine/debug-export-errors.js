// Owner-facing export diagnostics never echo raw exceptions, source contents,
// subprocess stderr or private paths. Preserve a small stable category instead.
const reasons = {
  SESSION_DEBUG_ACCESS: 'Access to required data or the output directory was denied.',
  SESSION_DEBUG_SPACE: 'The output or private staging disk has no available space.',
  SESSION_DEBUG_MISSING: 'A required directory or diagnostic resource is unavailable.',
  SESSION_DEBUG_EXISTS: 'The selected output file already exists. Choose a new filename.',
  SESSION_DEBUG_OPEN_FILES: 'The host reached its open-file limit. Close unused files and retry.',
  SESSION_DEBUG_PATH: 'The output path is too long. Choose a shorter filename.',
  SESSION_DEBUG_SIZE: 'The export reached a diagnostic size limit; no incomplete export was published.',
  SESSION_DEBUG_SOURCE_SIZE: 'A source exceeded the buffered capture boundary. Complete project capture supports large files using disk-backed processing.',
  SESSION_DEBUG_CAPTURE_MODE: 'Choose complete capture without a context byte budget, or bounded capture with its optional byte budget.',
  SESSION_DEBUG_START: 'The detached export process could not start. No session work was resumed.',
  SESSION_DEBUG_INTERRUPTED: 'The export process stopped before confirming completion. Inspect its output before retrying.',
  SESSION_DEBUG_PYTHON: 'Full debug ZIP requires Python 3.9 or newer on PATH.',
  SESSION_DEBUG_PACKAGE: 'The ZIP packager could not finish. Check available disk space and retry.',
  SESSION_DEBUG_PRIVATE_STORAGE: 'Full debug needs a project separate from private Core storage.',
  SESSION_DEBUG_OUTPUT: 'Choose a new .zip file for full debug.',
  SESSION_DEBUG_SESSION: 'Choose an existing parent terminal session.',
  SESSION_DEBUG_STAGING: 'Private debug staging is unavailable or unsafe.',
  SESSION_DEBUG_COLLISIONS: 'Too many exports already use this name and date. Choose a new filename.',
  SESSION_DEBUG_FAILED: 'Required diagnostic data could not be collected safely.',
};
const filesystem = { EACCES: 'ACCESS', EPERM: 'ACCESS', ENOSPC: 'SPACE', EDQUOT: 'SPACE', ENOENT: 'MISSING',
  EEXIST: 'EXISTS', EMFILE: 'OPEN_FILES', ENFILE: 'OPEN_FILES', ENAMETOOLONG: 'PATH', EFBIG: 'SIZE' };
const phases = { session: 'reading the saved chat', destination: 'preparing the output directory', staging: 'preparing private staging',
  overview: 'writing the supplementary overview', history: 'reading saved history', workspace: 'capturing project context',
  resources: 'capturing diagnostic resources', manifest: 'writing the manifest', packaging: 'packaging the ZIP' };

export function debugExportDiagnostic(error, phase = error?.exportPhase) {
  const code = Object.hasOwn(reasons, error?.code) ? error.code
    : Object.hasOwn(filesystem, error?.code) ? 'SESSION_DEBUG_' + filesystem[error.code] : 'SESSION_DEBUG_FAILED';
  return { code, message: reasons[code], ...(Object.hasOwn(phases, phase) ? { phase, operation: phases[phase] } : {}) };
}
export function debugExportFailure(code) {
  const selected = Object.hasOwn(reasons, code) ? code : 'SESSION_DEBUG_FAILED';
  return Object.assign(new Error(reasons[selected]), { code: selected });
}
export function wrapDebugExportFailure(error, phase) {
  const diagnostic = debugExportDiagnostic(error, phase);
  return Object.assign(new Error(`${diagnostic.message}${diagnostic.operation ? ` Failed while ${diagnostic.operation}.` : ''} [${diagnostic.code}]`),
    { code: diagnostic.code, ...(diagnostic.phase ? { exportPhase: diagnostic.phase } : {}) });
}
export function debugExportErrorMessage(error, { full = false } = {}) {
  const diagnostic = debugExportDiagnostic(error);
  const command = full ? 'bzzy debug full NAME FILE.zip' : 'bzzy debug export NAME FILE.md';
  return `${full ? 'Full debug ZIP' : 'Session debug'} export failed${diagnostic.operation ? ` while ${diagnostic.operation}` : ''}. ${diagnostic.message} [${diagnostic.code}] Retry here, or use ${command} from a terminal with a writable output folder.`;
}
