import os from 'node:os';

const bytes = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const percent = value => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value)) * 100) / 100 : null;
const cpuTimes = cpus => {
  if (!Array.isArray(cpus) || !cpus.length) return null;
  let total = 0, idle = 0;
  for (const cpu of cpus) {
    if (!cpu?.times || !Object.values(cpu.times).every(value => Number.isFinite(value) && value >= 0)) return null;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0); idle += cpu.times.idle;
  }
  return Number.isFinite(total) && Number.isFinite(idle) ? { total, idle, count: cpus.length } : null;
};

// One instance belongs to the daemon. Reads return the frozen cached snapshot;
// authenticated polling cannot trigger OS sampling or inspect individual tasks.
export class HostMetricsSampler {
  #read; #previous; #snapshot; #timer;
  constructor({ read = () => ({ cpus: os.cpus(), totalBytes: os.totalmem(), freeBytes: os.freemem(),
    cpuUsage: process.cpuUsage(), rssBytes: process.memoryUsage.rss(), monotonic: process.hrtime.bigint(), date: new Date() }) } = {}) {
    this.#read = read;
  }
  sample() {
    const value = this.#read(), cpu = cpuTimes(value.cpus), previous = this.#previous;
    const elapsedNs = previous && typeof value.monotonic === 'bigint' && typeof previous.monotonic === 'bigint' ? value.monotonic - previous.monotonic : 0n;
    const intervalMs = elapsedNs > 0n && Number.isFinite(Number(elapsedNs)) ? Number(elapsedNs) / 1e6 : null;
    let hostCPU = null, coreCPU = null;
    if (intervalMs && cpu && previous.cpu?.count === cpu.count) {
      const total = cpu.total - previous.cpu.total, idle = cpu.idle - previous.cpu.idle;
      if (total > 0 && idle >= 0 && idle <= total) hostCPU = percent(100 * (total - idle) / total);
      const currentProcess = value.cpuUsage?.user + value.cpuUsage?.system;
      const oldProcess = previous.cpuUsage?.user + previous.cpuUsage?.system;
      if (Number.isFinite(currentProcess) && Number.isFinite(oldProcess) && currentProcess >= oldProcess) {
        coreCPU = percent(100 * (currentProcess - oldProcess) / (intervalMs * 1000 * cpu.count));
      }
    }
    const totalBytes = bytes(value.totalBytes), freeBytes = Math.min(totalBytes, bytes(value.freeBytes)), usedBytes = totalBytes - freeBytes;
    const memory = Object.freeze({ totalBytes, usedBytes, freeBytes, usedPercent: totalBytes ? percent(100 * usedBytes / totalBytes) : 0 });
    this.#snapshot = Object.freeze({ version: 1, sampledAt: value.date.toISOString(), intervalMs,
      host: Object.freeze({ cpuPercent: hostCPU, memory }), core: Object.freeze({ cpuPercent: coreCPU, rssBytes: bytes(value.rssBytes) }) });
    this.#previous = { cpu, cpuUsage: value.cpuUsage, monotonic: value.monotonic };
    return this.#snapshot;
  }
  start() {
    if (!this.#timer) {
      this.sample();
      this.#timer = setInterval(() => { try { this.sample(); } catch { /* Keep the previous bounded sample on an OS read failure. */ } }, 1000);
      this.#timer.unref();
    }
    return this;
  }
  read() { return this.#snapshot; }
  close() { clearInterval(this.#timer); this.#timer = undefined; }
}
