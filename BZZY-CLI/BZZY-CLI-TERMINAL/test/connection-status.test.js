import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStatusMonitor, connectionStatusLabel } from '../src/connection-status.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Core and Relay labels require separate proofs and retain readable monochrome fallbacks', () => {
  const theme = createTerminalTheme({}, { NO_COLOR: '1' });
  assert.match(connectionStatusLabel(null, theme), /Core Offline.*Relay Offline/);
  assert.match(connectionStatusLabel({ core: true, relay: false }, theme), /Core Online.*Relay Offline/);
  assert.match(connectionStatusLabel({ core: false, relay: true }, theme), /Core Offline.*Relay Offline/);
  assert.match(connectionStatusLabel({ core: true, relay: true }, theme), /Core Online.*Relay Online/);
});
test('connection polling drops stale green proof even when the next request hangs and ignores late closed reads', async () => {
  const seen = []; let time = 0, complete, calls = 0;
  const monitor = new ConnectionStatusMonitor(value => seen.push(value), { clock: () => time, maximumAgeMs: 5, intervalMs: 5,
    load: async () => ({ read() { return ++calls === 1 ? Promise.resolve({ core: true, relay: true }) : new Promise(resolve => { complete = resolve; }); } }) }).start();
  await wait(20); assert.equal(seen[0].core, true);
  time = 10; await wait(550); assert.equal(seen.at(-1), null);
  monitor.close(); const count = seen.length; complete({ core: true, relay: true }); await wait(10); assert.equal(seen.length, count);
});
