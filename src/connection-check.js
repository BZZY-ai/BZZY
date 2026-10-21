import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { backendCommand, version, assertCodexVersion, launch } from './process.js';
import { codexHome, subscriptionEnvironment, subscriptionStatus } from './auth.js';
import { getProvider, defaultSelection } from './providers.js';
import { Rpc } from './rpc.js';
import { stopProcess } from './policy.js';
import { diagnosticError } from './diagnostic-error.js';

const prompt = 'Connection test. Reply with exactly BZZY_OK. Do not use any tools.';

async function codexProbe({ env, cwd, model, effort, live, signal, result }) {
  const args = ['app-server', '-c', 'model_provider="openai"', '-c', 'features.shell_tool=false',
    '-c', 'features.multi_agent=false', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"'];
  const rpc = new Rpc(launch('codex', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }), async () => { throw new Error('Connection checks cannot execute tools.'); });
  const abort = () => rpc.fail(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await rpc.request('initialize', { clientInfo: { name: 'bzzy-doctor', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    await rpc.request('model/list', { limit: 1 });
    result.connection = true;
    if (!live) return;
    const started = await rpc.request('thread/start', { cwd, ephemeral: true, model: model || undefined,
      approvalPolicy: 'never', sandbox: 'read-only', modelProvider: 'openai',
      baseInstructions: prompt, developerInstructions: prompt, config: { ...(effort && effort !== 'default' ? { model_reasoning_effort: effort } : {}) } });
    result.model = started.model || model || 'provider default';
    const threadId = started.thread.id;
    let text = '';
    const reply = new Promise((resolve, reject) => {
      rpc.once('failure', reject);
      rpc.on('notification', (method, params) => {
        if (params.threadId && params.threadId !== threadId) return;
        if (method === 'item/agentMessage/delta') text += params.delta || '';
        if (method === 'item/completed' && params.item?.type === 'agentMessage') text = params.item.text || text;
        if (method === 'thread/tokenUsage/updated') result.tokens = params.tokenUsage?.total?.totalTokens ?? null;
        if (method === 'error' && !params.willRetry) reject(new Error(params.error?.message || params.message || 'Codex request failed.'));
        if (method === 'turn/completed') {
          if (params.turn.status !== 'completed') reject(new Error(params.turn.error?.message || `Codex turn ${params.turn.status}.`));
          else if (!text.trim()) reject(new Error('Codex completed without a text reply.'));
          else resolve();
        }
      });
    });
    reply.catch(() => {});
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(effort && effort !== 'default' ? { effort } : {}) });
    await reply;
    result.response = true;
  } finally { signal.removeEventListener('abort', abort); await rpc.close(); }
}

async function claudeProbe({ env, cwd, model, effort, live, signal, result }) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--setting-sources', '', '--no-session-persistence', '--system-prompt', prompt];
  if (model) args.push('--model', model);
  if (effort && effort !== 'default') args.push('--effort', effort);
  const child = launch('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.resume(); // Never expose native credential/debug output in a diagnostic report.
  const id = randomUUID();
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  let abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      child.once('error', reject); child.stdin.on('error', reject);
      child.once('close', code => reject(new Error(`Claude exited (${code}) before the check completed.`)));
      let text = '';
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'control_response' && event.response?.request_id === id) {
            if (event.response.subtype !== 'success') { reject(new Error(event.response.error || 'Claude initialization failed.')); return; }
            result.connection = true;
            if (!live) { resolve(); return; }
            send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null });
          } else if (event.type === 'control_request') {
            send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id,
              response: { behavior: 'deny', message: 'Connection checks cannot execute tools.' } } });
          } else if (event.type === 'system' && event.subtype === 'init') result.model = event.model || model || 'provider default';
          else if (event.type === 'assistant') text += (event.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
          else if (event.type === 'result') {
            if (event.is_error || event.subtype !== 'success') reject(new Error(event.errors?.join('; ') || event.result || 'Claude request failed.'));
            else if (!(text || event.result || '').trim()) reject(new Error('Claude completed without a text reply.'));
            else {
              result.response = true;
              if (event.usage) result.tokens = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((sum, key) => sum + (event.usage[key] || 0), 0);
              resolve();
            }
          }
        } catch (error) { reject(error); }
      });
      if (signal.aborted) { abort(); return; }
      send({ type: 'control_request', request_id: id, request: { subtype: 'initialize', hooks: {} } });
    });
  } finally {
    signal.removeEventListener('abort', abort); lines.close(); child.stdin.end();
    if (child.exitCode == null && child.signalCode == null) await new Promise(resolve => {
      const timer = setTimeout(() => { stopProcess(child, 'SIGKILL'); resolve(); }, 1000);
      child.once('close', () => { clearTimeout(timer); resolve(); }); stopProcess(child);
    });
  }
}

