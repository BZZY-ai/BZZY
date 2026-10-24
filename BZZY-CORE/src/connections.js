import { runtimeInfo } from './engine/runtime.js';
import { identityAlive } from './engine/process-identity.js';
import { home } from './engine/files.js';

// Observation only: polling never calls ensureRuntime or starts a stopped Core.
export class CoreConnectionsClient {
  #home = home();
  async read() {
    if (home() !== this.#home) throw new Error('HOST_CONTEXT_CHANGED');
    const info = runtimeInfo(), url = info && new URL(info.url);
    if (!info || !identityAlive(info.identity) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('CORE_OFFLINE');
    const response = await fetch(url.href + 'v1/connections', { redirect: 'error', headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(2500) });
    const value = await response.json();
    if (!response.ok || home() !== this.#home || value.version !== 1 || value.core?.online !== true
      || value.identity?.pid !== info.identity.pid || value.identity?.start !== info.identity.start || value.identity?.boot !== info.identity.boot
      || !identityAlive(info.identity) || !Number.isFinite(Date.parse(value.sampledAt))
      || Date.now() - Date.parse(value.sampledAt) > 3000 || Date.parse(value.sampledAt) - Date.now() > 1000) throw new Error('CORE_OFFLINE');
    return { version: 1, core: true, relay: value.relay?.online === true, checkedAt: value.sampledAt };
  }
  close() {}
}
