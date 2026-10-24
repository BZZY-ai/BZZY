import fs from 'node:fs';
import path from 'node:path';
import { CoreAgents } from '../agents.js';
import { createToolBroker } from '../tool-broker.js';
import { getRecord } from './database.js';
import { home, privateDir } from './files.js';
import { codexHome } from './auth.js';
import { agentProjectFilesystemIntegration } from '../filesystem.js';

export const agentPermissionProfile = 'bzzy_agent_isolated_v1';
export const agentToolNames = new Set(['list_skills', 'read_skill', 'activity', 'get_task_state', 'checkpoint', 'remember', 'recall', 'search_knowledge', 'issue',
  'get_goal', 'update_goal', 'assess_requirement', 'read_project_file']);
const denied = () => { throw Object.assign(new Error('Persistent Agents can use only their isolated project tools. Account access requires a separately authorized host integration.'), { code: 'FORBIDDEN' }); };
const contains = (root, child) => child === root || child.startsWith(root + path.sep);

// Resolve the trusted registry through the saved parent chain. Imported purpose,
// agentId and instructions alone never establish an execution principal.
export function agentExecutionScope(session) {
  const seen = new Set(); let current = getRecord('session', session.id) || session, marked = false;
  if (['cwd', 'parentSessionId', 'purpose', 'agentId'].some(key => (current[key] ?? null) !== (session[key] ?? null))) denied();
  for (let depth = 0; current && depth < 64; depth++) {
    if (seen.has(current.id)) denied(); seen.add(current.id);
    marked ||= current.purpose === 'agent' || Boolean(current.agentId);
    if (current.purpose === 'agent') {
      const agent = new CoreAgents().forSession(current.id);
      if (session.cwd !== fs.realpathSync(session.cwd) || !contains(agent.cwd, session.cwd)) denied();
      return Object.freeze({ agentId: agent.id, rootSessionId: agent.sessionId, cwd: session.cwd, projectRoot: agent.cwd });
    }
    if (!current.parentSessionId) { if (marked) denied(); return null; }
    current = getRecord('session', current.parentSessionId);
    if (!current) denied();
  }
  denied();
}
export function assertAgentScope(session, scope) {
  const live = agentExecutionScope(session);
  if (!live || ['agentId', 'rootSessionId', 'cwd', 'projectRoot'].some(key => live[key] !== scope[key])) denied();
  if (session.projectRoot && session.projectRoot !== scope.projectRoot) denied();
  return live;
}

export function createAgentProjectReader(session, scope) {
  assertAgentScope(session, scope);
  const { admin } = createToolBroker({ integrations: [agentProjectFilesystemIntegration] });
  const principal = { userId: 'local-owner', workspaceId: scope.agentId, agentId: scope.agentId };
  const grant = admin.grant({ principal, integrationId: 'filesystem', capabilities: ['filesystem.read'],
    roots: [{ id: 'project', path: scope.cwd }], expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
  const scoped = admin.scope({ principal, sessionId: session.id });
  let closed = false;
  return Object.freeze({
    async read(input) { if (closed) denied(); assertAgentScope(session, scope); return scoped.invoke('filesystem.read_file', { ...input, root: 'project' }); },
    close() { if (!closed) { closed = true; admin.revokeGrant(grant.id); } },
  });
}

// A provider's native parent may authenticate, but it must not load the owner's
// MCP servers, plugins, hooks or project trust from the owner's Codex config.
// Only the official CLI consumes this private auth-file reference; neither the
// model's sandbox nor portable workspace can read this directory.
export function isolatedAgentCodexHome(provider, session) {
  const original = codexHome(provider), directory = path.join(home(), 'runtime', 'agent-backends', session.id, 'codex');
  privateDir(directory);
  if (provider.auth === 'subscription') {
    const source = path.join(original, 'auth.json'), target = path.join(directory, 'auth.json');
    if (!fs.existsSync(target)) {
      const stat = fs.lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Isolated Agent authentication needs an official local Codex file login. Run bzzy auth codex on this host.');
      fs.symlinkSync(source, target);
    }
  }
  return directory;
}

export function tomlValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return '{' + Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${tomlValue(item)}`).join(', ') + '}';
  return JSON.stringify(value);
}
