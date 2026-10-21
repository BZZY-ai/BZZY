#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); process.exit(0); }
const args = process.argv.slice(2), codex = args[0] === 'login';
if (args[0] === 'app-server' || args.includes('--input-format')) {
  await import('./models.mjs');
  process.exit(0);
}
const directory = codex ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
if (process.env.BZZY_TEST_AUTH_CALLS) fs.appendFileSync(process.env.BZZY_TEST_AUTH_CALLS, JSON.stringify({ args, directory }) + '\n');
if (!args.includes('status')) process.exit(77); // A reused login must not open sign-in.
const file = path.join(directory, codex ? 'auth.json' : '.credentials.json');
if (!fs.existsSync(file)) process.exit(1);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
if (codex) console.error(state.auth_mode === 'chatgpt' ? 'Logged in using ChatGPT' : 'Logged in using an API key - masked-fixture');
else console.log(JSON.stringify({ loggedIn: true, authMethod: state.fixtureAuthMethod || 'claude.ai' }));
