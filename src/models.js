import readline from 'node:readline';
import { launch } from './process.js';
import { Rpc } from './rpc.js';
import { stopProcess } from './policy.js';
import { subscriptionEnvironment } from './auth.js';
import { apiKey, getProvider, ensureApiKey } from './providers.js';
import { getRecord, listRecords } from './database.js';
import { identityAlive } from './recovery.js';

const DEFAULT = '@bzzy-default', CUSTOM = '@bzzy-custom';
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);

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
  const running = listRecords('execution').some(job => job.sessionId === session.id && ['queued', 'launching', 'running'].includes(job.state));
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
  return result.data.map(model => ({ id: model.id, name: model.name || model.id, description: model.description || [model.context_window ? model.context_window.toLocaleString() + ' context tokens' : '', model.input_modalities?.join(' + ')].filter(Boolean).join(' · '),
      capabilities: { supportedEfforts: model.effort?.supported_levels, defaultEffort: model.effort?.default_level, contextWindow: model.context_window, inputModalities: model.input_modalities } }));
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
    return { models: [...unique.values()], source: provider.auth === 'api-key' ? 'provider' : 'installed backend' };
  } catch (error) {
    const description = error.code === 'MODEL_AUTH' ? `The provider rejected the API key. Run bzzy auth ${provider.id} to replace it.`
      : error.code === 'MODEL_ACCESS' ? 'The configured key could not access the model list. Use a model ID permitted by your provider.'
      : 'Could not load the model list. Keep the current model, use the provider default, or enter a model ID.';
    return { models: [], source: 'manual', description };
  }
}

export async function chooseModel(session, argument, ui, { title, description } = {}) {
  const provider = getProvider(session.provider);
  if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
  if (argument) return { model: normalizeModel(provider, argument), capabilities: null, effort: null };
  const abort = new AbortController(); let catalog;
  try {
    const choices = availableModels(session, { signal: abort.signal }).then(result => {
      catalog = result;
      const selected = session.model || null, current = selected || session.resolvedModel;
      const models = [...result.models];
      if (current && !models.some(model => model.id === current)) models.unshift({ id: current, name: current, description: 'Current model · availability not verified by the catalog.' });
      return { selectEffort: true, warning: result.source === 'manual' ? result.description : current && !result.models.some(model => model.id === current)
        ? 'The current model is not listed by this CLI. Choose a listed model or the provider default, or retain the custom ID if your provider supports it.' : null,
        description: description || 'Selection applies to the next message in this conversation.', choices: [
        { value: DEFAULT, label: 'Provider default' + (provider.model ? ' · ' + provider.model : ''), description: 'Use the provider’s configured default model.', selected: !selected },
        ...models.map(model => ({ value: model.id, label: model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id, description: model.description, selected: selected === model.id,
          efforts: model.capabilities?.supportsEffort === false ? [] : [...new Set(model.capabilities?.supportedEfforts || [])], supportsEffort: model.capabilities?.supportsEffort,
          defaultEffort: model.capabilities?.defaultEffort, effort: selected === model.id && model.capabilities?.supportedEfforts?.includes(session.selectedEffort) ? session.selectedEffort : 'default' })),
        { value: CUSTOM, label: 'Enter a model ID…', description: result.description || 'Enter any model ID supported by this provider.' },
      ] };
    });
    const choice = await ui.chooseOne(title || 'Choose model · ' + provider.id, choices);
    if (choice == null) return null;
    const selected = typeof choice === 'object' ? choice.value : choice;
    const effort = typeof choice === 'object' ? choice.effort || 'default' : null;
    if (selected === CUSTOM) {
      const input = (await ui.ask('Model ID (or default): '))?.trim();
      return input ? { model: normalizeModel(provider, input), capabilities: null, effort: null } : null;
    }
    if (selected === DEFAULT) return { model: normalizeModel(provider, null), capabilities: null, effort };
    const capabilities = catalog.models.find(model => model.id === selected)?.capabilities || null;
    if (effort && effort !== 'default' && (capabilities?.supportsEffort === false || !capabilities?.supportedEfforts?.includes(effort))) throw new Error('Choose a reasoning effort supported by this model.');
    return { model: normalizeModel(provider, selected), capabilities, effort };
  } finally { abort.abort(); }
}
