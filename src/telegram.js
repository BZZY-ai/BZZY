import path from 'node:path';
import { config, saveConfig } from './providers.js';
import { home, readJson, writeJson } from './files.js';
import { telegramSettings, sendTelegram } from './notifications.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { TelegramApi } from './telegram-api.js';
import { telegramAttachment, linkTelegram, unlinkTelegram, telegramViewState } from './telegram-state.js';
import { ensureTelegramBridge, stopTelegramBridge } from './telegram-bridge.js';
import { ensureRuntime, runtimeRequest, requireOwner } from './runtime.js';

function saveTelegramConnection(token, chatId) {
  const file = path.join(home(), 'credentials.json');
  writeJson(file, { ...readJson(file, {}), telegramBotToken: token });
  const value = config(); value.notifications ||= {}; value.notifications.telegram ||= {};
  value.notifications.telegram = { ...value.notifications.telegram, enabled: value.notifications.telegram.enabled ?? true, chatId: String(chatId) };
  saveConfig(value);
}

export async function attachTelegram(sessionId, connection, { startBridge = ensureTelegramBridge } = {}) {
  if (!sessionId) throw new Error('Open a bzzy conversation before attaching Telegram.');
  const info = connection?.info || await ensureRuntime(), owner = connection?.owner || randomUUID();
  if (!connection) await runtimeRequest(info, 'POST', `/sessions/${sessionId}/claim`, { owner, takeover: true });
  try {
    const attachment = linkTelegram(sessionId, () => requireOwner(sessionId, owner));
    await startBridge(); return attachment;
  } finally { if (!connection) await runtimeRequest(info, 'POST', `/sessions/${sessionId}/release`, { owner }).catch(() => {}); }
}

export async function pairTelegram(ui, context = {}) {
  const current = telegramSettings();
  const token = (process.env.BZZY_TELEGRAM_BOT_TOKEN || await ui.secret('Telegram bot token (hidden' + (current.token ? '; Enter keeps saved token' : '') + '): '))?.trim();
  if (token == null) return;
  const selectedToken = token || current.token;
  if (!/^\d+:[a-zA-Z0-9_-]+$/.test(selectedToken || '') || selectedToken.length > 300) throw new Error('Enter the bot token supplied by BotFather.');
  const api = context.apiFactory ? context.apiFactory(selectedToken) : new TelegramApi(selectedToken), abort = new AbortController();
  const phrase = 'BZZY ' + randomBytes(4).toString('hex').toUpperCase(), timeout = setTimeout(() => abort.abort(), context.timeoutMs || 180000);
  const cancel = () => abort.abort(); process.on('SIGINT', cancel);
  let waiting, succeeded = false;
  await (context.stopBridge || stopTelegramBridge)();
  try {
    const me = await api.call('getMe', {}, abort.signal), webhook = await api.call('getWebhookInfo', {}, abort.signal);
    if (webhook.url) throw new Error('This bot has an existing webhook. Use a dedicated bot for bzzy chat.');
    const tail = await api.call('getUpdates', { offset: -1, limit: 1, timeout: 0, allowed_updates: ['message'] }, abort.signal);
    let offset = tail.at(-1)?.update_id + 1 || 0;
    ui.telegramPairing = { phrase, botUsername: me.username, expiresAt: Date.now() + (context.timeoutMs || 180000) };
    ui.tui?.setPanel('telegram'); ui.tui?.schedule();
    ui.event('info', { message: `Open ${me.username ? '@' + me.username : 'your Telegram bot'} and send: ${phrase}\nbzzy will detect and save your private chat ID automatically. Pairing expires in three minutes.` });
    if (ui.tui) waiting = ui.ask('Waiting for your Telegram message · Esc cancels: ').then(cancel);
    while (!abort.signal.aborted) {
      const updates = await api.call('getUpdates', { offset, timeout: 20, limit: 100, allowed_updates: ['message'] }, abort.signal);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const message = update.message;
        if (message?.text?.trim() !== phrase || message.chat?.type !== 'private' || String(message.from?.id) !== String(message.chat.id) || message.from?.is_bot) continue;
        const previous = telegramAttachment(); if (previous) unlinkTelegram(previous.id, 'connection_reconfigured');
        saveTelegramConnection(selectedToken, message.chat.id); succeeded = true;
        ui.event('info', { message: `Telegram paired · chat ID ${message.chat.id} saved privately.` });
        return { chatId: String(message.chat.id) };
      }
    }
  } catch (error) { if (!abort.signal.aborted) throw error; }
  finally {
    clearTimeout(timeout); abort.abort(); process.removeListener('SIGINT', cancel); ui.telegramPairing = null;
    if (waiting) { ui.reader?.close(); await waiting; } ui.tui?.schedule();
    if (!succeeded && telegramAttachment()) await (context.startBridge || ensureTelegramBridge)();
  }
  ui.event('info', { message: 'Telegram pairing cancelled or expired. Existing settings were kept.' });
}

