import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as backoff } from 'node:timers/promises';
import { TelegramApi, telegramTextParts } from './telegram-api.js';
import { formatTelegram, telegramSettings } from './notifications.js';
import { telegramAttachment, requireTelegramAttachment, updateTelegramAttachment, unlinkTelegram } from './telegram-state.js';
import { database, digest, getRecord, putRecord, listRecords, appendEvent, events, transaction, reserveRequest, now } from './database.js';
import { home, privateDir, readJson, writeJson, loadSession, lockFile } from './store.js';
import { processIdentity, identityAlive } from './recovery.js';
import { root, runtimeEnv } from './process.js';
import { runtimeInfo } from './runtime.js';
import { enqueueExecution } from './execution-queue.js';
import { prepareTask } from './task.js';
import { normalizeContract } from './contracts.js';
import { newGoal } from './goals.js';
import { delay } from './delegation.js';
import { TelegramMenus, telegramBotCommands } from './telegram-menus.js';
import { goalEvent } from './lifecycle.js';

const relayFile = () => path.join(home(), 'runtime', 'telegram.json');
const activeStates = ['queued', 'launching', 'running'];
export const telegramBridgeInfo = () => readJson(relayFile(), null);
export function telegramAuthorizedMessage(update, attachment) {
  const callback = update?.callback_query, message = callback?.message || update?.message, sender = callback?.from || message?.from;
  return Number.isSafeInteger(update?.update_id) && (typeof update.message?.text === 'string' || typeof callback?.data === 'string' && callback.data.startsWith('bzzy:')) && message?.chat?.type === 'private'
    && String(message.chat.id) === attachment.chatId && String(sender?.id) === attachment.chatId && !sender?.is_bot;
}
export function replyText(sessionId, executionId, through, after = 0) {
  const start = database().prepare("SELECT seq FROM events WHERE session_id=? AND type='message.user' AND json_extract(data,'$.executionId')=? ORDER BY seq DESC LIMIT 1").get(sessionId, executionId)?.seq;
  if (!start) return '';
  let text = '';
  for (const row of database().prepare("SELECT type,data FROM events WHERE session_id=? AND seq>? AND seq<=? AND type='text' ORDER BY seq").iterate(sessionId, Math.max(start, after), through)) {
    const data = JSON.parse(row.data);
    text += data.text || '';
  }
  text = text.trim();
  const session = loadSession(sessionId);
  if (session?.mode === 'debate' && session.goal && !['active', 'verifying'].includes(session.goal.status)) {
    const event = goalEvent(session);
    if (event && !telegramSettings().enabled) return [text, formatTelegram(event)].filter(Boolean).join('\n\n');
  }
  return text;
}

