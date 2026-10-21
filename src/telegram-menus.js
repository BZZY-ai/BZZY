import { getRecord, putRecord, digest } from './database.js';
import { loadSession } from './store.js';
import { providers, getProvider, apiKey, setDefault, saveDefaultSelection } from './providers.js';
import { availableModels, normalizeModel } from './models.js';
import { changeSessionSelection, changeSessionProvider } from './runtime-client.js';
import { ensureRuntime, effectiveInputOwner, claimInput, releaseInput } from './runtime.js';
import { requireTelegramAttachment } from './telegram-state.js';

export const telegramBotCommands = [
  ['providers', 'Choose Codex, Claude or DeepSeek'], ['models', 'Choose a model and effort'], ['effort', 'Change reasoning effort'],
  ['default', 'Use this provider, model and effort for new chats'],
  ['goal', 'Start a persistent goal'], ['status', 'Show this conversation’s status'], ['pause', 'Pause the current work'],
  ['resume', 'Resume the unfinished goal'], ['cancel', 'Cancel the current work'], ['detach', 'Stop mirroring this chat'], ['help', 'Show chat controls'],
].map(([command, description]) => ({ command, description }));

function buttons(attachment, source, choices) {
  return choices.map((choice, index) => {
    const id = digest([attachment.id, source, index]).slice(0, 32);
    putRecord('telegram-action', id, { attachmentId: attachment.id, action: choice.action, label: choice.label, expiresAt: Date.now() + 1800000 });
    return [{ text: choice.label.slice(0, 64), callback_data: 'bzzy:' + id }];
  });
}
function configured(provider) {
  if (provider.auth !== 'api-key') return true;
  try { apiKey(provider); return true; } catch { return false; }
}
export class TelegramMenus {
  constructor(bridge) { this.bridge = bridge; }
  show(attachment, source, text, choices) {
    this.bridge.queueText(attachment, source, text, { reply_markup: { inline_keyboard: buttons(attachment, source, choices) } });
  }
  async providers(attachment, source) {
    const session = loadSession(attachment.sessionId);
    this.show(attachment, source, 'Choose a provider. Your conversation will carry over.', Object.values(providers()).map(provider => ({
      label: `${provider.id === session.provider ? '✓ ' : ''}${provider.id}${configured(provider) ? '' : ' · key needed in terminal'}`, action: { kind: 'provider', provider: provider.id },
    })));
  }
  async models(attachment, source, providerId, page = 0) {
    const session = loadSession(attachment.sessionId), provider = getProvider(providerId || session.provider);
    if (!configured(provider)) throw new Error(`Configure the ${provider.id} API key in the bzzy terminal first; keys are never requested in Telegram chat.`);
    const catalog = await availableModels({ ...session, provider: provider.id, backend: provider.backend, model: provider.id === session.provider ? session.model : provider.model, engineHome: provider.id === session.provider ? session.engineHome : null });
    requireTelegramAttachment(attachment.id);
    const selected = catalog.models.slice(page * 8, page * 8 + 8);
    const choices = [{ label: 'Provider default', action: { kind: 'model', provider: provider.id, model: provider.model || null, capabilities: null } }, ...selected.map(model => ({
      label: `${provider.id === session.provider && model.id === session.model ? '✓ ' : ''}${model.name || model.id}`, action: { kind: 'model', provider: provider.id, model: model.id, capabilities: model.capabilities || null },
    }))];
    if (page > 0) choices.push({ label: '← Previous models', action: { kind: 'page', provider: provider.id, page: page - 1 } });
    if (catalog.models.length > (page + 1) * 8) choices.push({ label: 'More models →', action: { kind: 'page', provider: provider.id, page: page + 1 } });
    this.show(attachment, source, `Choose a ${provider.id} model${catalog.source === 'manual' ? '. The catalog is unavailable; you can also send /model MODEL_ID' : ''}.`, choices);
  }
  effort(attachment, source, selection) {
    const levels = selection.capabilities?.supportedEfforts || [];
    this.show(attachment, source, `${selection.provider} · ${selection.model || 'provider default'}\nChoose reasoning effort:`, ['default', ...levels].map(effort => ({
      label: (selection.effort === effort ? '✓ ' : '') + effort, action: { ...selection, kind: 'confirm', effort },
    })));
  }
  async apply(attachment, source, selection) {
    const info = await ensureRuntime(), lease = effectiveInputOwner(attachment.sessionId), owner = lease?.owner || 'telegram-' + attachment.id;
    if (!lease) claimInput(attachment.sessionId, owner);
    const connection = { info, owner, authorize: () => requireTelegramAttachment(attachment.id) }, ui = { event() {}, updateSession() {} };
    try {
      requireTelegramAttachment(attachment.id);
      const current = loadSession(attachment.sessionId), provider = getProvider(selection.provider || current.provider);
      const selected = { model: selection.model, capabilities: selection.capabilities, effort: selection.effort || 'default' };
      if (provider.id === current.provider) await changeSessionSelection(current.id, selected, ui, connection);
      else { await changeSessionProvider(current, provider, selected, ui, connection); setDefault(provider.id); }
      this.bridge.queueText(attachment, source, `${provider.id} · ${selected.model || 'provider default'} · effort ${selected.effort}\nConversation retained. This applies to the next message.`);
    } finally { if (!lease) releaseInput(attachment.sessionId, owner); }
  }
  async command(attachment, item) {
    const text = item.text.trim(), session = loadSession(attachment.sessionId);
    if (text === '/providers') { await this.providers(attachment, item.id); return true; }
    if (text === '/models' || text === '/model') { await this.models(attachment, item.id); return true; }
    if (text === '/effort') { this.effort(attachment, item.id, { provider: session.provider, model: session.model, capabilities: session.modelCapabilities, effort: session.selectedEffort || 'default' }); return true; }
    if (text === '/default') {
      const selected = saveDefaultSelection(session);
      this.bridge.queueText(attachment, item.id, `Default saved · ${selected.provider} · ${selected.model || 'provider default'} · effort ${selected.effort}.`);
      return true;
    }
    const model = /^\/models?\s+(.+)$/.exec(text);
    if (model) { await this.apply(attachment, item.id, { provider: session.provider, model: normalizeModel(getProvider(session.provider), model[1]), capabilities: null, effort: 'default' }); return true; }
    return false;
  }
  async callback(attachment, item) {
    const action = getRecord('telegram-action', item.callbackData?.replace(/^bzzy:/, ''));
    await this.bridge.api.call('answerCallbackQuery', { callback_query_id: item.callbackId });
    if (!action || action.attachmentId !== attachment.id || action.expiresAt < Date.now()) throw new Error('That menu expired. Open /providers or /models again.');
    requireTelegramAttachment(attachment.id);
    const choice = action.action;
    if (choice.kind === 'provider' || choice.kind === 'page') await this.models(attachment, item.id, choice.provider, choice.page || 0);
    else if (choice.kind === 'model') this.effort(attachment, item.id, choice);
    else if (choice.kind === 'confirm') await this.apply(attachment, item.id, choice);
  }
}
