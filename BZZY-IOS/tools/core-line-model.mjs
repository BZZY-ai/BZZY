#!/usr/bin/env node
// Offline Codex-protocol fixture. This never opens account files or a network.
import readline from 'node:readline';

const body = '<message version="1"><h2>Line check</h2><p><b>Offline result</b> <span color="mint">ready</span></p><ul><li>One shared execution</li></ul></message>';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params: { threadId: 'line-thread', ...params } });
function currentFixtureRequest(params) {
  const text = Array.isArray(params?.input) ? params.input.filter(item => item?.type === 'text' && typeof item.text === 'string')
    .map(item => item.text).join('\n') : typeof params?.prompt === 'string' ? params.prompt : '';
  // Core can supply historical knowledge or a provider handoff in the same
  // text input. Old fixture markers are data, not the current test instruction.
  const boundaries = ['\n\nCURRENT REQUEST:\n', '\n\nCURRENT USER MESSAGE:\n'];
  const boundary = boundaries.map(value => ({ value, index: text.lastIndexOf(value) }))
    .sort((a, b) => b.index - a.index)[0];
  return (boundary.index < 0 ? text : text.slice(boundary.index + boundary.value.length)).trim();
}
const overrides = new Map();
for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === '-c') {
  const value = process.argv[++i], equal = value.indexOf('=');
  overrides.set(value.slice(0, equal), value.slice(equal + 1));
}
const isolatedProfile = 'bzzy_agent_isolated_v1';
const isolated = overrides.get('default_permissions') === JSON.stringify(isolatedProfile);
const profile = overrides.get(`permissions.${isolatedProfile}`) || '';
const correctlyIsolated = isolated && /":root" = "deny"/.test(profile) && /":tmpdir" = "deny"/.test(profile)
  && /":slash_tmp" = "deny"/.test(profile) && /"enabled" = false/.test(profile)
  && overrides.get('features.shell_tool') === 'false' && overrides.get('mcp_servers') === '{}'
  && overrides.get('shell_environment_policy.inherit') === '"none"' && overrides.get('web_search') === '"disabled"';
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (offline line fixture)'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { console.error('Logged in using ChatGPT (offline fixture)'); process.exit(0); }
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === 900 && !request.method) {
    notify('item/agentMessage/delta', { itemId: 'approval-message', delta: 'Permission decision received; no command was executed.' });
    notify('turn/completed', { turn: { id: 'line-turn', status: 'completed' } });
    continue;
  }
  let result = {};
  if (request.method === 'initialize') result = { userAgent: 'bzzy-line-fixture' };
  if (request.method === 'permissionProfile/list') result = { data: [{ id: isolatedProfile, allowed: correctlyIsolated }] };
  if (['thread/start', 'thread/resume'].includes(request.method)) {
    if (isolated && (!correctlyIsolated || request.params.permissions !== isolatedProfile || request.params.approvalPolicy !== 'never')) {
      send({ id: request.id, error: { code: -32602, message: 'The offline fixture requires the exact restricted profile.' } }); continue;
    }
    result = { thread: { id: 'line-thread' }, ...(isolated ? { activePermissionProfile: { id: isolatedProfile, extends: null } } : {}) };
  }
  if (request.method === 'turn/start') {
    result = { turn: { id: 'line-turn' } };
    const currentRequest = currentFixtureRequest(request.params);
    const hold = currentRequest === 'HOLD_LINE_INTEGRATION';
    const approval = currentRequest === 'APPROVAL_LINE_INTEGRATION';
    setTimeout(() => {
      notify('turn/started', { turn: { id: 'line-turn' } });
      if (hold) return;
      if (approval) {
        send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'line-thread', command: 'touch fixture-only' } });
        return;
      }
      notify('item/agentMessage/delta', { itemId: 'line-message', delta: body });
      notify('turn/completed', { turn: { id: 'line-turn', status: 'completed' } });
    }, 20);
  }
  if (request.method === 'turn/interrupt') notify('turn/completed', { turn: { id: 'line-turn', status: 'interrupted' } });
  if (request.id != null) send({ id: request.id, result });
}