export class TelegramBridge {
  constructor({ apiFactory = token => new TelegramApi(token), minSendIntervalMs = 1100 } = {}) {
    this.apiFactory = apiFactory; this.minSendIntervalMs = minSendIntervalMs; this.lastSentAt = 0; this.abort = new AbortController();
    this.menus = new TelegramMenus(this);
  }
  binding() {
    const settings = telegramSettings(), attachment = telegramAttachment(settings);
    if (!attachment) return null;
    if (this.bot !== attachment.bot) { this.api = this.apiFactory(settings.token); this.bot = attachment.bot; }
    return attachment;
  }
  queueText(attachment, source, text, extra = {}, questionId) {
    const parts = telegramTextParts(text);
    return parts.map((part, index) => transaction(db => {
      const id = digest([attachment.id, source, index]), previous = getRecord('telegram-delivery', id);
      if (previous) return previous;
      const record = { id, attachmentId: attachment.id, sessionId: attachment.sessionId, chatId: attachment.chatId, source, text: part,
        extra, questionId: questionId || null, state: 'pending', createdAt: now(), attempts: 0 };
      record.seq = appendEvent(attachment.sessionId, 'telegram.message', { id, direction: 'outgoing', status: 'queued', text: part, occurredAt: record.createdAt }, db).seq;
      putRecord('telegram-delivery', id, record, db); return record;
    }));
  }
  async initialize(attachment) {
    const state = getRecord('telegram-poll', attachment.bot);
    if (state?.attachmentId === attachment.id) { if (attachment.status !== 'connected') updateTelegramAttachment(attachment.id, { status: 'connected', lastError: '' }); return; }
    const me = await this.api.call('getMe', {}, this.abort.signal);
    const webhook = await this.api.call('getWebhookInfo', {}, this.abort.signal);
    if (webhook.url) throw new Error('This bot has a webhook. Use a dedicated bot for bzzy chat; its webhook was left unchanged.');
    const tail = await this.api.call('getUpdates', { offset: -1, limit: 1, timeout: 0, allowed_updates: ['message'] }, this.abort.signal);
    await this.api.call('setMyCommands', { scope: { type: 'chat', chat_id: Number(attachment.chatId) }, commands: telegramBotCommands }, this.abort.signal);
    requireTelegramAttachment(attachment.id);
    putRecord('telegram-poll', attachment.bot, { attachmentId: attachment.id, offset: tail.at(-1)?.update_id + 1 || state?.offset || 0 });
    updateTelegramAttachment(attachment.id, { status: 'connected', lastError: '', botUsername: me.username || null });
    this.queueText(attachment, 'attached', `🐝 bzzy is attached to this conversation.\nSession: ${attachment.sessionId}\nSend a message to chat, /goal <objective> for a goal, /status, /pause, /cancel, /resume or /detach. Reply directly to a question message when bzzy needs your input.`);
  }
  receive(updates, attachment) {
    transaction(db => {
      requireTelegramAttachment(attachment.id);
      const poll = getRecord('telegram-poll', attachment.bot) || { attachmentId: attachment.id, offset: 0 };
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id)) continue;
        poll.offset = Math.max(poll.offset, update.update_id + 1);
        if (!telegramAuthorizedMessage(update, attachment)) continue;
        const id = `${attachment.bot}:${update.update_id}`;
        if (getRecord('telegram-inbox', id)) continue;
        const pending = listRecords('telegram-inbox').filter(item => item.attachmentId === attachment.id && ['queued', 'processing'].includes(item.state));
        if (pending.length >= 100) continue;
        const callback = update.callback_query, message = callback?.message || update.message, record = { id, attachmentId: attachment.id, sessionId: attachment.sessionId, updateId: update.update_id,
          text: callback ? 'Selected ' + (getRecord('telegram-action', callback.data.replace(/^bzzy:/, ''))?.label || 'a Telegram menu option') : message.text, replyTo: !callback && message.reply_to_message?.message_id || null,
          callbackId: callback?.id || null, callbackData: callback?.data || null, state: 'queued', createdAt: now() };
        putRecord('telegram-inbox', id, record, db);
        appendEvent(attachment.sessionId, 'telegram.message', { id, direction: 'incoming', status: 'queued', text: record.text, occurredAt: record.createdAt }, db);
      }
      putRecord('telegram-poll', attachment.bot, poll, db);
    });
  }
  async pollOnce() {
    const attachment = this.binding(); if (!attachment) return;
    await this.initialize(attachment);
    const current = requireTelegramAttachment(attachment.id), poll = getRecord('telegram-poll', attachment.bot);
    const updates = await this.api.call('getUpdates', { offset: poll.offset, timeout: 20, limit: 100, allowed_updates: ['message', 'callback_query'] }, this.abort.signal);
    this.receive(updates, current); updateTelegramAttachment(current.id, { lastPollAt: now(), lastError: '' });
  }
  answer(attachment, item, question) {
    return reserveRequest(`answer:${attachment.sessionId}`, 'telegram-' + digest(item.id).slice(0, 48), { questionId: question.id, answer: item.text }, db => {
      requireTelegramAttachment(attachment.id);
      const current = getRecord('question', question.id);
      if (current?.state !== 'pending' || current.sessionId !== attachment.sessionId) throw new Error('That question has already been answered or expired.');
      putRecord('question', current.id, { ...current, state: 'answered', answer: item.text, answeredAt: now(), answeredBy: 'telegram' }, db);
      appendEvent(attachment.sessionId, 'question.answered', { id: current.id, answer: item.text, channel: 'telegram' }, db);
      return { answered: true };
    });
  }
  async processMessage(attachment, item) {
    requireTelegramAttachment(attachment.id);
    const session = loadSession(attachment.sessionId), text = item.text.trim();
    const requestId = 'telegram-' + digest(item.id).slice(0, 48);
    if (item.callbackId) { await this.menus.callback(attachment, item); return true; }
    if (await this.menus.command(attachment, item)) return true;
    if (item.replyTo) {
      const prompt = getRecord('telegram-prompt', `${attachment.id}:${item.replyTo}`);
      if (prompt) { this.answer(attachment, item, getRecord('question', prompt.questionId) || { id: prompt.questionId }); return true; }
    }
    if (text === '/start' || text === '/help') { this.queueText(attachment, item.id, 'Send text to chat, /goal <objective>, /status, /pause, /cancel, /resume or /detach. Reply directly to a bzzy question message to answer it.'); return true; }
    if (text === '/status') {
      this.queueText(attachment, item.id, `${session.provider} · ${session.model || 'default'}\n${session.executionState} · ${session.goal ? 'goal ' + session.goal.status : 'chat'}\n${session.usage?.tokens?.toLocaleString() || 'Unknown'} tokens\nSession: ${session.id}`); return true;
    }
    if (text === '/detach') {
      try { await this.api.send(attachment.chatId, 'Telegram chat detached. Goal notifications keep their own on/off setting.'); }
      finally { unlinkTelegram(attachment.id, 'telegram_command'); }
      return true;
    }
    if (text === '/pause' || text === '/cancel') {
      reserveRequest(`control:${session.id}`, requestId, { action: text.slice(1), text: '' }, db => {
        requireTelegramAttachment(attachment.id);
        const control = { id: randomUUID(), sessionId: session.id, action: text.slice(1), text: '', state: 'queued', createdAt: now() };
        if (listRecords('execution').some(job => job.sessionId === session.id && activeStates.includes(job.state))) { putRecord('control', control.id, control, db); appendEvent(session.id, 'control.queued', control, db); }
        if (text === '/cancel') for (const pending of listRecords('telegram-inbox').filter(row => row.attachmentId === attachment.id && row.id !== item.id && row.updateId < item.updateId && row.state === 'queued')) putRecord('telegram-inbox', pending.id, { ...pending, state: 'cancelled' }, db);
        return { controlId: control.id };
      });
      this.queueText(attachment, item.id, `${text === '/pause' ? 'Pause' : 'Cancel'} requested for this conversation.`); return true;
    }
    const startGoal = /^\/goal\s+(.+)/s.exec(text), resume = text === '/resume';
    if (text.startsWith('/') && !startGoal && !resume) { this.queueText(attachment, item.id, 'Unknown command. Use /help, or send a normal chat message.'); return true; }
    if (resume && (!session.goal || session.goal.status === 'complete')) { this.queueText(attachment, item.id, 'There is no unfinished goal to resume. Send a message or /goal <objective>.'); return true; }
    if (!identityAlive(runtimeInfo()?.identity)) return false;
    if (listRecords('execution').some(job => job.sessionId === session.id && activeStates.includes(job.state))) {
      if (startGoal) reserveRequest(`replace-goal:${session.id}`, requestId, { objective: startGoal[1].trim() }, db => {
        requireTelegramAttachment(attachment.id);
        const control = { id: randomUUID(), sessionId: session.id, action: 'cancel', text: '', state: 'queued', createdAt: now() };
        putRecord('control', control.id, control, db); appendEvent(session.id, 'control.queued', control, db);
        return { controlId: control.id };
      });
      return false;
    }
    const input = item.prepared || { prompt: startGoal ? startGoal[1].trim() : resume ? session.goal.objective : text, options: { ...(session.contract?.limits || {}) }, goal: Boolean(startGoal || resume), resumeGoal: resume };
    if (!item.prepared) putRecord('telegram-inbox', item.id, { ...item, prepared: input });
    const result = enqueueExecution(session.id, input, requestId, {
      authorize: () => requireTelegramAttachment(attachment.id), channel: 'telegram',
      prepare: (fresh, db) => {
        if (startGoal) {
          const previousGoal = fresh.goal;
          if (!fresh.contract) prepareTask(fresh, {}, input.prompt, { persist: false });
          else fresh.contract = normalizeContract({ constraints: fresh.contract.constraints, scope: fresh.contract.scope, policy: fresh.policy || fresh.contract.policy, limits: fresh.contract.limits }, input.prompt);
          fresh.goal = newGoal(input.prompt, fresh.contract.limits.tokenBudget);
          fresh.acceptance = null; fresh.summary = null; fresh.failure = null; fresh.stopReason = null;
          if (previousGoal) putRecord('goal-history', previousGoal.id, { sessionId: fresh.id, ...previousGoal, supersededAt: now(), supersededBy: fresh.goal.id }, db);
          putRecord('session', fresh.id, fresh, db);
        } else if (resume) {
          if (fresh.goal.tokenBudget != null && fresh.goal.tokensUsed >= fresh.goal.tokenBudget) throw new Error('The goal budget is exhausted. Increase its budget from bzzy before resuming.');
          fresh.goal.notificationEpoch = (fresh.goal.notificationEpoch || 0) + 1; fresh.goal.noActivityTurns = 0; fresh.goal.blockerStreak = 0; fresh.goal.lastBlocker = null; delete fresh.goal.reason;
          putRecord('session', fresh.id, fresh, db);
        }
      },
    });
    putRecord('telegram-inbox', item.id, { ...getRecord('telegram-inbox', item.id), state: 'dispatched', executionId: result.executionId }); return true;
  }
  syncOutbound(attachment) {
    let cursor = attachment.eventCursor;
    for (const event of events(attachment.sessionId, cursor, 200)) {
      if (event.type === 'message.user' && event.data.channel !== 'telegram') {
        this.queueText(attachment, `user:${event.seq}`, `🖥 TERMINAL INPUT\n${event.data.kind === 'goal' ? '/goal ' : ''}${event.data.text}`);
      } else if (event.type === 'question.answered' && event.data.channel !== 'telegram') {
        this.queueText(attachment, `answer:${event.seq}`, `🖥 TERMINAL ANSWER\n${event.data.answer}`);
      } else if (event.type === 'execution.finished') {
        const text = replyText(attachment.sessionId, event.data.id, event.seq, attachment.attachedAfter);
        if (text) this.queueText(attachment, `execution:${event.data.id}`, text);
        else if (event.data.error) this.queueText(attachment, `execution:${event.data.id}`, `bzzy could not finish this reply: ${event.data.error}`);
      }
      cursor = event.seq;
    }
    for (const question of listRecords('question').filter(row => row.sessionId === attachment.sessionId && row.state === 'pending')) {
      this.queueText(attachment, 'question:' + question.id, `${question.question}\n\nReply directly to this message to answer.`, { reply_markup: { force_reply: true } }, question.id);
    }
    if (cursor !== attachment.eventCursor) updateTelegramAttachment(attachment.id, { eventCursor: cursor });
  }
  async deliver(attachment) {
    if (this.abort.signal.aborted || telegramAttachment()?.id !== attachment.id) return;
    if (Date.now() - this.lastSentAt < this.minSendIntervalMs) return;
    const record = listRecords('telegram-delivery').filter(item => item.attachmentId === attachment.id && item.state === 'pending').sort((a, b) => a.seq - b.seq)[0];
    if (!record || (record.retryAt || 0) > Date.now()) return;
    putRecord('telegram-delivery', record.id, { ...record, state: 'sending', attempts: record.attempts + 1 }); this.lastSentAt = Date.now();
    try {
      const result = await this.api.send(record.chatId, record.text, record.extra, this.abort.signal);
      transaction(db => {
        putRecord('telegram-delivery', record.id, { ...record, state: 'sent', messageId: result.message_id, sentAt: now(), attempts: record.attempts + 1 }, db);
        if (record.questionId) putRecord('telegram-prompt', `${attachment.id}:${result.message_id}`, { questionId: record.questionId }, db);
        appendEvent(record.sessionId, 'telegram.message', { id: record.id, direction: 'outgoing', status: 'sent', text: record.text, occurredAt: now() }, db);
      });
    } catch (error) {
      const state = error.retryAfter ? 'pending' : error.definite ? 'failed' : 'uncertain';
      putRecord('telegram-delivery', record.id, { ...record, state, attempts: record.attempts + 1, error: error.message, retryAt: Date.now() + (error.retryAfter || 0) * 1000 });
      appendEvent(record.sessionId, 'telegram.message', { id: record.id, direction: 'outgoing', status: state, text: record.text, error: error.message, occurredAt: now() });
    }
  }
  async tick() {
    if (this.abort.signal.aborted) return;
    const attachment = this.binding(); if (!attachment) return;
    this.syncOutbound(attachment);
    const inbox = listRecords('telegram-inbox').filter(item => item.attachmentId === attachment.id && item.state === 'queued').sort((a, b) => a.updateId - b.updateId);
    // Controls and direct replies remain usable while earlier ordinary messages are queued.
    for (const item of [...inbox.filter(row => row.callbackId || row.replyTo || /^\/(?:status|help|start|pause|cancel|detach)$/.test(row.text.trim())), ...inbox.filter(row => !row.callbackId && !row.replyTo && !/^\/(?:status|help|start|pause|cancel|detach)$/.test(row.text.trim()))]) {
      if (this.abort.signal.aborted) break;
      try {
        if (!await this.processMessage(attachment, item)) {
          if (!item.acknowledged) {
            this.queueText(attachment, 'queued:' + item.id, identityAlive(runtimeInfo()?.identity) ? /^\/goal\s+/.test(item.text) ? 'Replacing the current goal. Stopping its run before starting the new objective.' : 'Your message is queued while bzzy finishes the current work. You can send /status or /pause.' : 'Your message is saved. Start bzzy or its local service on the same machine to continue.');
            putRecord('telegram-inbox', item.id, { ...getRecord('telegram-inbox', item.id), acknowledged: true });
          }
          continue;
        }
        if (getRecord('telegram-inbox', item.id)?.state === 'queued') putRecord('telegram-inbox', item.id, { ...item, state: 'handled' });
      } catch (error) {
        if (error.code === 'CONFLICT') continue;
        this.queueText(attachment, item.id + ':error', error.message); putRecord('telegram-inbox', item.id, { ...item, state: 'failed', error: error.message });
      }
    }
    await this.deliver(attachment);
  }
  close() { this.abort.abort(); }
}

