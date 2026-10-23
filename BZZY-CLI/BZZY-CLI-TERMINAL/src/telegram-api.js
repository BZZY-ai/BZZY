export class TelegramApi {
  constructor(token, { fetchImpl = fetch } = {}) { this.token = token; this.fetch = fetchImpl; }
  async call(method, body = {}, signal) {
    try {
      const response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 30000 : 10000)]) : AbortSignal.timeout(method === 'getUpdates' ? 30000 : 10000),
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) throw Object.assign(new Error(data.description || `Telegram HTTP ${response.status}`), { definite: true, retryAfter: data.parameters?.retry_after, status: response.status });
      return data.result;
    } catch (error) {
      throw Object.assign(new Error(String(error.message).replaceAll(this.token, '[redacted]')), { definite: error.definite === true, retryAfter: error.retryAfter, status: error.status });
    }
  }
  send(chatId, text, extra, signal) { return this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true }, ...extra }, signal); }
}
export function telegramTextParts(text, size = 3800) {
  const parts = []; let remaining = String(text);
  while (remaining.length) {
    let end = Math.min(size, remaining.length);
    if (end < remaining.length) {
      const newline = remaining.lastIndexOf('\n', end);
      if (newline > end / 2) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    }
    parts.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  return parts;
}
