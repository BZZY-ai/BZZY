import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { stopProcess } from './policy.js';

// Only local, deliberate transport cleanup creates this error. Backend crashes
// and RPC error replies remain distinct, even if they use the same message.
export class BackendClosedError extends Error {
  constructor() { super('Backend connection closed.'); this.name = 'BackendClosedError'; }
}

export class Rpc extends EventEmitter {
  constructor(child, onRequest) {
    super();
    this.child = child;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.stderr = '';
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { this.emit('diagnostic', { message: 'Ignored a non-JSON backend stdout line.' }); return; }
      try { this.message(message, onRequest); }
      catch (error) { this.fail(new Error(`Backend message handler failed: ${error.message}`, { cause: error })); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-12000); });
    child.stdin.on('error', error => this.fail(error));
    child.once('error', error => this.fail(error));
    child.once('close', code => this.fail(new Error(`Backend exited (${code})${this.stderr ? `: ${this.stderr.trim()}` : ''}`)));
  }

  send(message) {
    if (this.closed) throw this.failure;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 60000) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Backend timed out handling ${method}.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.send({ method, params }); }

  message(message, onRequest) {
    if (message.method && message.id != null) {
      Promise.resolve().then(() => onRequest(message.method, message.params)).then(
        result => { if (!this.closed) this.send({ id: message.id, result }); },
        error => { if (!this.closed) this.send({ id: message.id, error: { code: -32601, message: error.message } }); },
      ).catch(error => this.fail(error));
    } else if (message.method) {
      this.emit('notification', message.method, message.params || {});
    } else {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message),
        Number.isSafeInteger(message.error.code) ? { rpcCode: message.error.code } : {}));
      else pending.resolve(message.result);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
    this.emit('failure', error);
  }

  async close() {
    this.fail(new BackendClosedError());
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode != null || this.child.signalCode != null) return;
    await new Promise(resolve => {
      const force = setTimeout(() => { stopProcess(this.child, 'SIGKILL'); resolve(); }, 3000);
      this.child.once('close', () => { clearTimeout(force); resolve(); });
      stopProcess(this.child, 'SIGTERM');
    });
  }
}
