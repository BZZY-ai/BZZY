import fs from 'node:fs';
import path from 'node:path';
import { loadSession } from '@bzzy/core/engine/store.js';
import { projectDirectory } from '@bzzy/core/engine/project.js';

// Read the selected saved chat, never the shell cwd or a previous tab's view.
// This projection creates no project metadata or identity records.
export function sessionProjectLocation(sessionId) {
  if (!sessionId) return { sessionId: null, status: 'unavailable', reason: 'No saved session selected.' };
  let session;
  try { session = loadSession(sessionId); }
  catch { return { sessionId, status: 'unavailable', reason: 'The saved session is unavailable.' }; }
  let directory, resolved = true;
  try { directory = projectDirectory(session, { readOnly: true }); }
  catch {
    resolved = false;
    // A missing moved directory can still have a durable pinned location.
    // Report it as saved/unavailable instead of guessing from current cwd.
    if (typeof session?.projectRoot === 'string' && path.isAbsolute(session.projectRoot) &&
        (!session.agentNamespace || /^[a-zA-Z0-9_-]{1,80}$/.test(session.agentNamespace))) {
      directory = path.join(session.projectRoot, '.bzzy', ...(session.agentNamespace ? ['agents', session.agentNamespace] : []));
    }
  }
  if (!directory) return { sessionId, status: 'unavailable', reason: 'The saved project location could not be resolved.' };
  try {
    const stat = fs.lstatSync(directory);
    if (!resolved || !stat.isDirectory() || stat.isSymbolicLink()) return { sessionId, path: directory, status: 'unavailable', reason: 'The saved project folder could not be verified.' };
    return { sessionId, path: directory, status: 'exists' };
  } catch (error) {
    return { sessionId, path: directory, status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable',
      reason: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'The saved project folder is missing.' : 'The saved project folder is unavailable.' };
  }
}

export function sessionProjectDetails(location) {
  return [
    'Session .bzzy folder', location.path || 'Location unavailable',
    location.status === 'exists' ? 'Folder exists.' : location.reason,
    'This is the project folder tied to the selected saved chat.',
  ].filter(Boolean).join('\n');
}
