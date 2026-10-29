import { runDebugExportJob, finishDebugExportJob } from './debug-export-jobs.js';
import { debugExportFailure } from './debug-export-errors.js';

const id = process.argv[2];
try {
  await runDebugExportJob(id, () => {
    if (process.connected) {
      process.send({ type: 'ready', jobId: id }, () => { if (process.connected) process.disconnect(); });
    }
  });
} catch {
  if (/^[a-f0-9-]{36}$/i.test(id || '')) finishDebugExportJob(id, { error: debugExportFailure('SESSION_DEBUG_START') });
} finally { if (process.connected) process.disconnect(); }
