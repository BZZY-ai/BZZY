import { home, requireNode, config, defaultSelection, providers, getRecord, reserveRequest, putRecord, now } from './engine.js';
import { object, fail } from './validation.js';
import { providerSelection, workspaceDirectory, insertConversation, conversationExport } from './conversations.js';

// Trusted local setup API. Never expose this object as a model tool or infer
// administration rights from an observer/execute grant on a terminal session.
export class CoreAssistant {
  #home;
  constructor() { requireNode(); this.#home = home(); }
  #check() { if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'The assistant host context changed.', 409); }
  providers() {
    this.#check();
    return Object.entries(providers()).filter(([id]) => /^[a-z][a-z0-9_-]{0,39}$/.test(id)).map(([id, value]) => ({
      id, backend: value.backend, authentication: value.auth,
      // Do not expose endpoints, environment names, private provider settings or
      // credential availability. Authentication uses the existing host setup.
    }));
  }
  settings() {
    this.#check();
    const saved = getRecord('core.assistant', 'default') || { source: 'core', revision: 0 };
    // Older records with source:"cli" represented a live dependency on CLI
    // defaults. Require deliberate setup instead of choosing or migrating a
    // model during a read. Existing contexts already contain their own snapshot.
    const selection = saved.source === 'core' && saved.selection ? providerSelection(saved.selection) : null;
    return { source: 'core', revision: saved.revision, configured: Boolean(selection), selection };
  }
  configure(input, { requestId, expectedRevision } = {}) {
    this.#check(); object(input, ['source', 'provider', 'model', 'effort']);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_REQUEST', 'Use the settings revision shown before editing.');
    if (!['cli', 'core'].includes(input.source) || input.source === 'cli' && Object.keys(input).length !== 1) fail('INVALID_REQUEST', 'Choose an explicit Core provider or request a one-time copy of the CLI selection.');
    return reserveRequest('core:assistant:configure', requestId, { input, expectedRevision }, db => {
      const current = getRecord('core.assistant', 'default');
      if ((current?.revision || 0) !== expectedRevision) fail('CONFLICT', 'Assistant settings changed. Reload before editing.', 409);
      let selection;
      if (input.source === 'core') selection = providerSelection({ provider: input.provider, model: input.model, effort: input.effort });
      else {
        // Compatibility with source:"cli" is an explicit copy, never a live
        // binding. Resolve inside this reservation so retries retain the exact
        // original selection even if the terminal default changes afterward.
        const settings = config(), provider = settings.defaultProvider || defaultSelection()?.provider;
        if (!provider) fail('ASSISTANT_SETUP_REQUIRED', 'There is no CLI selection to copy. Choose a Core provider explicitly.');
        const selected = defaultSelection(provider);
        selection = providerSelection({ provider, model: selected?.model, effort: selected?.effort });
      }
      putRecord('core.assistant', 'default', { source: 'core', selection, revision: expectedRevision + 1, updatedAt: now() }, db);
      return this.settings();
    });
  }
  createContext(input, { requestId } = {}) {
    this.#check(); object(input, ['cwd']);
    const cwd = workspaceDirectory(input.cwd);
    const result = reserveRequest('core:assistant:context', requestId, { cwd }, db => {
      // Resolve defaults inside the creation transaction. A lost acknowledgment
      // reuses the saved context even if the user's default has since changed.
      const settings = this.settings();
      if (!settings.configured) fail('ASSISTANT_SETUP_REQUIRED', 'Choose Core\'s provider/model/effort explicitly before starting a task. Use assistant set or an explicit one-time assistant copy-cli.');
      const session = insertConversation({ ...settings.selection, cwd }, db, {
        purpose: 'core-assistant', assistantSelection: { source: settings.source, revision: settings.revision },
      });
      return { sessionId: session.id };
    });
    const session = conversationExport(result.sessionId);
    return { contextId: session.id, provider: session.provider, model: session.model, effort: session.selectedEffort,
      purpose: session.purpose, selection: session.assistantSelection };
  }
}
