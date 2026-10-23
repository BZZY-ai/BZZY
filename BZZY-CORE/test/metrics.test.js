import test from 'node:test';
import assert from 'node:assert/strict';
import { HostMetricsSampler } from '../src/engine/host-metrics.js';

const cpu = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
const snapshot = (overrides = {}) => ({ cpus: [cpu(100, 100), cpu(100, 100)], totalBytes: 1000, freeBytes: 250,
  rssBytes: 100, cpuUsage: { user: 100, system: 100 }, monotonic: 1_000_000_000n, date: new Date('2026-10-22T00:00:00Z'), ...overrides });

test('host metrics warm up once, use CPU deltas and normalize Core CPU across all logical CPUs', () => {
  let value = snapshot(), reads = 0;
  const sampler = new HostMetricsSampler({ read: () => { reads++; return value; } });
  const first = sampler.sample();
  assert.equal(first.host.cpuPercent, null); assert.equal(first.core.cpuPercent, null); assert.equal(first.intervalMs, null);
  assert.deepEqual(first.host.memory, { totalBytes: 1000, usedBytes: 750, freeBytes: 250, usedPercent: 75 });
  assert.equal(sampler.read(), first); assert.equal(sampler.read(), first); assert.equal(reads, 1);
  value = snapshot({ cpus: [cpu(150, 150), cpu(150, 150)], cpuUsage: { user: 500100, system: 500100 }, monotonic: 2_000_000_000n });
  const second = sampler.sample();
  assert.equal(second.host.cpuPercent, 50); assert.equal(second.core.cpuPercent, 50); assert.equal(second.intervalMs, 1000);
  assert.equal(Object.isFrozen(second.host.memory), true);
  assert.deepEqual(Object.keys(second), ['version', 'sampledAt', 'intervalMs', 'host', 'core']);
  assert.doesNotMatch(JSON.stringify(second), /pid|hostname|path|token|processes|username/i);
});

test('CPU resets, hotplug, impossible counters and invalid memory stay bounded without NaN or Infinity', () => {
  let value = snapshot(); const sampler = new HostMetricsSampler({ read: () => value }); sampler.sample();
  value = snapshot({ cpus: [cpu(0, 0)], totalBytes: Infinity, freeBytes: -1, rssBytes: NaN, monotonic: 0n });
  const reset = sampler.sample();
  assert.equal(reset.host.cpuPercent, null); assert.equal(reset.core.cpuPercent, null); assert.equal(reset.intervalMs, null);
  assert.deepEqual(reset.host.memory, { totalBytes: 0, usedBytes: 0, freeBytes: 0, usedPercent: 0 }); assert.equal(reset.core.rssBytes, 0);
  value = snapshot({ cpus: [cpu(10, 10)], totalBytes: 100, freeBytes: 200, cpuUsage: { user: 1e12, system: 1e12 }, monotonic: 1_000_000_000n });
  const clamped = sampler.sample();
  assert.equal(clamped.host.cpuPercent, 50); assert.equal(clamped.core.cpuPercent, 100);
  assert.deepEqual(clamped.host.memory, { totalBytes: 100, usedBytes: 0, freeBytes: 100, usedPercent: 0 });
  assert.doesNotMatch(JSON.stringify(clamped), /NaN|Infinity/);
});

test('starting twice shares one unreferenced sampler and closing stops future OS reads', async () => {
  let reads = 0; const sampler = new HostMetricsSampler({ read: () => { reads++; return snapshot(); } });
  sampler.start(); sampler.start(); assert.equal(reads, 1); sampler.close();
  await new Promise(resolve => setTimeout(resolve, 1050)); assert.equal(reads, 1);
});
