import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { root, backendCommand, runtimeEnv } from '../src/process.js';
import { backendIsolation, sandboxCommand, sandboxSupport } from '../src/policy.js';

// All inference goes to a loopback mock with a dummy key. No paid model request.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-real-smoke-'));
let requests = 0;
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (!request.url.endsWith('/responses')) { response.writeHead(404).end(); return; }
  const input = JSON.parse(body);
  assert.equal(input.model, 'smoke-model');
  assert.equal(input.reasoning.effort, 'high');
  const id = `smoke-${++requests}`;
  const item = requests === 2
    ? { type: 'function_call', call_id: 'complete-goal', name: 'update_goal', arguments: '{"status":"complete"}' }
    : { type: 'message', role: 'assistant', id: `message-${requests}`, content: [{ type: 'output_text', text: requests === 1 ? 'First pass; verification remains.' : 'Verified completion from the local smoke fixture.' }] };
  const events = [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

function childResult(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Smoke timed out: ${stdout}\n${stderr}`)); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

try {
  const bzzyHome = path.join(dir, 'bzzy');
  fs.mkdirSync(bzzyHome, { mode: 0o700 });
  fs.writeFileSync(path.join(bzzyHome, 'config.json'), JSON.stringify({ version: 1, defaultProvider: 'smoke', providers: {
    smoke: { id: 'smoke', name: 'Local smoke', backend: 'codex', auth: 'api-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, envKey: 'BZZY_SMOKE_KEY', model: 'smoke-model', contextWindow: 128000 },
  } }));
  const codex = spawn(process.execPath, [path.join(root, 'bin', 'bzzy.js'), 'goal', 'Exercise real native goal continuation against the loopback fixture.', '--effort', 'high', '--json'], {
    cwd: dir, env: runtimeEnv({ BZZY_DIRECT: '1', BZZY_HOME: bzzyHome, BZZY_CODEX_HOME: path.join(dir, 'codex'), BZZY_SMOKE_KEY: 'not-a-real-key',
      BZZY_CODEX_BIN: backendCommand('codex'), CODEX_APP_SERVER_DISABLE_MANAGED_CONFIG: '1', RUST_LOG: 'warn' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await childResult(codex);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"status":"complete"/);
  assert.equal(requests, 3);
  console.log('PASS: real Codex app-server, custom Responses provider, high reasoning effort, two goal turns, update_goal completion.');

  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir, { mode: 0o700 });
  const claudeEnv = runtimeEnv({ CLAUDE_CONFIG_DIR: claudeDir, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined, ANTHROPIC_BASE_URL: undefined, CLAUDECODE: undefined,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const policy = { mode: 'read-only', writablePaths: [], network: 'inherit' };
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--setting-sources', ''];
  const prepared = sandboxSupport() ? sandboxCommand(backendCommand('claude'), args, backendIsolation('claude', claudeEnv, dir, policy)) : { command: backendCommand('claude'), args };
  const claude = spawn(prepared.command, prepared.args, {
    cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnv,
  });
  let initialized = false;
  const lines = readline.createInterface({ input: claude.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.type === 'control_response' && message.response?.request_id === 'smoke') {
      initialized = message.response.subtype === 'success';
      claude.stdin.end();
    }
  });
  claude.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'smoke', request: { subtype: 'initialize', hooks: {} } }) + '\n');
  const claudeResult = await childResult(claude);
  lines.close();
  assert.ok(initialized, `${claudeResult.stdout}\n${claudeResult.stderr}`);
  console.log(`PASS: real unmodified Claude Code streaming/control initialization${sandboxSupport() ? ' inside read-only bubblewrap' : ''}; no user prompt or inference.`);
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
