// Presentation/polling only. Core samples the host; the TUI never reads local
// OS counters, credentials, processes, or model execution state for telemetry.
export class HostMetricsMonitor {
  #timer; #closed = false; #client;
  constructor(onChange, { load = async () => new (await import('@bzzy/core/metrics')).CoreMetricsClient(), intervalMs = 1000 } = {}) {
    this.onChange = onChange; this.load = load; this.intervalMs = intervalMs;
  }
  start() { if (!this.started) { this.started = true; void this.#poll(); } return this; }
  async #poll() {
    try {
      this.#client ||= await this.load();
      if (this.#closed) return;
      const sample = await this.#client.read();
      if (!this.#closed) this.onChange(sample);
    } catch { if (!this.#closed) this.onChange(null); }
    finally {
      if (!this.#closed) { this.#timer = setTimeout(() => { void this.#poll(); }, this.intervalMs); this.#timer.unref(); }
    }
  }
  close() { this.#closed = true; clearTimeout(this.#timer); }
}

export function hostMetricsLabel(sample, width = 80) {
  const cpu = sample?.host?.cpuPercent, memory = sample?.host?.memory, rss = sample?.core?.rssBytes;
  if (!memory || !Number.isFinite(memory.totalBytes) || memory.totalBytes <= 0 ||
    !Number.isFinite(memory.usedBytes) || memory.usedBytes < 0 || memory.usedBytes > memory.totalBytes ||
    cpu !== null && (!Number.isFinite(cpu) || cpu < 0 || cpu > 100)) return 'Host CPU / RAM unavailable';
  const percent = cpu === null ? 'warming up' : `${cpu.toFixed(1)}%`;
  const used = (memory.usedBytes / 1024 ** 3).toFixed(1), total = (memory.totalBytes / 1024 ** 3).toFixed(0);
  const core = Number.isFinite(rss) && rss >= 0 ? ` · Core ${Math.round(rss / 1024 ** 2)} MB` : '';
  return width >= 65 ? `Host CPU ${percent} · RAM ${used}/${total} GB${core}`
    : `CPU ${cpu === null ? '—' : `${cpu.toFixed(0)}%`} · RAM ${used}/${total} GB`;
}

export function hostMetricsCompact(sample) {
  const cpu = sample?.host?.cpuPercent, memory = sample?.host?.memory;
  if (!memory || !Number.isFinite(memory.totalBytes) || memory.totalBytes <= 0 ||
    !Number.isFinite(memory.usedBytes) || memory.usedBytes < 0 || memory.usedBytes > memory.totalBytes ||
    cpu !== null && (!Number.isFinite(cpu) || cpu < 0 || cpu > 100)) return 'CPU — · RAM —';
  const used = (memory.usedBytes / 1024 ** 3).toFixed(1);
  const total = (memory.totalBytes / 1024 ** 3).toFixed(memory.totalBytes >= 10 * 1024 ** 3 ? 0 : 1);
  return `CPU ${cpu === null ? '—' : `${cpu.toFixed(0)}%`} · RAM ${used}/${total} GB`;
}

// Sidebar meters use the same Core sample as the persistent header.
export function hostMetricsRows(sample, width = 24) {
  const cpu = sample?.host?.cpuPercent, memory = sample?.host?.memory;
  const validCPU = Number.isFinite(cpu) && cpu >= 0 && cpu <= 100;
  const validRAM = memory && Number.isFinite(memory.totalBytes) && memory.totalBytes > 0 &&
    Number.isFinite(memory.usedBytes) && memory.usedBytes >= 0 && memory.usedBytes <= memory.totalBytes;
  const meter = (label, value, ratio) => {
    const size = Math.max(0, width - label.length - value.length - 3);
    const filled = ratio == null ? 0 : Math.round(size * ratio);
    return label + ' ' + (size ? '━'.repeat(filled) + '─'.repeat(size - filled) + ' ' : '') + value;
  };
  return [meter('CPU', validCPU ? Math.round(cpu) + '%' : '—', validCPU ? cpu / 100 : null),
    meter('RAM', validRAM ? (memory.usedBytes / 1024 ** 3).toFixed(1) + '/' + (memory.totalBytes / 1024 ** 3).toFixed(0) + 'G' : '—', validRAM ? memory.usedBytes / memory.totalBytes : null)];
}
