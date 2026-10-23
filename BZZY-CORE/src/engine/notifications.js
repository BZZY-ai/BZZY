import fs from 'node:fs';
import path from 'node:path';
import { config } from './providers.js';
import { home, readJson, writeJson, lockFile } from './store.js';
import { getRecord, putRecord, listRecords, transaction } from './database.js';
import { transports, registerTransport } from './notification-registry.js';
import { goalEvent } from './lifecycle.js';
export { registerTransport } from './notification-registry.js';
export { goalEvent } from './lifecycle.js';

// A transport consumes a versioned goal event; it never controls goal lifecycle.

export class NotificationHub {
  constructor({ registry = transports, ui } = {}) { this.registry = registry; this.ui = ui; }

  async publish(session, options) {
    const event = goalEvent(session, options);
    if (!event) return null;
    const key = `${event.sessionId}-${event.goalId}-${event.epoch}-${event.type}`;
    const file = path.join(home(), 'notifications', `${key}.json`);
    let record = getRecord('outbox', key) || readJson(file, null);
    if (!record) {
      record = { event, deliveries: {} };
      for (const [name, transport] of this.registry) {
        if (transport.enabled(config())) record.deliveries[name] = { status: 'pending', attempts: 0 };
      }
      putRecord('outbox', key, record);
    }
    writeJson(file, record);
    await this.deliver(file, record);
    return record.event;
  }

  async deliver(file, record) {
    let unlock;
    try { unlock = lockFile(`${file}.lock`, 'Notification delivery is already running.'); }
    catch (error) { if (error.code === 'BZZY_LOCKED') return; throw error; }
    try {
      const key = path.basename(file, '.json');
      record = getRecord('outbox', key) || readJson(file, record);
      for (const [name, delivery] of Object.entries(record.deliveries)) {
        if (delivery.status === 'sent') continue;
        const transport = this.registry.get(name);
        if (!transport || !transport.enabled(config())) continue;
        delivery.attempts++;
        delivery.lastAttemptAt = new Date().toISOString();
        putRecord('outbox', key, record); writeJson(file, record);
        try {
          delivery.receipt = await transport.send(record.event, { config: config() });
          delivery.status = 'sent';
          delete delivery.error;
        } catch (error) {
          delivery.status = 'failed';
          delivery.error = error.message;
          this.ui?.event('error', { message: `${name}: ${error.message} Delivery saved; use bzzy notifications retry.` });
        }
        putRecord('outbox', key, record); writeJson(file, record);
      }
    } finally {
      unlock();
    }
  }

  records() {
    const dir = path.join(home(), 'notifications');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) if (!getRecord('outbox', f.slice(0, -5))) putRecord('outbox', f.slice(0, -5), readJson(path.join(dir, f)));
    return listRecords('outbox').map(record => ({ file: path.join(dir, `${record.event.sessionId}-${record.event.goalId}-${record.event.epoch}-${record.event.type}.json`), ...record }));
  }

  async retry() { for (const { file, ...record } of this.records()) await this.deliver(file, record); }
}
