import readline from 'node:readline';
import { launch } from './process.js';
import { Rpc } from './rpc.js';
import { stopProcess } from './policy.js';
import { subscriptionEnvironment } from './auth.js';
import { apiKey, getProvider, providerModelCapabilities } from './providers.js';
import { getRecord, listRecords } from './database.js';
import { identityAlive } from './recovery.js';

const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);

// Presentation metadata only: category/order never authorizes a model or a tool.
export function sortModelCatalog(models, provider) {
  const rank = model => provider.catalogFocus === 'cyber' && model.capabilities?.category === 'cyber'
    ? model.id === provider.model ? 0 : 1 : 2;
  return [...models].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

function compatibleCatalogEntry(provider, model) {
  if (!model || typeof model !== 'object' || model.access?.available === false || model.access?.locked === true || model.locked === true || model.is_ready === false || model.is_delisted === true || model.is_upcoming === true) return false;
  if (provider.catalogFocus !== 'cyber') return true;
  const endpoints = model.supported_endpoint_types, outputs = model.architecture?.output_modalities;
  if (Array.isArray(outputs) && outputs.length && !outputs.includes('text')) return false;
  return !Array.isArray(endpoints) || !endpoints.length || endpoints.some(value => ['openai', 'openai-response', 'anthropic', 'gemini'].includes(value));
}

export function normalizeModel(provider, value) {
  if (typeof value === 'string') value = value.trim();
  if (value == null || value === 'default') return provider.model || null;
  if (typeof value !== 'string' || !validId(value.trim())) throw new Error('Enter a model ID without spaces or control characters (maximum 200 characters), or default.');
  return value.trim();
}

export function assertModelIdle(session) {
  if (session.mode === 'parallel') throw new Error('Choose an individual agent tab with /tab before changing its model.');
  assertSessionIdle(session);
}

export function assertSessionIdle(session) {
  const running = listRecords('execution', { sessionId: session.id, states: ['queued', 'launching', 'running'], limit: 1 }).length > 0;
  const run = getRecord('run', session.id);
  if (running || ['running', 'waiting_for_input', 'verifying'].includes(session.executionState) && identityAlive(run?.runner)) {
    throw new Error('The current reply is still running. Wait for it to finish or use /pause.');
  }
}

async function codexModels(session, signal) {
  const env = subscriptionEnvironment('codex');
  if (session.engineHome || session.backendHomes?.codex) env.CODEX_HOME = session.engineHome || session.backendHomes.codex;
  const rpc = new Rpc(launch('codex', ['app-server'], { cwd: session.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }), async () => { throw new Error('Model discovery does not execute tools.'); });
  const abort = () => rpc.fail(new Error('Model discovery stopped.'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.request('initialize', { clientInfo: { name: 'bzzy-models', version: '0.2.0' } }, 8000);
    rpc.notify('initialized');
    const models = []; let cursor = null;
    do {
      const page = await rpc.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) }, 8000);
      if (!Array.isArray(page.data)) throw new Error('No model catalog returned.');
      models.push(...page.data.filter(item => !item.hidden).map(item => ({ id: item.model || item.id, name: item.displayName, description: item.description,
        capabilities: { supportedEfforts: item.supportedReasoningEfforts?.map(level => level.reasoningEffort || level.effort).filter(Boolean), defaultEffort: item.defaultReasoningEffort } })));
      cursor = page.nextCursor;
    } while (cursor && models.length < 1000);
    return models;
  } finally { signal.removeEventListener('abort', abort); await rpc.close(); }
}

async function claudeModels(session, signal) {
  const env = subscriptionEnvironment('claude', { backendHomes: session.backendHomes });
  const child = launch('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
    '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence'], {
    cwd: session.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout }); child.stderr.resume();
  let abort;
  try {
    const models = await new Promise((resolve, reject) => {
      abort = () => reject(new Error('Model discovery stopped.'));
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', reject); child.stdin.on('error', reject); child.once('close', () => reject(new Error('Model catalog unavailable.')));
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'control_response' && event.response?.request_id === 'bzzy-models') {
            const models = event.response.subtype === 'success' && event.response.response?.models;
            if (Array.isArray(models)) resolve(models); else reject(new Error('No model catalog returned.'));
          }
        } catch { /* Ignore non-protocol startup output. */ }
      });
      if (signal.aborted) { abort(); return; }
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'bzzy-models', request: { subtype: 'initialize', hooks: {} } }) + '\n');
    });
    const effortMetadata = models.some(model => typeof model.supportsEffort === 'boolean');
    return models.filter(model => model.value !== 'default').map(model => ({ id: model.value, name: model.displayName, description: model.description,
      capabilities: { ...(effortMetadata ? { supportsEffort: Boolean(model.supportsEffort) } : {}), supportedEfforts: model.supportedEffortLevels } }));
  } finally {
    signal.removeEventListener('abort', abort); lines.close(); child.stdin.end();
    if (child.exitCode == null && child.signalCode == null) await new Promise(resolve => {
      const force = setTimeout(() => { stopProcess(child, 'SIGKILL'); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(force); resolve(); }); stopProcess(child);
    });
  }
}

