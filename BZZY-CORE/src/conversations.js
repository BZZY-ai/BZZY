import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, normalizeSessionAlias, getProvider, providers, putRecord, appendEvent, now, loadSession, writeJson, sessionPath } from './engine.js';
import { fail, object } from './validation.js';
import { canonicalPath, contains } from './paths.js';
import { providerModelCapabilities } from './engine/providers.js';

export function workspaceDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_REQUEST', 'Choose an absolute local workspace directory.');
  const cwd = fs.realpathSync(value);
  if (!fs.statSync(cwd).isDirectory()) fail('INVALID_REQUEST', 'The workspace must be a directory.');
  if (contains(canonicalPath(home()), cwd)) fail('FORBIDDEN', 'Private Core storage cannot be a conversation workspace.', 403);
  return cwd;
}

export function providerSelection(input) {
  object(input, ['provider', 'model', 'effort']);
  if (typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.provider) || !Object.hasOwn(providers(), input.provider)) fail('PROVIDER_UNAVAILABLE', 'Choose an installed provider.');
  const provider = getProvider(input.provider);
  const model = input.model ?? provider.model ?? null, effort = input.effort ?? 'default';
  if (model !== null && (typeof model !== 'string' || !/^[^\s\x00-\x1f\x7f-\x9f]{1,200}$/u.test(model))) fail('INVALID_REQUEST', 'Invalid model name.');
  if (typeof effort !== 'string' || !/^(?:default|[a-z][a-z0-9_-]{0,23})$/.test(effort)) fail('INVALID_REQUEST', 'Invalid reasoning effort.');
  const supported = providerModelCapabilities(provider, model).supportedEfforts;
  if (effort !== 'default' && supported?.length && !supported.includes(effort)) fail('INVALID_REQUEST', 'This model does not support the selected reasoning effort.');
  return { provider: provider.id, model, effort };
}

export function conversationInput(input) {
  object(input, ['provider', 'cwd', 'model', 'alias', 'effort']);
  return { ...providerSelection({ provider: input.provider, model: input.model, effort: input.effort }),
    cwd: workspaceDirectory(input.cwd), alias: input.alias == null ? undefined : normalizeSessionAlias(input.alias) };
}

// Caller owns the transaction. All clients still use the terminal's session
// format, database, queue and provider adapters.
export function insertConversation(input, db, metadata = {}) {
  const provider = getProvider(input.provider);
  const session = { version: 1, id: randomUUID(), provider: provider.id, backend: provider.backend, cwd: input.cwd, model: input.model,
    engineThreadId: null, createdAt: now(), updatedAt: now(), turns: 0, goal: null, executionState: 'idle', selectedEffort: input.effort,
    ...(input.alias === undefined ? {} : { alias: input.alias }), ...metadata };
  putRecord('session', session.id, session, db);
  appendEvent(session.id, 'lifecycle', { status: null, executionState: 'idle', reason: null }, db);
  appendEvent(session.id, 'session.created', { provider: session.provider, model: session.model }, db);
  return session;
}

export function conversationExport(id) {
  const session = loadSession(id);
  // A retry refreshes the compatibility export from current authoritative state.
  writeJson(sessionPath(id), session);
  return session;
}