export async function configureTelegram(command = 'setup', ui, context = {}) {
  command = command.trim() || 'setup';
  if (command === 'setup') command = 'pair';
  if (command === 'panel') { ui.tui?.setPanel('telegram'); return; }
  if (command === 'pair' || command === 'attach' && (!telegramSettings().token || !telegramSettings().chatId)) {
    const paired = await pairTelegram(ui, context); if (!paired) return;
    if (context.sessionId) { await attachTelegram(context.sessionId, context.connection, context); ui.event('info', { message: 'Telegram attached. Only new messages will be mirrored; you can chat from either terminal or Telegram.' }); }
    return;
  }
  if (command === 'attach') { await attachTelegram(context.sessionId, context.connection, context); ui.event('info', { message: 'Telegram attached to this conversation. Only new messages will be mirrored.' }); return; }
  if (command === 'detach') { const current = telegramAttachment(); if (current) unlinkTelegram(current.id); await (context.stopBridge || stopTelegramBridge)(); ui.event('info', { message: 'Telegram chat detached. Goal notification settings were kept.' }); return; }
  if (!['manual', 'status', 'on', 'off', 'test'].includes(command)) throw new Error('Use /telegram [pair|attach|detach|setup|status|on|off|test]. Never put a bot token in a chat command.');
  const current = telegramSettings();
  if (command === 'on' && (!current.token || !current.chatId)) {
    const paired = await pairTelegram(ui, context); if (!paired) return;
    const value = config(); value.notifications.telegram.enabled = true; saveConfig(value);
    ui.event('info', { message: 'Telegram goal notifications enabled. Chat attachment has its own checkbox.' }); return;
  }
  if (command === 'manual') {
    const enteredToken = (process.env.BZZY_TELEGRAM_BOT_TOKEN || await ui.secret('Telegram bot token (hidden' + (current.token ? '; Enter keeps saved token' : '') + '): '))?.trim();
    if (enteredToken == null) return;
    const token = enteredToken || current.token;
    const enteredChat = (process.env.BZZY_TELEGRAM_CHAT_ID || await ui.ask('Telegram chat ID' + (current.chatId ? ` [${current.chatId}]` : '') + ': '))?.trim();
    if (enteredChat == null) return;
    const chatId = enteredChat || current.chatId;
    if (!token || !chatId) throw new Error('A bot token and chat ID are required. Use /telegram to configure them.');
    if (!/^\d+:[a-zA-Z0-9_-]+$/.test(token) || token.length > 300) throw new Error('Enter the bot token supplied by BotFather.');
    if (!/^(?:-?\d+|@[a-zA-Z][a-zA-Z0-9_]{3,})$/.test(chatId) || chatId.length > 200) throw new Error('Enter a numeric Telegram chat ID, or a channel username beginning with @.');
    saveTelegramConnection(token, chatId);
    ui.event('info', { message: 'Telegram saved. Goal achieved and stalled notifications include time, tokens and the session ID. Use /telegram on or off to control them.' });
  } else if (command === 'on' || command === 'off') {
    const value = config(); value.notifications ||= {}; value.notifications.telegram ||= {};
    value.notifications.telegram.enabled = command === 'on'; saveConfig(value);
    ui.event('info', { message: `Telegram notifications ${command}.` });
  } else if (command === 'test') {
    await sendTelegram({ type: 'goal.completed', objective: 'Test notification — your bzzy Telegram connection works.', provider: 'test', model: null,
      status: 'test', usage: { tokens: 0, turns: 0, seconds: 0 }, cwd: process.cwd(), sessionId: 'test' }, current);
    ui.event('info', { message: 'Telegram test message delivered.' });
  } else {
    const state = telegramViewState(context.sessionId);
    ui.event('info', { message: `Telegram goals: ${current.enabled ? 'enabled' : 'disabled'} · token ${current.token ? 'configured' : 'missing'} · chat ${current.chatId || 'missing'}\nChat attachment: ${state.attachedSessionId || 'off'}\nUse /telegram pair for automatic chat pairing, attach/detach for chat, or on/off for goal notifications.` });
  }
}