export async function checkConnection(provider, { live = false, model, effort, session, timeoutMs = live ? 45000 : 10000 } = {}) {
  const result = { provider: provider.id, installed: false, authenticated: false, connection: false, response: null, tokens: null, live, ok: false };
  let cwd;
  try {
    if (provider.auth !== 'subscription') throw new Error('This check supports Codex and Claude subscriptions.');
    result.executable = backendCommand(provider.backend);
    result.version = version(provider.backend);
    if (provider.backend === 'codex') assertCodexVersion(result.version);
    result.installed = true;
    const authContext = provider.backend === 'codex' ? { directory: session?.engineHome || session?.backendHomes?.codex || codexHome(provider) }
      : { backendHomes: session?.backendHomes };
    const status = subscriptionStatus(provider, { ...authContext, diagnostic: true });
    result.authenticated = status.available;
    if (!result.authenticated) throw new Error(status.reason);
    const env = subscriptionEnvironment(provider.backend, authContext);
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-connection-'));
    const signal = AbortSignal.timeout(timeoutMs);
    await (provider.backend === 'codex' ? codexProbe : claudeProbe)({ env, cwd, model, effort, live, signal, result });
    result.ok = true;
  } catch (error) {
    result.error = error?.name === 'TimeoutError' ? `Timed out after ${Math.ceil(timeoutMs / 1000)}s waiting for ${result.connection ? 'a model reply' : 'backend initialization'}. Check connectivity and try bzzy doctor --live again.` : diagnosticError(error, 500);
  } finally { if (cwd) fs.rmSync(cwd, { recursive: true, force: true }); }
  return result;
}

export function connectionMessage(result) {
  const name = result.provider === 'codex' ? 'Codex / ChatGPT' : result.provider === 'claude' ? 'Claude' : result.provider;
  return `${name} · ${result.ok ? 'PASS' : 'FAIL'}\n` +
    `CLI: ${result.version || 'unavailable'}${result.executable ? ` (${result.executable})` : ''}\n` +
    `Subscription login: ${result.authenticated ? 'detected' : result.installed ? 'not verified' : 'not checked'}\n` +
    `Backend connection: ${result.connection ? 'verified' : 'not verified'}\n` +
    `Model reply: ${result.response ? `verified · ${result.model || 'provider default'} · ${result.tokens == null ? 'token usage not reported' : `${result.tokens} tokens`}` : result.live ? 'not verified' : 'not tested (run bzzy doctor --live)'}` +
    (result.error ? `\n${result.error}` : '');
}

export async function checkConnections(ui, { providerId, live = false, model, effort, session } = {}) {
  const ids = providerId ? [providerId] : ['codex', 'claude'];
  ui.event('info', { message: live ? 'Checking subscription login, backend connection and a short model reply (uses subscription tokens)…'
    : 'Checking installed CLIs, subscription logins and backend connections…' });
  const results = await Promise.all(ids.map(async id => {
    const saved = defaultSelection(id);
    const result = await checkConnection(getProvider(id), { live, model: model !== undefined ? model : saved?.model, effort: effort !== undefined ? effort : saved?.effort, session: session?.provider === id ? session : undefined });
    ui.event('info', { check: result, message: connectionMessage(result) });
    return result;
  }));
  return results;
}
