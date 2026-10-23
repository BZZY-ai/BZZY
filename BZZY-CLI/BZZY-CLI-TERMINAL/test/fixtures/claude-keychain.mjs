#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

// Model macOS Keychain identity without accessing a real Keychain or credentials.
const args = process.argv.slice(2);
const context = { config: process.env.CLAUDE_CONFIG_DIR ?? null, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? null };
const identity = (context.secure ?? context.config ?? '').normalize('NFC');
const slot = path.join(process.env.BZZY_TEST_KEYCHAIN, createHash('sha256').update(identity).digest('hex'));
const send = value => console.log(JSON.stringify(value));
const log = value => { if (process.env.BZZY_TEST_LOG) fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify(value) + '\n'); };
if (args.includes('--version')) { console.log('2.1.304 (Claude Code fixture)'); process.exit(0); }
log({ args, ...context });
if (args[0] === 'auth') {
  if (args[1] === 'login') { fs.mkdirSync(path.dirname(slot), { recursive: true }); fs.writeFileSync(slot, 'fixture-login'); console.log('Fixture login succeeded.'); process.exit(0); }
  const loggedIn = fs.existsSync(slot);
  send({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none' }); process.exit(loggedIn ? 0 : 1);
}
if (!fs.existsSync(slot)) { console.error('Fixture selected the wrong Keychain entry.'); process.exit(1); }
for await (const line of readline.createInterface({ input: process.stdin })) {
  const event = JSON.parse(line); log({ input: event.type, ...context });
  if (event.type === 'control_request' && event.request.subtype === 'initialize') {
    send({ type: 'control_response', response: { request_id: event.request_id, subtype: 'success', response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] } } });
  } else if (event.type === 'user') {
    send({ type: 'assistant', message: { id: 'reply', usage: { input_tokens: 4, output_tokens: 3 }, content: [{ type: 'text', text: 'BZZY_OK' }] } });
    send({ type: 'result', subtype: 'success', result: 'BZZY_OK', usage: { input_tokens: 4, output_tokens: 3 } });
  }
}
