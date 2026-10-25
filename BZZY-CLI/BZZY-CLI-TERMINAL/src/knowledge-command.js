import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CoreKnowledge } from '@bzzy/core/knowledge';
import { findSession } from './store.js';
import { activateCLIHost } from '@bzzy/core/engine/host-service.js';

export function readKnowledgeDefinition(filename, cwd) {
  if (!filename) throw new Error('Choose a reviewed JSON definition file.');
  const file = path.resolve(cwd, filename), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Knowledge definitions must be regular unlinked JSON files up to 1 MiB.');
    let value;
    try {
      const bytes = fs.readFileSync(fd);
      if (bytes.length > 1024 * 1024) throw new Error('oversized');
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    catch { throw new Error('Knowledge definitions must contain valid UTF-8 JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use a JSON object for the knowledge operation.');
    return value;
  } finally { fs.closeSync(fd); }
}

export async function knowledgeCLI(args, options, ui) {
  const admin = new CoreKnowledge(), [command = 'status', ...rest] = args;
  let operation, input;
  if (command === 'status') { operation = 'status'; input = { cwd: options.cwd }; }
  else if (command === 'search') { operation = 'search'; input = { cwd: options.cwd, query: rest.join(' '), limit: 30 }; }
  else if (command === 'profiles') { operation = 'profiles'; input = {}; }
  else if (command === 'learning') { operation = 'learning.list'; input = { sessionId: findSession(rest[0], options.cwd).id }; }
  else if (command === 'review') { operation = 'learning.queue'; input = { sessionId: findSession(rest[0], options.cwd).id, requestId: randomUUID() }; }
  else if (command === 'request') {
    if (rest.length !== 2) throw new Error('Use bzzy knowledge request OPERATION FILE.json.');
    operation = rest[0]; input = readKnowledgeDefinition(rest[1], options.cwd);
  } else throw new Error('Use bzzy knowledge status|search TEXT|profiles|learning [SESSION]|review [SESSION]|request OPERATION FILE.json.');
  if (['learning.queue', 'candidate.evaluate', 'session-memory.queue', 'session-memory.rebuild'].includes(operation) || ['learning.control', 'session-memory.control'].includes(operation) && input.action === 'resume') await activateCLIHost();
  const result = admin.request(operation, input);
  ui.event('info', { result, message: JSON.stringify(result, null, 2) });
  return 0;
}

export async function sessionMemoryCLI(args, options, ui) {
  const [action = 'status', target, ...extra] = args;
  if (!['status', 'read', 'build', 'pause', 'resume', 'cancel'].includes(action) || extra.length) throw new Error('Use bzzy session-memory status|read|build|pause|resume|cancel [SESSION].');
  const admin = new CoreKnowledge(), sessionId = findSession(target, options.cwd).id;
  let result;
  if (['pause', 'resume', 'cancel'].includes(action)) {
    const status = admin.request('session-memory.status', { sessionId });
    if (action === 'resume') await activateCLIHost();
    result = admin.request('session-memory.control', { sessionId, action, expectedRevision: status.control.revision });
  } else {
    if (action === 'build') await activateCLIHost();
    result = admin.request(`session-memory.${action === 'build' ? 'queue' : action}`, { sessionId });
  }
  ui.event('info', { result, message: JSON.stringify(result, null, 2) });
  return 0;
}
