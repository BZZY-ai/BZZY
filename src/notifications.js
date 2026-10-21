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

export function telegramSettings() {
  const settings = config().notifications?.telegram || {};
  const secrets = readJson(path.join(home(), 'credentials.json'), {});
  return { enabled: settings.enabled !== false && Boolean(process.env.BZZY_TELEGRAM_CHAT_ID || settings.chatId),
    chatId: process.env.BZZY_TELEGRAM_CHAT_ID || settings.chatId,
    token: process.env.BZZY_TELEGRAM_BOT_TOKEN || secrets.telegramBotToken };
}

export function formatTelegram(event) {
  return [event.type === 'goal.completed' ? '🐝 bzzy — goal achieved' : '🐝 bzzy — goal stalled', '',
    event.objective.slice(0, 1600), '', `Provider: ${event.provider}${event.model ? ` / ${event.model}` : ''}`,
    `Status: ${event.status}`, `Usage: ${event.usage.available === false ? 'at least ' : ''}${event.usage.tokens} tokens · ${event.usage.turns} turns`,
    event.usage.seconds != null ? `Time: ${event.usage.seconds.toFixed(1)} seconds` : 'Time: unavailable',
    event.reason ? `Reason: ${event.reason.slice(0, 600)}` : '',
    `Workspace: ${event.cwd}`, `Session: ${event.sessionId}`].filter(Boolean).join('\n').slice(0, 4000);
}

export async function sendTelegram(event, { token, chatId, fetchImpl = fetch }) {
  if (!token || !chatId) throw new Error('Telegram needs a bot token and chat ID. Run bzzy telegram setup.');
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: formatTelegram(event), link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true) throw new Error(body.description || `HTTP ${response.status}`);
    return { messageId: body.result?.message_id };
  } catch (error) {
    throw new Error(`Telegram delivery failed: ${String(error.message).replaceAll(token, '[redacted]')}`);
  }
}

registerTransport('telegram', {
  enabled: () => telegramSettings().enabled,
  send: event => sendTelegram(event, telegramSettings()),
});

export class NotificationHub {
  constructor({ registry = transports, ui } = {}) { this.registry = registry; this.ui = ui; }

  async publish(session) {
    const event = goalEvent(session);
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
