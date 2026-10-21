import fs from 'node:fs';
import path from 'node:path';
import { config } from './providers.js';
import { home, readJson, writeJson, lockFile } from './store.js';
import { getRecord, putRecord, listRecords, transaction } from './database.js';
import { transports, registerTransport } from './notification-registry.js';
import { goalEvent } from './lifecycle.js';
import { duration } from './terminal-format.js';
import { delegationTokenLines } from './delegation-format.js';
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

function groupedAgentLines(agents = []) {
  const grouped = new Map();
  for (const agent of agents) {
    const key = `${agent.provider || agent.agent || 'agent'}\0${agent.model || ''}`, previous = grouped.get(key) || {
      provider: agent.provider || agent.agent || 'agent', model: agent.model || '', tokens: 0, available: true, seen: false };
    if (agent.tokens == null) previous.available = false;
    else { previous.tokens += agent.tokens; previous.seen = true; }
    grouped.set(key, previous);
  }
  return [...grouped.values()].map(agent => `${agent.provider}${agent.model ? `/${agent.model}` : ''} · ${agent.seen ? `${agent.available ? '' : '≥'}${agent.tokens.toLocaleString()} tokens` : 'usage unavailable'}`);
}

function formatDebateTelegram(event) {
  const result = event.result || {}, consensus = result.consensus;
  const status = event.type === 'goal.completed' ? 'GOAL ACHIEVED' : 'GOAL STALLED';
  const lines = ['🐝 bzzy · debate', `/goal ${event.objective.slice(0, 1600)}`];
  if (consensus?.verdict) {
    const agreeing = consensus.counts?.[consensus.verdict] || 0;
    lines.push(`CONSENSUS ${agreeing}/${consensus.total} · ${consensus.verdict === 'real' ? 'REAL' : 'FALSE POSITIVE'}`);
    if (result.conclusions?.[0]) lines.push(result.conclusions[0]);
  } else {
    lines.push(result.outcome === 'assessed' ? 'DEBATE ASSESSED' : 'DEBATE UNRESOLVED');
    for (const conclusion of result.conclusions || []) lines.push(conclusion);
    for (const unresolved of result.unresolved || []) lines.push(`Unresolved · ${unresolved}`);
  }
  lines.push(`${status} · ${event.usage.seconds == null ? 'time unavailable' : duration(event.usage.seconds)} · ${event.usage.available === false ? 'at least ' : ''}${event.usage.tokens.toLocaleString()} tokens`,
    ...groupedAgentLines(event.usage.agents), `Session · ${event.sessionId}`);
  if (event.reason) lines.push(`Reason · ${event.reason.slice(0, 600)}`);
  return lines.filter(line => line !== undefined && line !== null).join('\n').slice(0, 4000);
}

export function formatTelegram(event) {
  if (event.mode === 'debate') return formatDebateTelegram(event);
  return [event.type === 'goal.completed' ? '🐝 bzzy — goal achieved' : '🐝 bzzy — goal stalled', '',
    event.objective.slice(0, 1600), '', `Provider: ${event.provider}${event.model ? ` / ${event.model}` : ''}`,
    `Status: ${event.status}`, ...(event.mode === 'delegate' ? delegationTokenLines(event, { ...event.usage, totalTokens: event.usage.tokens, complete: event.usage.available !== false })
      : [`Usage: ${event.usage.available === false ? 'at least ' : ''}${event.usage.tokens} tokens · ${event.usage.turns} turns`]),
    event.usage.seconds != null ? `Time: ${duration(event.usage.seconds)}` : 'Time: unavailable',
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
