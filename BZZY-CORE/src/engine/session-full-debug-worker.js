import { parentPort, workerData } from 'node:worker_threads';
import { exportFullSessionDebug } from './session-full-debug.js';
import { debugExportDiagnostic } from './debug-export-errors.js';

// Only the trusted local export API creates this worker. Model tools and remote
// clients have no entry point; progress contains counts, never source contents.
try {
  const result = await exportFullSessionDebug(workerData.sessionId, { ...workerData.options,
    onProgress: value => parentPort.postMessage({ type: 'progress', value }) });
  parentPort.postMessage({ type: 'result', value: result });
} catch (error) {
  const diagnostic = debugExportDiagnostic(error);
  parentPort.postMessage({ type: 'error', value: { code: diagnostic.code, exportPhase: diagnostic.phase } });
} finally { parentPort.close(); }
