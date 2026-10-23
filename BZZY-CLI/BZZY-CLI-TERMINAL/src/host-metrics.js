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
