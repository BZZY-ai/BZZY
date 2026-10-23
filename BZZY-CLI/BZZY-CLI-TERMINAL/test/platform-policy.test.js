import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { sandboxSupport, spawnBounded } from '../src/policy.js';
import { createSession } from '../src/store.js';
import { BUILTINS } from '../src/providers.js';
import { ToolHost, bridgeRequest } from '../src/tools.js';
import { root } from '../src/process.js';
import { retireTelegram } from '../src/migrations.js';
import { readJson, writeJson } from '../src/files.js';
import { putRecord, getRecord, appendEvent, events } from '../src/database.js';
import { transports } from '../src/notification-registry.js';
import { processIdentity, identityAlive } from '../src/process-identity.js';
import { commandSuggestions } from '../src/terminal-commands.js';

let directory, previousHome;
test.beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bz-os-'))); previousHome = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'state'); fs.mkdirSync(path.join(directory, 'work'));
});
test.afterEach(() => { if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome; fs.rmSync(directory, { recursive: true, force: true }); });
async function bounded(program, policy, args = []) {
  const child = spawnBounded(process.execPath, ['-e', program, ...args], { cwd: path.join(directory, 'work'), policy });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try { return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stderr })); }); }
  finally { clearTimeout(timer); }
}
const enforced = { skip: !sandboxSupport() ? 'OS sandbox unavailable; CI preflight requires it on supported hosts' : false };
test('OS policy enforces declared writes, read-only work, descendant confinement and symlink containment', enforced, async () => {
  const work = path.join(directory, 'work'), allowed = path.join(work, 'allowed'), blocked = path.join(work, 'blocked');
  fs.mkdirSync(allowed); fs.writeFileSync(blocked, 'unchanged'); fs.symlinkSync(blocked, path.join(allowed, 'escape'));
  const program = `const fs=require('node:fs'),cp=require('node:child_process');
    fs.writeFileSync('allowed/ok','allowed');
    for(const f of ['blocked','allowed/escape']) {try {fs.writeFileSync(f,'escaped'); process.exit(10)}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))throw e}}
    if(cp.spawnSync('/bin/sh',['-c','printf escaped > blocked'],{stdio:'ignore'}).status===0)process.exit(11);`;
  const writable = await bounded(program, { mode: 'workspace-write', writablePaths: ['allowed'], network: 'inherit' });
  assert.equal(writable.code, 0, writable.stderr); assert.equal(fs.readFileSync(blocked, 'utf8'), 'unchanged');
  assert.equal(fs.readFileSync(path.join(allowed, 'ok'), 'utf8'), 'allowed');
  const quoted = 'quoted " 🐝'; fs.mkdirSync(path.join(work, quoted));
  const escapedPath = await bounded(`const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'/ok','allowed');try{fs.writeFileSync('blocked','escaped');process.exit(10)}catch(e){process.exit(['EPERM','EACCES','EROFS'].includes(e.code)?0:11)}`, { mode: 'workspace-write', writablePaths: [quoted], network: 'inherit' }, [quoted]);
  assert.equal(escapedPath.code, 0, escapedPath.stderr); assert.equal(fs.readFileSync(blocked, 'utf8'), 'unchanged');
  const readonly = await bounded(`try{require('node:fs').writeFileSync('blocked','escaped');process.exit(10)}catch(e){process.exit(['EPERM','EACCES','EROFS'].includes(e.code)?0:11)}`, { mode: 'read-only', writablePaths: [], network: 'inherit' });
  assert.equal(readonly.code, 0, readonly.stderr); assert.equal(fs.readFileSync(blocked, 'utf8'), 'unchanged');
  const temporary = path.join(process.env.BZZY_HOME, 'runtime', 'sandbox-tmp');
  if (fs.existsSync(temporary)) assert.deepEqual(fs.readdirSync(temporary), []);
});
test('OS networking policy blocks a real loopback connection and permits it only when inherited', enforced, async () => {
  let received = 0;
  const server = http.createServer((_request, response) => { received++; response.end('ok'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const program = `const r=require('node:http').get('http://127.0.0.1:${server.address().port}',res=>{res.resume();res.on('end',()=>process.exit(process.argv[1]==='allowed'?0:10))});r.on('error',()=>process.exit(process.argv[1]==='blocked'?0:11));setTimeout(()=>process.exit(12),2000).unref();`;
  try {
    const blocked = await bounded(program, { mode: 'read-only', writablePaths: [], network: 'disabled' }, ['blocked']);
    assert.equal(blocked.code, 0, blocked.stderr); assert.equal(received, 0);
    const allowed = await bounded(program, { mode: 'read-only', writablePaths: [], network: 'inherit' }, ['allowed']);
    assert.equal(allowed.code, 0, allowed.stderr); assert.equal(received, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('macOS policy prevents signalling an unrelated host process', { skip: process.platform !== 'darwin' || !sandboxSupport() }, async () => {
  const outside = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { outside.once('spawn', resolve); outside.once('error', reject); });
  try {
    const result = await bounded(`try{process.kill(Number(process.argv[1]),'SIGCONT');process.exit(10)}catch(e){process.exit(e.code==='EPERM'?0:11)}`, { mode: 'read-only', writablePaths: [], network: 'inherit' }, [String(outside.pid)]);
    assert.equal(result.code, 0, result.stderr); assert.ok(processIdentity(outside.pid));
  } finally { outside.kill('SIGKILL'); }
});
test('long private-home paths use an authenticated private short socket and clean it up', async () => {
  process.env.BZZY_HOME = path.join(directory, 'long-'.repeat(28));
  const session = createSession(BUILTINS.codex, path.join(directory, 'work')), host = await new ToolHost(session, { event() {} }).open();
  const socketDirectory = host.socketDirectory;
  try {
    assert.ok(socketDirectory); assert.ok(Buffer.byteLength(host.socket) <= 100);
    assert.equal(fs.statSync(socketDirectory).mode & 0o777, 0o700); assert.equal(fs.statSync(host.socket).mode & 0o777, 0o600);
    assert.ok((await bridgeRequest(host.socket, host.token, { method: 'list' })).length);
    await assert.rejects(bridgeRequest(host.socket, 'wrong-token', { method: 'list' }), /Invalid tool capability/);
  } finally { await host.close(); }
  assert.equal(fs.existsSync(socketDirectory), false);
});
test('removal migration stops the verified bridge, deletes its binding and preserves providers and conversation history', async () => {
  const session = createSession(BUILTINS.codex, path.join(directory, 'work'));
  const legacy = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { legacy.once('spawn', resolve); legacy.once('error', reject); });
  const identity = processIdentity(legacy.pid);
  writeJson(path.join(process.env.BZZY_HOME, 'runtime', 'telegram.json'), { identity });
  writeJson(path.join(process.env.BZZY_HOME, 'config.json'), { providers: { example: { model: 'model' } }, notifications: { telegram: { enabled: true, chatId: 'fixture-chat' }, other: { enabled: false } } });
  writeJson(path.join(process.env.BZZY_HOME, 'credentials.json'), { example: 'fixture-provider', telegramBotToken: 'fixture-retired-token' });
  putRecord('telegram-attachment', 'current', { enabled: true }); appendEvent(session.id, 'message.user', { text: 'Preserve this conversation' });
  try { await retireTelegram(); await retireTelegram(); }
  finally { if (identityAlive(identity)) legacy.kill('SIGKILL'); }
  assert.equal(identityAlive(identity), false); assert.equal(getRecord('telegram-attachment', 'current'), null);
  assert.equal(events(session.id).some(event => event.data.text === 'Preserve this conversation'), true);
  assert.deepEqual(readJson(path.join(process.env.BZZY_HOME, 'credentials.json')), { example: 'fixture-provider' });
  assert.deepEqual(readJson(path.join(process.env.BZZY_HOME, 'config.json')), { providers: { example: { model: 'model' } }, notifications: { other: { enabled: false } } });
  assert.equal(transports.has('telegram'), false); assert.deepEqual(commandSuggestions('/telegram'), []);
});
test('retired commands fail before setup or model execution and are absent from help', () => {
  const env = { ...process.env, BZZY_CODEX_BIN: path.join(directory, 'must-not-start') };
  for (const command of ['telegram', 'internal-telegram']) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), command], { env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /integration has been removed/);
  }
  const help = spawnSync(process.execPath, [path.join(root, 'bin/bzzy.js'), '--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0); assert.doesNotMatch(help.stdout, /telegram/i);
});
