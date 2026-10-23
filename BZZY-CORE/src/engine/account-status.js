import fs from 'node:fs';
import path from 'node:path';
import { Rpc } from './rpc.js';
import { launch } from './process.js';
import { subscriptionEnvironment, codexHome, claudeHome } from './auth.js';
import { apiKey, getProvider } from './providers.js';
import { digest, getRecord, putRecord } from './database.js';

const minute = 60000, maxAge = 5 * minute;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
const unavailable = (provider, reason) => ({ provider, status: 'unavailable', reason, checkedAt: Date.now() });
function weekly(provider, usedPercent, resetsAt, checkedAt, source) {
  if (!percent(usedPercent)) return null;
  const reset = timestamp(resetsAt);
  return { provider, status: 'available', weekly: { usedPercent, remainingPercent: 100 - usedPercent, resetsAt: Number.isFinite(reset) ? reset : null }, checkedAt, source };
}

export function codexQuota(data, checkedAt = Date.now()) {
  const limits = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
  const window = [limits?.primary, limits?.secondary].find(item => item?.windowDurationMins === 7 * 24 * 60);
  return window ? weekly('codex', window.usedPercent, window.resetsAt, checkedAt, 'native-backend') : null;
}
export function claudeQuota(data, checkedAt = Date.now(), source = 'native-backend') {
  const statusLine = data?.rate_limits?.seven_day;
  if (statusLine) return weekly('claude', statusLine.used_percentage, statusLine.resets_at, checkedAt, source);
  const event = data?.rate_limit_info;
  if (event?.rateLimitType === 'seven_day' && typeof event.utilization === 'number' && event.utilization >= 0 && event.utilization <= 1) {
    return weekly('claude', event.utilization * 100, event.resetsAt, checkedAt, source);
  }
  const cache = data?.cachedUsageUtilization;
  if (!cache || typeof cache.fetchedAtMs !== 'number' || !Number.isFinite(cache.fetchedAtMs)) return null;
  const value = cache.utilization;
  const window = value?.seven_day;
  if (window) return weekly('claude', window.utilization, window.resets_at, cache.fetchedAtMs, 'native-cache');
  const shared = value?.limits?.find(item => item.kind === 'weekly_all');
  return shared ? weekly('claude', shared.percent, shared.resets_at, cache.fetchedAtMs, 'native-cache') : null;
}
export function deepseekBalance(data, checkedAt = Date.now()) {
  const balances = (Array.isArray(data?.balance_infos) ? data.balance_infos : [])
    .filter(item => ['USD', 'CNY'].includes(item.currency) && typeof item.total_balance === 'string' && /^-?\d+(?:\.\d+)?$/.test(item.total_balance) && Number.isFinite(Number(item.total_balance)))
    .map(item => ({ currency: item.currency, amount: Number(item.total_balance) }));
  const balance = balances.find(item => item.currency === 'USD') || balances[0];
  return balance ? { provider: 'deepseek', status: 'available', balance, balances, sufficient: data.is_available === true, checkedAt, source: 'provider-api' } : null;
}
function claudeStore(session = {}) { return claudeHome(session.backendHomes); }
function claudeCacheKey(session) { return 'claude:' + digest(claudeStore(session)); }
export function recordClaudeQuota(session, event, ui) {
  const quota = claudeQuota(event);
  if (!quota) return;
  putRecord('account-status', claudeCacheKey(session), quota);
  ui.event('account.quota', quota);
}
export async function readCodexQuota(session = {}, signal) {
  const env = subscriptionEnvironment('codex');
  env.CODEX_HOME = session.provider === 'codex' && session.engineHome || session.backendHomes?.codex || codexHome();
  const rpc = new Rpc(launch('codex', ['app-server'], { cwd: session.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }), async () => { throw new Error('Quota lookup cannot run tools.'); });
  const abort = () => rpc.fail(new Error('Quota lookup cancelled.'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await rpc.request('initialize', { clientInfo: { name: 'bzzy-usage', version: '0.2.0' } }, 8000);
    rpc.notify('initialized');
    const quota = codexQuota(await rpc.request('account/rateLimits/read', {}, 8000));
    return quota || unavailable('codex', 'The backend did not report a weekly quota.');
  } finally { signal?.removeEventListener('abort', abort); await rpc.close(); }
}
export async function readClaudeQuota(session = {}) {
  const directory = claudeStore(session), candidates = [path.join(directory, '.claude.json'), directory + '.json'];
  const records = [getRecord('account-status', claudeCacheKey(session))].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
      const quota = claudeQuota(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (quota) records.push(quota);
    } catch { /* The native cache can be absent or in the middle of a write. */ }
  }
  return records.sort((a, b) => b.checkedAt - a.checkedAt)[0] || unavailable('claude', 'Waiting for Claude Code to report weekly usage. Opening /usage in official Claude Code can refresh its local cache.');
}
export async function readDeepseekBalance(_session, signal) {
  const provider = getProvider('deepseek');
  let key;
  try { key = apiKey(provider); } catch { return unavailable('deepseek', 'API key not configured.'); }
  const endpoint = new URL(provider.baseUrl); endpoint.pathname = endpoint.pathname.replace(/\/(?:v1)?\/?$/, '') + '/user/balance';
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) });
  if (!response.ok) { await response.body?.cancel(); return unavailable('deepseek', response.status === 401 || response.status === 403 ? 'Balance lookup needs a valid API key.' : 'Balance lookup is temporarily unavailable.'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 65536) throw new Error('Balance response too large.'); chunks.push(chunk); }
  return deepseekBalance(JSON.parse(Buffer.concat(chunks).toString('utf8'))) || unavailable('deepseek', 'The provider did not report an available balance.');
}

