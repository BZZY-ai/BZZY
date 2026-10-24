import { providerModels } from './engine/provider-catalog.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, requireNode, getRecord, putRecord, listRecords, reserveRequest, providers, now } from './engine.js';
import { exportSharedAgentProject, importSharedAgentProject } from './engine/project-bundle.js';
import { CoreWorkspaces } from './workspaces.js';
import { object, fail, uuid } from './validation.js';
import { providerSelection, insertConversation, conversationExport } from './conversations.js';
import { assertSessionIdle } from './engine/models.js';
import { writeJson } from './engine/files.js';
import { canonicalPath, contains } from './paths.js';
import { directoryIdentity, matchesDirectoryIdentity } from './engine/directory-identity.js';
import { providerModelCapabilities } from './engine/providers.js';

const summary = row => {
  const session = getRecord('session', row.sessionId);
  return { id: row.id, name: row.name, provider: row.provider, model: row.model, effort: row.effort,
    cwd: row.cwd, sessionId: row.sessionId, revision: row.revision, state: session?.executionState || 'idle',
    goalStatus: session?.goal?.status || null, archived: Boolean(row.archivedAt), createdAt: row.createdAt, updatedAt: row.updatedAt,
    ...(row.importId ? { importId: row.importId } : {}) };
};
const boundedText = (value, maximum, label) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\x00\x7f-\x9f]/u.test(value)) fail('INVALID_REQUEST', `Choose valid ${label}.`);
  return value.trim();
};
const identity = directoryIdentity;
function validateDirectory(directory, pin) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory || !matchesDirectoryIdentity(directory, pin, stat) || contains(canonicalPath(home()), directory)) fail('WORKSPACE_UNAVAILABLE', 'The agent workspace changed.', 403);
  } catch { fail('WORKSPACE_UNAVAILABLE', 'The agent workspace is unavailable.', 403); }
}

