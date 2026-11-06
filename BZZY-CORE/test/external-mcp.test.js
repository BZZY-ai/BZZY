import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { externalMcpServers } from '../src/engine/engines/codex.js';

let directory, previous, file;
test.beforeEach(() => {
  previous = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-external-mcp-'));
  const home = path.join(directory, 'private');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.BZZY_HOME = home;
  file = path.join(home, 'external-mcp.json');
});
test.afterEach(() => {
  if (previous.BZZY_HOME === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous.BZZY_HOME;
  fs.rmSync(directory, { recursive: true, force: true });
});
// Default 0o600 keeps the "valid" cases deterministic regardless of the test umask.
const writeConfig = (value, mode = 0o600) => { fs.writeFileSync(file, JSON.stringify(value)); fs.chmodSync(file, mode); };

test('no external-mcp.json means no external MCP servers (default off)', () => {
  assert.deepEqual(externalMcpServers(), {});
});

test('a valid stdio server is accepted, flat or wrapped in { servers }', () => {
  writeConfig({ sentinel: { command: '/usr/bin/sentinel-mcp', args: ['--serve'], env: { SENTINEL_TOKEN: 'x' } } });
  assert.deepEqual(externalMcpServers(), { sentinel: { command: '/usr/bin/sentinel-mcp', args: ['--serve'], env: { SENTINEL_TOKEN: 'x' } } });
  writeConfig({ servers: { sentinel: { command: '/usr/bin/sentinel-mcp' } } });
  assert.deepEqual(externalMcpServers(), { sentinel: { command: '/usr/bin/sentinel-mcp' } });
});

test('a valid streamable-http server is accepted with url and optional bearer_token', () => {
  writeConfig({ sentinel: { url: 'https://127.0.0.1:9000/mcp', bearer_token: 'abc' } });
  assert.deepEqual(externalMcpServers(), { sentinel: { url: 'https://127.0.0.1:9000/mcp', bearer_token: 'abc' } });
});

test('unknown fields are dropped so a stray secret never reaches the Codex config', () => {
  writeConfig({ sentinel: { command: '/bin/s', apiKeyLeak: 'secret' } });
  assert.deepEqual(externalMcpServers(), { sentinel: { command: '/bin/s' } });
});

test('invalid entries are rejected and never partially applied', () => {
  writeConfig({ bad: { nope: true } }); assert.deepEqual(externalMcpServers(), {}, 'no command or url');
  writeConfig({ '1bad': { command: 'x' } }); assert.deepEqual(externalMcpServers(), {}, 'invalid server name');
  writeConfig({ sentinel: { command: 'x', args: ['ok', 123] } }); assert.deepEqual(externalMcpServers(), {}, 'non-string arg');
  writeConfig({ sentinel: { command: 'x', env: { 'bad key': 'v' } } }); assert.deepEqual(externalMcpServers(), {}, 'invalid env key');
  fs.writeFileSync(file, '{ not json'); fs.chmodSync(file, 0o600); assert.deepEqual(externalMcpServers(), {}, 'malformed json');
});

test('a group/world-writable config is ignored because it configures command execution', () => {
  writeConfig({ sentinel: { command: '/bin/s' } }, 0o666);
  assert.deepEqual(externalMcpServers(), {});
});
