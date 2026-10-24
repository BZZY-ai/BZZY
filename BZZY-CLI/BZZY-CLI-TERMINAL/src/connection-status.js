import { performance } from 'node:perf_hooks';
import { palette } from './terminal-theme.js';

export class ConnectionStatusMonitor {
  #timer; #expiry; #closed = false; #client; #verifiedAt = -Infinity;
  constructor(onChange, { load = async () => new (await import('@bzzy/core/connections')).CoreConnectionsClient(), intervalMs = 2000,
    maximumAgeMs = 5000, clock = () => performance.now() } = {}) {
    Object.assign(this, { onChange, load, intervalMs, maximumAgeMs, clock });
  }
  start() {
    this.#expiry = setInterval(() => {
      if (this.clock() - this.#verifiedAt > this.maximumAgeMs) this.onChange(null);
    }, 500); this.#expiry.unref(); void this.#poll(); return this;
  }
  async #poll() {
    try {
      this.#client ||= await this.load();
      if (this.#closed) return;
      const value = await this.#client.read();
      if (!this.#closed) { this.#verifiedAt = this.clock(); this.onChange(value); }
    } catch { if (!this.#closed) { this.#verifiedAt = -Infinity; this.onChange(null); } }
    finally { if (!this.#closed) { this.#timer = setTimeout(() => { void this.#poll(); }, this.intervalMs); this.#timer.unref(); } }
  }
  close() { this.#closed = true; clearTimeout(this.#timer); clearInterval(this.#expiry); this.#client?.close?.(); }
}

export function connectionStatusLabel(sample, theme, compact = false) {
  const badge = (label, online) => theme.color('●', online ? palette.goalSuccess : palette.danger, true)
    + theme.color(` ${label} ${online ? compact ? 'ON' : 'Online' : compact ? 'OFF' : 'Offline'}`, palette.muted);
  return badge('Core', sample?.core === true) + '  ' + badge('Relay', sample?.core === true && sample?.relay === true);
}
