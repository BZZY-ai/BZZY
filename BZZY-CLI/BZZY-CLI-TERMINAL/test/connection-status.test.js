import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionStatusMonitor, connectionStatusLabel } from '../src/connection-status.js';
import { palette, createTerminalTheme } from '../src/terminal-theme.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('Core and Relay labels require separate proofs and retain readable monochrome fallbacks', () => {
  const theme = createTerminalTheme({}, { NO_COLOR: '1' });
  for (const sample of [null, { core: true, relay: false }, { core: false, relay: true }, { core: true, relay: true }]) {
    assert.equal(connectionStatusLabel(sample, theme), '● BZZY Core  ● Relay');
    const rgb = createTerminalTheme({}, { FORCE_COLOR: '3' });
    const text = connectionStatusLabel(sample, rgb);
    const core = rgb.color('●', sample?.core === true ? palette.goalSuccess : palette.danger, true);
    const relay = rgb.color('●', sample?.core === true && sample?.relay === true ? palette.goalSuccess : palette.danger, true);
    assert.equal(text, core + rgb.color(' BZZY Core', palette.muted) + '  ' + relay + rgb.color(' Relay', palette.muted));
    assert.doesNotMatch(text, /Online|Offline| ON| OFF/);
  }
});
test('connection polling drops stale green proof even when the next request hangs and ignores late closed reads', async () => {
  const seen = []; let time = 0, complete, calls = 0;
  const monitor = new ConnectionStatusMonitor(value => seen.push(value), { clock: () => time, maximumAgeMs: 5, intervalMs: 5,
    load: async () => ({ read() { return ++calls === 1 ? Promise.resolve({ core: true, relay: true }) : new Promise(resolve => { complete = resolve; }); } }) }).start();
  await wait(20); assert.equal(seen[0].core, true);
  time = 10; await wait(550); assert.equal(seen.at(-1), null);
  monitor.close(); const count = seen.length; complete({ core: true, relay: true }); await wait(10); assert.equal(seen.length, count);
});
