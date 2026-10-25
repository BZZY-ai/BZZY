import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { HostMetricsMonitor, hostMetricsLabel } from '../src/host-metrics.js';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';

const sample = cpuPercent => ({ version: 1, sampledAt: new Date().toISOString(), intervalMs: 1000,
  host: { cpuPercent, memory: { totalBytes: 32 * 1024 ** 3, usedBytes: 12.5 * 1024 ** 3, freeBytes: 19.5 * 1024 ** 3, usedPercent: 39.0625 } },
  core: { cpuPercent: 0.1, rssBytes: 144 * 1024 ** 2 } });

test('Core telemetry is rendered as host CPU/RAM and never confused with a goal or phone measurement', async () => {
  const input = new PassThrough(); Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) { this.isRaw = value; } });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 26, columns: 100 }); output.resume();
  let reads = 0;
  const ui = new UI({ input, output, error: output, pet: false, hostMetrics: true,
    metricsLoader: async () => ({ async read() { reads++; return sample(18.75); } }) });
  try {
    ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    await new Promise(resolve => setTimeout(resolve, 10)); ui.tui.render();
    assert.equal(reads, 1);
    assert.match(ui.tui.lastFrame[0], /CPU\s*19%.*12\.5\/32(?: GB|G)/);
    assert.equal(ui.tui.entries.length, 0, 'telemetry does not become transcript/history');
    for (const columns of [48, 22]) {
      output.columns = columns; ui.tui.render();
      assert.ok(ui.tui.lastFrame.every(line => cellWidth(line) <= columns));
      if (columns >= 60) assert.match(ui.tui.lastFrame.map(clean).join('\n'), /CPU 19%/);
      else assert.doesNotMatch(ui.tui.lastFrame.map(clean).join('\n'), /RAM/);
    }
  } finally { ui.close(); }
});

test('warming and unavailable measurements are explicit; late asynchronous reads cannot update a closed UI', async () => {
  assert.match(hostMetricsLabel(sample(null)), /warming up/);
  assert.match(hostMetricsLabel({ host: { cpuPercent: NaN } }), /unavailable/);
  let finish, received = 0;
  const waiting = new Promise(resolve => { finish = resolve; });
  const monitor = new HostMetricsMonitor(() => { received++; }, { load: async () => ({ read: () => waiting }), intervalMs: 5 }).start();
  await Promise.resolve(); monitor.close(); finish(sample(12));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(received, 0);
});
