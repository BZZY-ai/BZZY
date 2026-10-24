import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// A connected socket is not proof of liveness. Match a fresh control-frame
// challenge on this authenticated socket; never send or retry application work.
export class RelayConnectionHealth {
  #socket; #verified; #verifiedAt; #pending; #timer; #closed = false; #misses = 0; #probeSocket;
  constructor(client, { intervalMs = 2000, timeoutMs = 2500, maximumAgeMs = 6000, clock = () => performance.now() } = {}) {
    this.client = client; Object.assign(this, { intervalMs, timeoutMs, maximumAgeMs, clock });
  }
  snapshot() {
    const age = this.clock() - this.#verified;
    const online = !this.#closed && this.client.status === 'online' && this.client.ws === this.#socket
      && this.#socket?.readyState === 1 && Number.isFinite(age) && age >= 0 && age <= this.maximumAgeMs;
    return { online, verifiedAt: online ? this.#verifiedAt : null, maximumAgeMs: this.maximumAgeMs };
  }
  start() {
    const tick = async () => {
      if (this.#closed) return;
      await this.probe().catch(() => {});
      if (!this.#closed) { this.#timer = setTimeout(tick, this.intervalMs); this.#timer.unref(); }
    };
    void tick(); return this;
  }
  probe() {
    if (this.#pending) return this.#pending;
    const socket = this.client.ws;
    if (this.#closed || this.client.status !== 'online' || socket?.readyState !== 1) {
      this.#verified = undefined; return Promise.reject(new Error('RELAY_OFFLINE'));
    }
    const nonce = randomBytes(16);
    if (this.#probeSocket !== socket) { this.#probeSocket = socket; this.#misses = 0; }
    const started = this.clock();
    this.#pending = new Promise((resolve, reject) => {
      let timer, settled = false;
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(timer); socket.off('pong', pong); socket.off('close', closed); socket.off('error', closed);
        if (error || this.#closed || this.client.ws !== socket || this.client.status !== 'online') {
          this.#verified = undefined; reject(new Error('RELAY_OFFLINE'));
        } else {
          this.#socket = socket; this.#misses = 0; this.#verified = this.clock(); this.#verifiedAt = new Date().toISOString(); resolve(this.snapshot());
        }
      };
      const pong = data => { if (Buffer.from(data).equals(nonce)) finish(); };
      const closed = () => finish(true);
      socket.on('pong', pong); socket.once('close', closed); socket.once('error', closed);
      timer = setTimeout(() => {
        finish(true);
        // A blocked local event loop cannot establish that the remote socket
        // failed. Mark it offline, but preserve in-flight transfers. Two timely
        // unanswered probes are required before forcing a transport reconnect.
        if (this.clock() - started <= this.timeoutMs * 2 && ++this.#misses >= 2 && this.client.ws === socket) socket.terminate();
      }, this.timeoutMs);
      timer.unref();
      try { socket.ping(nonce, error => { if (error) finish(true); }); } catch { finish(true); }
    }).finally(() => { this.#pending = undefined; });
    return this.#pending;
  }
  close() { this.#closed = true; clearTimeout(this.#timer); this.#verified = undefined; }
}
