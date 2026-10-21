import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { root } from '../src/process.js';
import { saveConfig, BUILTINS } from '../src/providers.js';
import { createSession, saveSession } from '../src/store.js';
import { RunnerUI } from '../src/runtime-ui.js';
import { events } from '../src/database.js';
import { codexQuota, claudeQuota, deepseekBalance, accountStatusLabels, AccountStatusMonitor, readCodexQuota, readClaudeQuota, readDeepseekBalance, recordClaudeQuota } from '../src/account-status.js';

let directory, saved;
test.beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-quotas-'));
  saved = Object.fromEntries(['BZZY_HOME', 'BZZY_CODEX_HOME', 'BZZY_CLAUDE_HOME', 'BZZY_CODEX_BIN', 'BZZY_TEST_LOG', 'DEEPSEEK_API_KEY'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CODEX_HOME: path.join(directory, 'codex'), BZZY_CLAUDE_HOME: path.join(directory, 'claude'), BZZY_CODEX_BIN: path.join(root, 'test/fixtures/advanced-agent.mjs'), BZZY_TEST_LOG: path.join(directory, 'backend.jsonl') });
  delete process.env.DEEPSEEK_API_KEY;
});
test.afterEach(() => { for (const [key, value] of Object.entries(saved)) if (value == null) delete process.env[key]; else process.env[key] = value; fs.rmSync(directory, { recursive: true, force: true }); });

test('weekly quota selection distinguishes the weekly pool, short windows, missing values and per-model limits', () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const result = codexQuota({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 98, windowDurationMins: 300 }, secondary: { usedPercent: 27.5, windowDurationMins: 10080, resetsAt: future } } }, rateLimits: { secondary: { usedPercent: 50, windowDurationMins: 10080 } } });
  assert.equal(result.weekly.remainingPercent, 72.5); assert.equal(result.weekly.resetsAt, future * 1000);
  assert.equal(codexQuota({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } } }), null);
  assert.equal(codexQuota({ rateLimits: { secondary: { usedPercent: null, windowDurationMins: 10080 } } }), null);
  assert.equal(claudeQuota({ rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.2 } }), null);
  assert.equal(claudeQuota({ rate_limit_info: { rateLimitType: 'seven_day_opus', utilization: 0.2 } }), null);
  assert.equal(claudeQuota({ rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.2, resetsAt: future } }).weekly.remainingPercent, 80);
  assert.equal(claudeQuota({ rate_limits: { seven_day: { used_percentage: 100, resets_at: future } } }).weekly.remainingPercent, 0);
});
test('balance formatting preserves zero, small credits and actual currencies while stale and expired quotas are marked', () => {
  const record = deepseekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '100' }, { currency: 'USD', total_balance: '0.0042' }] });
  assert.equal(record.balance.currency, 'USD'); assert.equal(accountStatusLabels({ deepseek: record })[2].value, '$0.0042');
  assert.equal(deepseekBalance({ balance_infos: [{ currency: 'USD', total_balance: 'NaN' }] }), null);
  const zero = deepseekBalance({ balance_infos: [{ currency: 'USD', total_balance: '0.00' }] });
  assert.equal(accountStatusLabels({ deepseek: zero })[2].value, '$0.00');
  const cny = deepseekBalance({ balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] });
  assert.equal(accountStatusLabels({ deepseek: cny })[2].value, '¥12.50');
  const instant = Date.now(), stale = claudeQuota({ rate_limits: { seven_day: { used_percentage: 40 } } }, instant - 600000);
  assert.equal(accountStatusLabels({ claude: stale }, instant)[1].value, '~60% left');
  stale.weekly.resetsAt = instant - 1;
  assert.equal(accountStatusLabels({ claude: stale }, instant)[1].value, '—');
  assert.equal(accountStatusLabels()[0].value, '—');
});
test('Codex quota polling initializes the native backend and never starts a thread or runs inference', async () => {
  const result = await readCodexQuota({ cwd: directory }); assert.equal(result.weekly.remainingPercent, 75);
  const log = fs.readFileSync(path.join(directory, 'backend.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.length); assert.ok(log.every(entry => !entry.threadMethod && !entry.prompt));
});
test('Claude usage uses the newest native report or cache and never reads account credentials', async () => {
  const session = createSession(BUILTINS.claude, directory), dir = path.join(directory, 'claude');
  session.backendHomes = { claudeConfigDir: dir }; saveSession(session); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), 'not JSON and must never be parsed');
  assert.equal((await readClaudeQuota(session)).status, 'unavailable');
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.now() - 600000, utilization: { limits: [{ kind: 'weekly_scoped', percent: 99 }, { kind: 'weekly_all', percent: 30, resets_at: new Date(Date.now() + 86400000).toISOString() }] } } }));
  assert.equal((await readClaudeQuota(session)).weekly.remainingPercent, 70);
  const ui = new RunnerUI(session.id);
  recordClaudeQuota(session, { rate_limit_info: { rateLimitType: 'seven_day', utilization: 0.4 } }, ui);
  assert.equal((await readClaudeQuota(session)).weekly.remainingPercent, 60);
  assert.ok(events(session.id).some(event => event.type === 'account.quota' && event.data.weekly.remainingPercent === 60));
  assert.equal(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'), 'not JSON and must never be parsed'); ui.close();
});
test('DeepSeek reads the authenticated balance endpoint without following redirects or disclosing provider errors', async () => {
  let requests = [], mode = 'balance';
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (mode === 'redirect') { response.writeHead(302, { Location: '/leak' }); response.end(); return; }
    if (mode === 'invalid') { response.writeHead(401); response.end('PRIVATE-ERROR-AND-TOKEN'); return; }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  saveConfig({ providers: { deepseek: { ...BUILTINS.deepseek, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } });
  try {
    assert.equal((await readDeepseekBalance()).status, 'unavailable'); assert.equal(requests.length, 0);
    process.env.DEEPSEEK_API_KEY = 'fixture-only-key';
    const result = await readDeepseekBalance(); assert.equal(result.balance.amount, 12.34);
    assert.deepEqual(requests, [{ url: '/user/balance', authorization: 'Bearer fixture-only-key' }]);
    mode = 'redirect'; await assert.rejects(readDeepseekBalance()); assert.equal(requests.length, 2);
    mode = 'invalid'; assert.doesNotMatch(JSON.stringify(await readDeepseekBalance()), /PRIVATE-ERROR|fixture-only-key/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('account refreshes do not overlap or erase live reports and cancel cleanly', async () => {
  let release, calls = 0, signal;
  const monitor = new AccountStatusMonitor(() => {}, { intervalMs: 10000, readers: { codex: async (_session, abort) => { signal = abort; calls++; await new Promise(resolve => { release = resolve; }); return codexQuota({ rateLimits: { secondary: { usedPercent: 10, windowDurationMins: 10080 } } }, 100); } } });
  monitor.update({}); await Promise.resolve();
  try {
    await monitor.refresh(); assert.equal(calls, 1);
    monitor.accept(codexQuota({ rateLimits: { secondary: { usedPercent: 50, windowDurationMins: 10080 } } }, 200));
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(monitor.snapshot.codex.weekly.remainingPercent, 50);
  } finally { monitor.close(); }
  assert.equal(signal.aborted, true);
});
