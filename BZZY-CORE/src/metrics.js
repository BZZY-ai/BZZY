import { ensureRuntime, runtimeRequest } from './engine/runtime.js';
import { home } from './engine/files.js';
import { fail } from './validation.js';

// Trusted local UI facade. Credentials stay inside the host runtime adapter.
export class CoreMetricsClient {
  #info;
  #home = home();
  #check() {
    if (home() !== this.#home) fail('HOST_CONTEXT_CHANGED', 'BZZY_HOME changed after metrics initialization. Use a separate process for each host.', 409);
  }
  async read() {
    this.#check();
    try {
      this.#info ||= await ensureRuntime();
      this.#check();
      const sample = await runtimeRequest(this.#info, 'GET', '/v1/metrics');
      this.#check();
      return sample;
    } catch (error) {
      // A stopped/reinstalled daemon may have a different listener or token.
      // Let the next visible poll rediscover it instead of pinning a dead URL.
      this.#info = undefined;
      throw error;
    }
  }
  close() {} // Closing a view never stops the shared daemon sampler.
}