// Core-only persistent definitions. Native clients never choose filesystem paths,
// account bindings, schedules or process options through these CRUD methods.
export class CoreAgents {
  #home = home();
  #workspaces;
  constructor() { requireNode(); this.#workspaces = new CoreWorkspaces(); }
  #check() { if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'The agent host context changed.', 409); }
  status() { this.#check(); const settings = this.#workspaces.settings(); return { configured: settings.configured, workspaceRoot: settings.root, scheduling: false }; }
  providers() {
    this.#check();
    return Object.entries(providers()).filter(([id]) => /^[a-z][a-z0-9_-]{0,39}$/.test(id)).map(([id, provider]) => ({
      id, name: String(provider.name || id).slice(0, 160), backend: provider.backend, model: provider.model || null,
      supportedEfforts: (providerModelCapabilities(provider, provider.model).supportedEfforts || []).slice(0, 12),
    }));
  }
  async models(provider, { after, limit = 25 } = {}) {
    this.#check(); providerSelection({ provider });
    const root = this.#workspaces.pin();
    return providerModels(provider, { after, limit, cwd: root.path });
  }
  #row(id, { archived = false } = {}) {
    this.#check(); uuid(id); const row = getRecord('core.agent', id);
    if (!row || row.archivedAt && !archived) fail('FORBIDDEN', 'This agent is unavailable.', 403);
    validateDirectory(row.rootPath, row.rootIdentity); validateDirectory(row.parentPath, row.parentIdentity); validateDirectory(row.cwd, row.workspaceIdentity);
    const session = getRecord('session', row.sessionId);
    if (!session || session.purpose !== 'agent' || session.agentId !== row.id || session.cwd !== row.cwd) fail('FORBIDDEN', 'This agent context is unavailable.', 403);
    return row;
  }
  get(id) { const row = this.#row(id); return { ...summary(row), instructions: row.instructions }; }
  forSession(sessionId) {
    this.#check(); uuid(sessionId);
    const row = listRecords('core.agent').find(value => value.sessionId === sessionId && !value.archivedAt);
    if (!row) fail('FORBIDDEN', 'This conversation is not a registered agent.', 403);
    return this.get(row.id);
  }
  async exportArchive(sessionId, filename) {
    const agent = this.forSession(sessionId);
    return exportSharedAgentProject(getRecord('session', agent.sessionId), filename,
      { id: agent.id, name: agent.name, instructions: agent.instructions });
  }
  imported(importId) {
    this.#check(); uuid(importId);
    const row = listRecords('core.agent').find(value => value.importId === importId && !value.archivedAt);
    return row ? this.get(row.id) : null;
  }
  async importArchive(filename, input, { importId = randomUUID(), authorize = () => {}, signal } = {}) {
    this.#check(); uuid(importId); object(input, ['provider', 'model', 'effort', 'name']);
    if (!Object.hasOwn(input, 'provider') || !Object.hasOwn(input, 'model') || !Object.hasOwn(input, 'effort')) fail('INVALID_REQUEST', 'Choose the recipient provider, model and effort explicitly.');
    const selection = providerSelection({ provider: input.provider, model: input.model, effort: input.effort });
    const name = input.name === undefined ? undefined : boundedText(input.name, 120, 'agent name');
    if (name && /[\r\n\t]/.test(name)) fail('INVALID_REQUEST', 'Use a single-line agent name.');
    const previous = this.imported(importId); if (previous) return previous;
    if (listRecords('core.agent').length >= 128) fail('CAPACITY', 'The host agent limit was reached.');
    signal?.throwIfAborted(); authorize();
    const root = this.#workspaces.pin(), parent = path.join(root.path, 'Agents');
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(parent).isSymbolicLink() || fs.realpathSync(parent) !== parent) fail('FORBIDDEN', 'The agent home must be a real directory.', 403);
    this.#workspaces.assertPin(root);
    const parentPin = identity(parent), id = randomUUID(), cwd = path.join(parent, `imported-${id}`);
    fs.mkdirSync(cwd, { mode: 0o700 }); const workspacePin = identity(cwd);
    const check = () => { this.#check(); signal?.throwIfAborted(); authorize(); this.#workspaces.assertPin(root);
      validateDirectory(parent, parentPin); validateDirectory(cwd, workspacePin); };
    try {
      await importSharedAgentProject(filename, cwd, { id, selection, name, backend: providers()[selection.provider].backend, signal, authorize: check,
        commit: ({ db, primarySession, manifest, bundleId }) => {
          check();
          if (listRecords('core.agent').length >= 128 || this.imported(importId)) fail('CAPACITY', 'This agent import cannot be committed.');
          putRecord('core.agent', id, { id, name: name || manifest.agent.name, instructions: manifest.agent.instructions, ...selection,
            cwd, sessionId: primarySession.id, revision: 1, rootPath: root.path, rootIdentity: identity(root.path),
            parentPath: parent, parentIdentity: parentPin, workspaceIdentity: workspacePin, importId,
            importProvenance: { bundleId, observation: 'imported-history' }, createdAt: now(), updatedAt: now() }, db);
        } });
      return this.get(id);
    } catch (error) {
      // Only remove this exact newly-created directory, never a substituted path.
      if (!getRecord('core.agent', id)) try { validateDirectory(cwd, workspacePin); fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }
  list({ after, limit = 20 } = {}) {
    this.#check(); if (after !== undefined) uuid(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) fail('INVALID_REQUEST', 'Invalid agent page size.');
    const all = listRecords('core.agent').filter(row => !row.archivedAt).sort((a, b) => a.id.localeCompare(b.id));
    const start = after === undefined ? 0 : all.findIndex(row => row.id === after) + 1;
    if (after !== undefined && !start) fail('INVALID_CURSOR', 'Invalid agent page cursor.');
    const selected = all.slice(start, start + limit), hasMore = start + selected.length < all.length;
    return { agents: selected.map(summary), nextCursor: hasMore ? selected.at(-1).id : null, hasMore };
  }
  create(input, { requestId } = {}) {
    this.#check(); object(input, ['name', 'instructions', 'provider', 'model', 'effort']);
    const name = boundedText(input.name, 120, 'agent name'), instructions = boundedText(input.instructions, 16000, 'agent instructions');
    if (/[\r\n\t]/.test(name)) fail('INVALID_REQUEST', 'Use a single-line agent name.');
    const selection = providerSelection({ provider: input.provider, model: input.model, effort: input.effort });
    let created;
    let result;
    try {
      result = reserveRequest('core:agent:create', requestId, { name, instructions, ...selection }, db => {
        if (listRecords('core.agent').length >= 128) fail('CAPACITY', 'The host agent limit was reached.');
        const root = this.#workspaces.pin(), parent = path.join(root.path, 'Agents');
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(parent).isSymbolicLink() || fs.realpathSync(parent) !== parent) fail('FORBIDDEN', 'The agent home must be a real directory.', 403);
        this.#workspaces.assertPin(root);
        const id = randomUUID(), slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
        const cwd = path.join(parent, `${slug}-${id}`);
        fs.mkdirSync(cwd, { mode: 0o700 }); created = cwd;
        this.#workspaces.assertPin(root);
        validateDirectory(parent, identity(parent)); validateDirectory(cwd, identity(cwd));
        const session = insertConversation({ ...selection, cwd }, db, { purpose: 'agent', agentId: id });
        const row = { id, name, instructions, ...selection, cwd, sessionId: session.id, revision: 1,
          rootPath: root.path, rootIdentity: identity(root.path), parentPath: parent, parentIdentity: identity(parent),
          workspaceIdentity: identity(cwd), createdAt: now(), updatedAt: now() };
        putRecord('core.agent', id, row, db); return { agentId: id };
      });
    } catch (error) { if (created) fs.rmSync(created, { recursive: true, force: true }); throw error; }
    const row = this.#row(result.agentId); conversationExport(row.sessionId);
    writeJson(path.join(row.cwd, 'agent.json'), { version: 1, name: row.name, instructions: row.instructions, provider: row.provider, model: row.model, effort: row.effort });
    return this.get(row.id);
  }
  update(input, { requestId } = {}) {
    this.#check(); object(input, ['agentId', 'expectedRevision', 'name', 'instructions', 'provider', 'model', 'effort']);
    uuid(input.agentId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('INVALID_REQUEST', 'Use the current agent revision.');
    const receipt = reserveRequest('core:agent:update', requestId, input, db => {
      const row = this.#row(input.agentId);
      if (row.revision !== input.expectedRevision) fail('CONFLICT', 'The agent changed. Reload before editing.', 409);
      const session = getRecord('session', row.sessionId); assertSessionIdle(session);
      const name = input.name === undefined ? row.name : boundedText(input.name, 120, 'agent name');
      if (/[\r\n\t]/.test(name)) fail('INVALID_REQUEST', 'Use a single-line agent name.');
      const instructions = input.instructions === undefined ? row.instructions : boundedText(input.instructions, 16000, 'agent instructions');
      const selection = providerSelection({ provider: input.provider ?? row.provider,
        model: input.model === undefined ? input.provider && input.provider !== row.provider ? undefined : row.model : input.model, effort: input.effort ?? row.effort });
      const provider = providers()[selection.provider];
      putRecord('session', session.id, { ...session, provider: selection.provider, backend: provider.backend, model: selection.model, selectedEffort: selection.effort,
        engineThreadId: null, engineSessionId: null, engineHome: null, backendHomes: undefined,
        conversationHandoff: { pending: true, throughSeq: 0 }, updatedAt: now() }, db);
      putRecord('core.agent', row.id, { ...row, name, instructions, ...selection, revision: row.revision + 1, updatedAt: now() }, db);
      return { agentId: row.id };
    });
    const row = this.#row(receipt.agentId); conversationExport(row.sessionId);
    writeJson(path.join(row.cwd, 'agent.json'), { version: 1, name: row.name, instructions: row.instructions, provider: row.provider, model: row.model, effort: row.effort });
    return this.get(row.id);
  }
  archive(input, { requestId } = {}) {
    this.#check(); object(input, ['agentId', 'expectedRevision']); uuid(input.agentId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('INVALID_REQUEST', 'Use the current agent revision.');
    return reserveRequest('core:agent:archive', requestId, input, db => {
      const row = this.#row(input.agentId);
      if (row.revision !== input.expectedRevision) fail('CONFLICT', 'The agent changed. Reload before archiving.', 409);
      assertSessionIdle(getRecord('session', row.sessionId));
      const archived = { ...row, archivedAt: now(), revision: row.revision + 1, updatedAt: now() };
      putRecord('core.agent', row.id, archived, db); return summary(archived);
    });
  }
}
