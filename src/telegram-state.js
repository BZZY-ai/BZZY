import { randomUUID } from 'node:crypto';
import { telegramSettings } from './notifications.js';
import { loadSession } from './store.js';
import { digest, getRecord, putRecord, appendEvent, now, transaction } from './database.js';

export function telegramAttachment(settings = telegramSettings()) {
  const record = getRecord('telegram-attachment', 'current');
  return record?.enabled && settings.token && record.bot === digest(settings.token) && record.chatId === String(settings.chatId) ? record : null;
}
export function requireTelegramAttachment(id) {
  const current = telegramAttachment();
  if (current?.id !== id) throw Object.assign(new Error('Telegram is no longer attached to this conversation.'), { code: 'CONFLICT' });
  return current;
}
export function linkTelegram(sessionId, authorize) {
  const settings = telegramSettings();
  if (!settings.token || !settings.chatId) throw new Error('Set the Telegram bot token and chat ID first.');
  if (!/^[1-9]\d*$/.test(String(settings.chatId)) || !Number.isSafeInteger(Number(settings.chatId))) throw new Error('Chat attachment needs your private numeric Telegram chat ID. Groups and channels can receive goal notifications.');
  return transaction(db => {
    authorize(); const session = loadSession(sessionId);
    if (!session || ['parallel', 'besties'].includes(session.mode)) throw new Error('Select an individual conversation before attaching Telegram.');
    const previous = telegramAttachment(settings);
    if (previous?.sessionId === sessionId) return previous;
    if (previous) appendEvent(previous.sessionId, 'telegram.attachment', { attached: false, reason: 'attached_to_another_conversation' }, db);
    const record = { id: randomUUID(), sessionId, bot: digest(settings.token), chatId: String(settings.chatId), enabled: true, status: 'connecting', attachedAt: now(), eventCursor: 0 };
    const last = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session_id=?').get(sessionId);
    record.eventCursor = last.seq; record.attachedAfter = last.seq;
    putRecord('telegram-attachment', 'current', record, db);
    appendEvent(sessionId, 'telegram.attachment', { attached: true, attachmentId: record.id, chatId: record.chatId }, db);
    return record;
  });
}
export function unlinkTelegram(attachmentId, reason = 'user_detach') {
  return transaction(db => {
    const record = getRecord('telegram-attachment', 'current');
    if (!record?.enabled || attachmentId && record.id !== attachmentId) return;
    const updated = { ...record, enabled: false, status: 'detached', detachedAt: now(), reason };
    putRecord('telegram-attachment', 'current', updated, db);
    appendEvent(record.sessionId, 'telegram.attachment', { attached: false, reason }, db);
    return updated;
  });
}
export function updateTelegramAttachment(id, patch) {
  return transaction(db => {
    const record = getRecord('telegram-attachment', 'current');
    if (!record?.enabled || record.id !== id) return;
    const next = { ...record, ...patch }; putRecord('telegram-attachment', 'current', next, db);
    if (next.status !== record.status || next.lastError !== record.lastError) appendEvent(record.sessionId, 'telegram.status', { status: next.status, error: next.lastError || '', botUsername: next.botUsername || null }, db);
    return next;
  });
}
export function telegramViewState(sessionId) {
  const settings = telegramSettings(), attachment = telegramAttachment(settings);
  return { configured: Boolean(settings.token && settings.chatId), tokenConfigured: Boolean(settings.token), chatId: settings.chatId || '',
    goalNotifications: settings.enabled, attached: Boolean(attachment?.sessionId === sessionId), attachedSessionId: attachment?.sessionId || null,
    status: attachment?.status || 'detached', error: attachment?.lastError || '', botUsername: attachment?.botUsername || null };
}