export async function serveTelegramBridge() {
  privateDir(path.join(home(), 'runtime'));
  let unlock;
  try { unlock = lockFile(path.join(home(), 'runtime', 'telegram.lock')); } catch (error) { if (error.code === 'BZZY_LOCKED') return 0; throw error; }
  const bridge = new TelegramBridge(), identity = processIdentity(); let ticking = false;
  writeJson(relayFile(), { identity, startedAt: now() });
  for (const record of listRecords('telegram-delivery').filter(item => item.state === 'sending')) putRecord('telegram-delivery', record.id, { ...record, state: 'uncertain', error: 'Relay restarted during delivery; automatic retry could duplicate the message.' });
  const stop = () => bridge.close(); process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const timer = setInterval(async () => {
    if (ticking || bridge.abort.signal.aborted) return;
    if (!bridge.binding()) { bridge.close(); return; }
    ticking = true;
    try { await bridge.tick(); } catch (error) { const attachment = bridge.binding(); if (attachment) updateTelegramAttachment(attachment.id, { lastError: error.message }); }
    finally { ticking = false; }
  }, 300);
  try {
    while (!bridge.abort.signal.aborted && bridge.binding()) {
      try { await bridge.pollOnce(); }
      catch (error) {
        if (bridge.abort.signal.aborted) break;
        const attachment = bridge.binding(); if (attachment) updateTelegramAttachment(attachment.id, { status: 'reconnecting', lastError: error.message });
        await backoff(2000, undefined, { signal: bridge.abort.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
      }
    }
  } finally {
    clearInterval(timer); bridge.close(); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (telegramBridgeInfo()?.identity?.pid === identity.pid) fs.rmSync(relayFile(), { force: true }); unlock();
  }
  return 0;
}
export async function ensureTelegramBridge() {
  if (!telegramAttachment()) return;
  const previous = telegramBridgeInfo(); if (previous && identityAlive(previous.identity)) return previous;
  privateDir(path.join(home(), 'runtime'));
  const log = fs.openSync(path.join(home(), 'runtime', 'telegram.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(root, 'bin/bzzy.js'), 'internal-telegram'], { detached: true, env: runtimeEnv(), stdio: ['ignore', log, log] });
  fs.closeSync(log); child.unref();
  for (let i = 0; i < 80; i++) { const info = telegramBridgeInfo(); if (info && identityAlive(info.identity)) return info; await delay(25); }
  throw new Error('Telegram chat relay could not start. Inspect ~/.bzzy/runtime/telegram.log.');
}
export async function stopTelegramBridge() {
  const info = telegramBridgeInfo();
  if (info && identityAlive(info.identity)) { process.kill(info.identity.pid, 'SIGTERM'); for (let i = 0; i < 80 && identityAlive(info.identity); i++) await delay(25); }
}
