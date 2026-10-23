import { randomUUID } from 'node:crypto';
import { home, getRecord, putRecord, listRecords, transaction, appendEvent, now, digest, loadSession, schemaErrors, validateSchema, generationSecurityPolicy, requireNode } from './engine.js';
import { fail, object, opaque, uuid, identity, sameIdentity, future, strings } from './validation.js';
import { filesystemIntegration, filesystemRoots } from './filesystem.js';

const active = record => record && !record.revokedAt && record.expiresAt > Date.now();
const copy = value => structuredClone(value);
const publicBinding = value => ({ id: value.id, integrationId: value.integrationId, capabilities: value.capabilities, expiresAt: value.expiresAt, revokedAt: value.revokedAt || null });

function ownSchemaProperties(value, schema) {
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    for (const key of Object.keys(value)) {
      // The legacy schema evaluator accepts inherited property names. The broker
      // must require explicit own properties for its security allowlists.
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        if (!ownSchemaProperties(value[key], schema.properties[key])) return false;
      } else if (schema.additionalProperties === false) return false;
    }
  }
  if (Array.isArray(value) && schema.items) return value.every(item => ownSchemaProperties(item, schema.items));
  return true;
}

const matchesSchema = (value, schema) => ownSchemaProperties(value, schema) && schemaErrors(value, schema).length === 0;

async function callAdapter(adapter, name, args, context) {
  const deadline = AbortSignal.timeout(30000);
  const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
  signal.throwIfAborted();
  let aborted;
  const cancellation = new Promise((_, reject) => {
    aborted = () => reject(Object.assign(new Error('Tool operation interrupted.'), { code: deadline.aborted ? 'TOOL_TIMEOUT' : 'CANCELLED' }));
    if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => adapter(name, args, { ...context, signal })), cancellation]);
  } finally { signal.removeEventListener('abort', aborted); }
}

