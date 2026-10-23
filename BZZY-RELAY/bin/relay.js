#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createIdentity, loadIdentity, saveIdentity } from '../src/identity.js';
import { RelayStore } from '../src/store.js';
import { startRelay } from '../src/server.js';
import { RelayError, fail, integer } from '../src/protocol.js';

process.umask(0o077);
const [command, ...args] = process.argv.slice(2);
const usage = `BZZY Relay (Node >=24)
  identity-create --file PRIVATE_FILE            Run on an endpoint, never the VPS
  identity-public --file PRIVATE_FILE            Print only its public certificate
  host-add --state DIRECTORY --certificate PUBLIC_FILE
  device-revoke --state DIRECTORY --id DEVICE_ID
  serve --state DIRECTORY --audience wss://HOST/v1/socket [--port 8787]
  help

No invitation redemption URLs, remote admin endpoint, model runtime or owner token.
Use the RelayClient API for pairing, import codes and encrypted messages.
`;
function options(allowed, required = allowed) {
  const value = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !allowed.includes(key) || !args[i + 1] || Object.hasOwn(value, key)) fail('INVALID_ARGUMENTS');
    value[key] = args[i + 1];
  }
  if (required.some(key => !value[key])) fail('MISSING_ARGUMENT');
  return value;
}
try {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('NODE_24_REQUIRED');
  switch (command) {
    case 'identity-create': {
      const opt = options(['file']); const identity = createIdentity();
      saveIdentity(path.resolve(opt.file), identity);
      process.stdout.write(JSON.stringify(identity.certificate) + '\n'); break;
    }
    case 'identity-public': {
      const opt = options(['file']);
      process.stdout.write(JSON.stringify(loadIdentity(opt.file).certificate) + '\n'); break;
    }
    case 'host-add': {
      const opt = options(['state', 'certificate']); const store = new RelayStore({ directory: path.resolve(opt.state) });
      try { process.stdout.write(JSON.stringify(store.provisionHost(JSON.parse(fs.readFileSync(opt.certificate, 'utf8')))) + '\n'); } finally { store.close(); }
      break;
    }
    case 'device-revoke': {
      const opt = options(['state', 'id']); const store = new RelayStore({ directory: path.resolve(opt.state) });
      try { process.stdout.write(JSON.stringify(store.revokeDevice(opt.id)) + '\n'); } finally { store.close(); }
      break;
    }
    case 'serve': {
      const opt = options(['state', 'audience', 'port'], ['state', 'audience']);
      if (process.getuid?.() === 0) fail('NON_ROOT_REQUIRED');
      const port = opt.port ? integer(Number(opt.port), 1024, 65535) : 8787;
      const store = new RelayStore({ directory: path.resolve(opt.state) });
      const relay = await startRelay({ store, port, audience: opt.audience,
        audit: entry => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n') });
      process.stdout.write(JSON.stringify({ event: 'relay', decision: 'ready', port }) + '\n');
      let stopping = false;
      const stop = async () => { if (stopping) return; stopping = true; await relay.close(); store.close(); };
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
      break;
    }
    case 'help': case '--help': case undefined: process.stdout.write(usage); break;
    default: fail('UNKNOWN_COMMAND');
  }
} catch (error) {
  // Never print exception messages/stacks: filesystem paths or input may contain secrets.
  process.stderr.write(JSON.stringify({ error: error instanceof RelayError ? error.code : 'OPERATION_FAILED' }) + '\n');
  process.exitCode = 1;
}