export class AccountStatusMonitor {
  constructor(onUpdate, { readers = { codex: readCodexQuota, claude: readClaudeQuota, deepseek: readDeepseekBalance }, intervalMs = minute } = {}) {
    this.onUpdate = onUpdate; this.readers = readers; this.intervalMs = intervalMs; this.snapshot = {}; this.inFlight = new Set(); this.attempts = {}; this.abort = new AbortController();
  }
  update(session) {
    this.session = session;
    if (!this.timer) { this.refresh(); this.timer = setInterval(() => this.refresh(), Math.min(this.intervalMs, 15000)); this.timer.unref(); }
  }
  accept(record) {
    if (record?.provider && record.checkedAt >= (this.snapshot[record.provider]?.checkedAt || 0)) {
      this.snapshot[record.provider] = record; this.onUpdate({ ...this.snapshot });
    }
  }
  async refresh() {
    if (this.abort.signal.aborted) return;
    await Promise.allSettled(Object.entries(this.readers).map(async ([provider, read]) => {
      const interval = provider === 'claude' ? Math.min(this.intervalMs, 15000) : this.intervalMs;
      if (this.inFlight.has(provider) || Date.now() - (this.attempts[provider] || 0) < interval) return;
      this.inFlight.add(provider); this.attempts[provider] = Date.now();
      try { const result = await read(this.session, this.abort.signal); if (!this.abort.signal.aborted) this.accept(result); }
      catch {
        if (!this.abort.signal.aborted) {
          const previous = this.snapshot[provider];
          this.accept(previous?.status === 'available' ? { ...previous, refreshFailed: true } : unavailable(provider, 'Usage lookup unavailable. Check the existing provider login or connection.'));
        }
      } finally { this.inFlight.delete(provider); }
    }));
    if (!this.abort.signal.aborted) this.onUpdate({ ...this.snapshot });
  }
  close() { clearInterval(this.timer); this.abort.abort(); }
}

export function accountStatusLabels(snapshot = {}, instant = Date.now()) {
  return ['codex', 'claude', 'deepseek'].map(provider => {
    const data = snapshot[provider], label = provider === 'deepseek' ? 'DeepSeek' : (provider === 'codex' ? 'Codex' : 'Claude') + ' 7d';
    const expired = data?.weekly?.resetsAt != null && data.weekly.resetsAt <= instant;
    const stale = data?.refreshFailed || instant - (data?.checkedAt || 0) > maxAge;
    let value = '—';
    if (data?.status === 'available' && !expired) {
      if (data.weekly) value = `${stale ? '~' : ''}${Math.floor(data.weekly.remainingPercent)}% left`;
      else if (data.balance) value = `${stale ? '~' : ''}${data.balance.currency === 'USD' ? '$' : '¥'}${data.balance.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(data.balance.amount) > 0 && Math.abs(data.balance.amount) < 0.0001 ? 8 : 4 })}`;
    }
    return { label, value, stale: Boolean(stale && data?.status === 'available'), reason: expired ? 'Quota reset passed; awaiting fresh provider data.' : data?.reason || '' };
  });
}

export function accountStatusDetails(snapshot) {
  return accountStatusLabels(snapshot).map(({ label, value, reason }, index) => {
    const record = snapshot?.[['codex', 'claude', 'deepseek'][index]];
    return `${label}: ${value}${record?.checkedAt ? ` · checked ${new Date(record.checkedAt).toLocaleString()}` : ''}${record?.source ? ` · ${record.source}` : ''}${reason ? '\n  ' + reason : ''}`;
  }).join('\n') + '\n~ marks cached data. — means the provider has not exposed a current value. No model requests are made to look up these values.';
}