// Construct on the trusted host. Supply only admin.scope(...), never admin,
// to a tool transport. Integration adapters are trusted host code, not imports.
export function createToolBroker({ integrations = [filesystemIntegration] } = {}) {
  requireNode();
  const hostHome = home(), registry = new Map(), adapters = new Map();
  const checkHost = () => { if (hostHome !== home()) fail('HOST_CONTEXT_CHANGED', 'The broker host context changed.', 409); };
  for (const source of integrations) {
    object(source, ['id', 'description', 'capabilities', 'authentication', 'rateLimit', 'errors', 'tools', 'execute'], 'Integration');
    const definition = copy(Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'execute')));
    opaque(definition.id, 'Integration ID');
    if (registry.has(definition.id) || !definition.description || !Array.isArray(definition.tools) || !definition.tools.length) fail('INVALID_INTEGRATION', 'Integrations need unique IDs, descriptions and tools.');
    definition.capabilities = strings(definition.capabilities, 'Integration capabilities');
    object(definition.authentication, ['required', 'scopes'], 'Authentication declaration');
    if (typeof definition.authentication.required !== 'boolean' || !Array.isArray(definition.authentication.scopes) || definition.authentication.scopes.some(value => typeof value !== 'string')) fail('INVALID_INTEGRATION', 'Declare authentication and permission scopes.');
    if (!Number.isSafeInteger(definition.rateLimit?.calls) || definition.rateLimit.calls < 1 || definition.rateLimit.calls > 10000 || !Number.isSafeInteger(definition.rateLimit.intervalSeconds) || definition.rateLimit.intervalSeconds < 1 || definition.rateLimit.intervalSeconds > 86400 || !Array.isArray(definition.errors)) fail('INVALID_INTEGRATION', 'Declare bounded rate limits and errors.');
    if (!definition.authentication.required && typeof source.execute !== 'function') fail('INVALID_INTEGRATION', 'Unauthenticated integrations need a host adapter.');
    const names = new Set();
    for (const tool of definition.tools) {
      object(tool, ['name', 'description', 'capability', 'effect', 'inputSchema', 'outputSchema'], 'Tool');
      opaque(tool.name, 'Tool name');
      if (names.has(tool.name) || !tool.description || !definition.capabilities.includes(tool.capability) || tool.effect !== 'read') fail('INVALID_INTEGRATION', 'This broker supports distinct read-only tools with declared capabilities.');
      names.add(tool.name);
      for (const schema of [tool.inputSchema, tool.outputSchema]) {
        validateSchema(schema);
        if (schema.type !== 'object' || schema.additionalProperties !== false) fail('INVALID_INTEGRATION', 'Tools need allowlisted object schemas for input and output.');
      }
    }
    registry.set(definition.id, { definition, execute: source.execute });
  }
  const integration = id => { const value = registry.get(id); if (!value) fail('NOT_FOUND', 'Unknown integration.', 404); return value; };
  const validateCapabilities = (id, requested) => {
    const selected = strings(requested, 'Capabilities');
    if (selected.some(capability => !integration(id).definition.capabilities.includes(capability))) fail('FORBIDDEN', 'Capabilities exceed this integration.', 403);
    return selected;
  };
  const admin = Object.freeze({
    integrations() { checkHost(); return [...registry.values()].map(item => copy(item.definition)); },
    bind(input, execute) {
      checkHost(); object(input, ['principal', 'integrationId', 'capabilities', 'expiresAt'], 'Binding');
      const principal = identity(input.principal), capabilities = validateCapabilities(input.integrationId, input.capabilities);
      if (!integration(input.integrationId).definition.authentication.required || typeof execute !== 'function') fail('INVALID_REQUEST', 'A private binding requires an authenticated integration and a trusted host adapter.');
      const binding = { id: randomUUID(), principal, integrationId: input.integrationId, capabilities, expiresAt: future(input.expiresAt), createdAt: now() };
      putRecord('core.binding', binding.id, binding); adapters.set(binding.id, execute);
      return publicBinding(binding);
    },
    attachBinding(id, execute) {
      checkHost(); const binding = getRecord('core.binding', uuid(id));
      if (!active(binding) || typeof execute !== 'function') fail('FORBIDDEN', 'Only active bindings can attach to a trusted host adapter.', 403);
      adapters.set(id, execute); return publicBinding(binding);
    },
    grant(input) {
      checkHost(); object(input, ['principal', 'integrationId', 'capabilities', 'bindingId', 'roots', 'expiresAt'], 'Grant');
      const principal = identity(input.principal), capabilities = validateCapabilities(input.integrationId, input.capabilities);
      const { definition } = integration(input.integrationId), expiresAt = future(input.expiresAt);
      let binding;
      if (definition.authentication.required) {
        binding = getRecord('core.binding', uuid(input.bindingId));
        if (!active(binding) || !sameIdentity(binding.principal, principal) || binding.integrationId !== input.integrationId || capabilities.some(capability => !binding.capabilities.includes(capability)) || expiresAt > binding.expiresAt) fail('FORBIDDEN', 'This binding does not authorize the requested principal, scope or expiry.', 403);
      } else if (input.bindingId !== undefined) fail('INVALID_REQUEST', 'This integration does not use an account binding.');
      if (input.integrationId !== 'filesystem' && input.roots !== undefined) fail('INVALID_REQUEST', 'Filesystem roots belong only to the filesystem integration.');
      const resources = input.integrationId === 'filesystem' ? { roots: filesystemRoots(input.roots) } : {};
      const grant = { id: randomUUID(), principal, integrationId: input.integrationId, capabilities, resources, bindingId: binding?.id || null, expiresAt, createdAt: now() };
      putRecord('core.permission', grant.id, grant);
      return { id: grant.id, integrationId: grant.integrationId, capabilities, bindingId: grant.bindingId, expiresAt };
    },
    revokeGrant(id) {
      checkHost(); uuid(id);
      return transaction(db => {
        const grant = getRecord('core.permission', id);
        if (!grant) fail('NOT_FOUND', 'Unknown permission grant.', 404);
        grant.revokedAt ||= now(); putRecord('core.permission', id, grant, db);
        return { id, revokedAt: grant.revokedAt };
      });
    },
    revokeBinding(id) {
      checkHost(); uuid(id);
      const result = transaction(db => {
        const binding = getRecord('core.binding', id);
        if (!binding) fail('NOT_FOUND', 'Unknown binding.', 404);
        binding.revokedAt ||= now(); putRecord('core.binding', id, binding, db);
        return { id, revokedAt: binding.revokedAt };
      });
      adapters.delete(id); return result;
    },
    scope(input) {
      checkHost(); object(input, ['principal', 'sessionId'], 'Tool scope');
      const principal = identity(input.principal), sessionId = uuid(input.sessionId);
      if (!loadSession(sessionId)) fail('NOT_FOUND', 'Unknown conversation.', 404);
      transaction(db => {
        const previous = getRecord('core.session-principal', sessionId);
        if (previous && !sameIdentity(previous.principal, principal)) fail('FORBIDDEN', 'A conversation cannot inherit another principal’s bindings.', 403);
        putRecord('core.session-principal', sessionId, { sessionId, principal }, db);
      });
      const permits = (integrationId, capability, grantId, rootId) => {
        checkHost();
        const member = getRecord('core.session-principal', sessionId);
        if (!sameIdentity(member?.principal, principal)) fail('FORBIDDEN', 'The conversation identity changed.', 403);
        const grants = grantId ? [getRecord('core.permission', grantId)] : listRecords('core.permission');
        for (const grant of grants) {
          if (!active(grant) || !sameIdentity(grant.principal, principal) || grant.integrationId !== integrationId || !grant.capabilities.includes(capability)) continue;
          if (rootId !== undefined && !grant.resources?.roots?.some(root => root.id === rootId)) continue;
          if (grant.bindingId) {
            const binding = getRecord('core.binding', grant.bindingId);
            if (!active(binding) || !sameIdentity(binding.principal, principal) || binding.integrationId !== integrationId || !binding.capabilities.includes(capability)) continue;
            if (!adapters.has(binding.id)) fail('AUTHORIZATION_REQUIRED', 'Reconnect this account through secure host authorization.', 403);
          }
          return grant;
        }
        fail('FORBIDDEN', 'This tool capability is not authorized for this principal.', 403);
      };
      const audit = (tool, decision, code) => { checkHost(); appendEvent(sessionId, 'tool.decision', { tool, decision, ...(code ? { code } : {}), provenance: 'host-policy' }); };
      return Object.freeze({
        instructions: generationSecurityPolicy,
        catalog() {
          checkHost(); const items = [];
          for (const { definition } of registry.values()) for (const tool of definition.tools) {
            try { permits(definition.id, tool.capability); items.push({ ...copy(tool), name: `${definition.id}.${tool.name}` }); }
            catch (error) { if (!['FORBIDDEN', 'AUTHORIZATION_REQUIRED'].includes(error.code)) throw error; }
          }
          return items;
        },
        async invoke(toolId, args, { signal } = {}) {
          checkHost();
          if (typeof toolId !== 'string' || !/^[A-Za-z0-9_-]{1,80}\.[A-Za-z0-9_-]{1,80}$/.test(toolId)) fail('INVALID_REQUEST', 'Use a declared tool ID.');
          const [integrationId, name] = toolId.split('.');
          try {
            const { definition, execute } = integration(integrationId), tool = definition.tools.find(item => item.name === name);
            if (!tool) fail('NOT_FOUND', 'Unknown integration tool.', 404);
            permits(integrationId, tool.capability);
            if (Buffer.byteLength(JSON.stringify(args) ?? '') > 32768 || !matchesSchema(args, tool.inputSchema)) fail('INVALID_REQUEST', 'Tool input does not match its declared schema.');
            const grant = permits(integrationId, tool.capability, undefined, integrationId === 'filesystem' ? args.root : undefined);
            const safeArgs = copy(args), assertAuthorized = () => { signal?.throwIfAborted(); return permits(integrationId, tool.capability, grant.id); };
            assertAuthorized();
            transaction(db => {
              const key = digest({ principal, integrationId }), current = getRecord('core.rate', key), timestamp = Date.now();
              const bucket = current && current.startedAt + definition.rateLimit.intervalSeconds * 1000 > timestamp ? current : { startedAt: timestamp, calls: 0 };
              if (bucket.calls >= definition.rateLimit.calls) fail('RATE_LIMITED', 'This principal reached the integration call limit.', 429);
              putRecord('core.rate', key, { ...bucket, calls: bucket.calls + 1 }, db);
            });
            const adapter = grant.bindingId ? adapters.get(grant.bindingId) : execute;
            const result = await callAdapter(adapter, name, safeArgs, { resources: copy(grant.resources), signal, assertAuthorized });
            assertAuthorized();
            if (Buffer.byteLength(JSON.stringify(result) ?? '') > 65536 || !matchesSchema(result, tool.outputSchema)) fail('INVALID_TOOL_RESULT', 'The host adapter returned an invalid result.');
            const data = copy(result); audit(toolId, 'allowed');
            return { data, provenance: { type: 'host-tool-observation', tool: toolId, observedAt: now() } };
          } catch (error) {
            const safeCodes = ['FORBIDDEN', 'AUTHORIZATION_REQUIRED', 'INVALID_REQUEST', 'NOT_FOUND', 'RATE_LIMITED', 'FILE_UNAVAILABLE', 'FILE_TOO_LARGE', 'INVALID_TOOL_RESULT', 'HOST_CONTEXT_CHANGED', 'CANCELLED', 'TOOL_TIMEOUT'];
            const code = safeCodes.includes(error.code) ? error.code : signal?.aborted ? 'CANCELLED' : 'TOOL_FAILED';
            const known = registry.get(integrationId)?.definition.tools.some(tool => tool.name === name);
            audit(known ? toolId : 'unknown', 'denied', code);
            // Adapter messages can contain authorization headers or provider errors.
            const status = ['FORBIDDEN', 'AUTHORIZATION_REQUIRED'].includes(code) ? 403 : code === 'RATE_LIMITED' ? 429 : code === 'NOT_FOUND' ? 404 : 400;
            fail(code, code === 'AUTHORIZATION_REQUIRED' ? 'Connect the account through secure host authorization.' : `Tool operation failed (${code}).`, status);
          }
        },
      });
    },
  });
  return Object.freeze({ admin });
}