async function apiModels(provider, signal) {
  const response = await fetch(provider.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${apiKey(provider)}` }, redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error('Model catalog unavailable.'), { code: response.status === 401 ? 'MODEL_AUTH' : response.status === 403 ? 'MODEL_ACCESS' : 'MODEL_LIST' });
  }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 1024 * 1024) throw new Error('Model catalog is too large.');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(result.data)) throw new Error('No model catalog returned.');
  return result.data.filter(model => compatibleCatalogEntry(provider, model)).map(model => {
    const context = model.context_window ?? model.context_length;
    const modalities = model.input_modalities ?? model.architecture?.input_modalities;
    const cyber = provider.catalogFocus === 'cyber' && (/^orca\/orcacyber[-/]/i.test(model.id) || model.required_tier === 'sec-uncensored' || model.category === 'cyber');
    const capabilities = providerModelCapabilities(provider, model.id, {
      supportedEfforts: Array.isArray(model.effort?.supported_levels) ? model.effort.supported_levels : undefined,
      defaultEffort: typeof model.effort?.default_level === 'string' ? model.effort.default_level : undefined,
      contextWindow: Number.isSafeInteger(context) && context > 0 ? context : undefined,
      inputModalities: Array.isArray(modalities) ? modalities.filter(value => ['text', 'image'].includes(value)) : undefined,
      ...(cyber ? { category: 'cyber' } : {}),
    });
    return { id: model.id, name: model.display_name || model.name || model.id,
      description: model.description || [cyber ? 'Cyber' : '', capabilities.contextWindow ? capabilities.contextWindow.toLocaleString() + ' context tokens' : '', capabilities.inputModalities?.join(' + ')].filter(Boolean).join(' · '), capabilities };
  });
}

export async function availableModels(session, { signal, timeoutMs = 8000 } = {}) {
  const provider = getProvider(session.provider);
  const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  try {
    bounded.throwIfAborted();
    const models = provider.auth === 'api-key' ? await apiModels(provider, bounded) : provider.backend === 'claude' ? await claudeModels(session, bounded) : await codexModels(session, bounded);
    const unique = new Map(models.filter(model => validId(model.id)).map(model => {
      const capabilities = model.capabilities || {};
      if (capabilities.supportedEfforts) capabilities.supportedEfforts = [...new Set(capabilities.supportedEfforts.filter(level => typeof level === 'string' && /^[a-z][a-z0-9_-]{0,23}$/.test(level)))];
      if (!capabilities.supportedEfforts?.includes(capabilities.defaultEffort)) delete capabilities.defaultEffort;
      return [model.id, { ...model, capabilities }];
    }));
    if (!unique.size) throw new Error('Model catalog is empty.');
    const ordered = provider.catalogFocus === 'cyber' ? sortModelCatalog([...unique.values()], provider) : [...unique.values()];
    return { models: ordered, source: provider.auth === 'api-key' ? 'provider' : 'installed backend',
      ...(provider.catalogFocus === 'cyber' ? { description: ordered.some(model => model.capabilities.category === 'cyber')
        ? 'Cyber models first. OrcaRouter checks workspace and key access on every call.'
        : 'No Cyber models were listed for this key. Check Security Research access at https://www.orcarouter.ai/research. Other available chat models are listed.' } : {}) };
  } catch (error) {
    const description = error.code === 'MODEL_AUTH' ? `The provider rejected the API key. Run bzzy auth ${provider.id} to replace it.`
      : error.code === 'MODEL_ACCESS' ? 'The configured key could not access the model list. Use a model ID permitted by your provider.'
      : 'Could not load the model list. Keep the current model, use the provider default, or enter a model ID.';
    return { models: [], source: 'manual', description };
  }
}
