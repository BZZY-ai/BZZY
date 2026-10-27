import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ToolHost, taskTools, bridgeRequest } from '../src/engine/tools.js';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { events, putRecord } from '../src/engine/database.js';
import { setGmailSettings } from '../src/engine/gmail-account.js';
import { CoreAgents } from '../src/agents.js';
import { CoreWorkspaces } from '../src/workspaces.js';

const provider = { id: 'codex', backend: 'codex' };
const mailbox = 'backend-mailbox@example.invalid', alias = 'form+1@example.invalid';
const appPassword = 'fixtureonlymailpw', body = 'PRIVATE_MAIL_BODY verification 012345';
let directory, cwd, previousHome, previousPath, marker;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME; previousPath = process.env.PATH;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-gmail-tools-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const bin = path.join(directory, 'bin'); fs.mkdirSync(bin); marker = path.join(directory, 'dispatched');
  // Offline transport fixture: no mailbox connection, credential output or
  // filesystem credential fallback. Exercise the real ToolHost/Node bridge.
  const script = `#!${process.execPath}
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>raw+=s);process.stdin.on('end',()=>{
 const input=JSON.parse(raw); const fs= require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},input.operation);
 const headers={uid:'47',from:'sender@example.invalid',to:${JSON.stringify(alias)},subject:'Private verification',date:'2026-10-27',messageId:'fixture-id'};
 const base={folder:input.folder,uidValidity:'19',readOnly:true};
 const result=input.operation==='list'?{...base,messages:[headers]}:{...base,...headers,body:${JSON.stringify(body)},bodyTruncated:false,links:[{text:'Verify',url:'https://example.invalid/verify?token=PRIVATE_LINK_TOKEN'}],attachments:[]};
 setTimeout(()=>process.stdout.write(JSON.stringify({ok:true,result})),input.search==='delay'?300:0);
});
`;
  fs.writeFileSync(path.join(bin, 'python3'), script, { mode: 0o700 });
  process.env.PATH = bin + path.delimiter + previousPath;
});
test.afterEach(() => {
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  process.env.PATH = previousPath; fs.rmSync(directory, { recursive: true, force: true });
});
const configured = () => setGmailSettings({ address: mailbox, appPassword });
const host = (session, context = {}, output = []) => new ToolHost(session, { event(type, data) { output.push({ type, data }); } }, context);
async function dispatched() {
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(marker), 'fixture helper must start before authorization changes');
}

test('ordinary owner chats discover native Gmail independently of alias setup, with safe missing-account guidance', async () => {
  const session = createSession(provider, cwd), tools = taskTools(session, { goalMode: false });
  const tool = tools.find(tool => tool.name === 'gmail_read'); assert.ok(tool);
  assert.equal(tool.inputSchema.additionalProperties, false);
  for (const field of ['address', 'appPassword', 'host', 'path', 'recipientAliases']) assert.equal(tool.inputSchema.properties[field], undefined);
  await assert.rejects(host(session).call('gmail_read', { operation: 'list', last: 1 }), { code: 'GMAIL_NOT_CONFIGURED' });
  assert.equal(fs.existsSync(marker), false);
});

test('authenticated bridge lists and reads private mail while activity and diagnostic events contain no mail data', async () => {
  configured(); const session = createSession(provider, cwd), runId = randomUUID(), output = [];
  putRecord('run', session.id, { id: runId, state: 'running', goalMode: false });
  const tools = await host(session, { runId, goalMode: false }, output).open();
  try {
    const list = await bridgeRequest(tools.socket, tools.token, { method: 'call', name: 'gmail_read', arguments: { operation: 'list', last: 1, search: `to:${alias} newer_than:10m PRIVATE_QUERY` } });
    assert.equal(list.messages[0].to, alias); assert.equal(list.untrustedContent, true);
    const read = await bridgeRequest(tools.socket, tools.token, { method: 'call', name: 'gmail_read', arguments: { operation: 'read', uid: list.messages[0].uid, uidValidity: list.uidValidity, folder: list.folder } });
    assert.equal(read.body, body); assert.equal(read.readOnly, true); assert.equal(read.untrustedContent, true);
    await assert.rejects(tools.call('gmail_read', { operation: 'list', query: 'PRIVATE_INVALID_INPUT', appPassword: 'PRIVATE_INVALID_PASSWORD' }), { code: 'GMAIL_INVALID_REQUEST' });
    const recorded = JSON.stringify({ events: events(session.id, 0, 1000), output });
    for (const privateValue of [mailbox, alias, appPassword, body, 'PRIVATE_QUERY', 'PRIVATE_INVALID_INPUT', 'PRIVATE_INVALID_PASSWORD', 'PRIVATE_LINK_TOKEN', 'Private verification']) assert.ok(!recorded.includes(privateValue), privateValue);
    assert.ok(events(session.id, 0, 1000).some(event => event.type === 'diagnostic.tool' && event.data.mailbox?.count === 1));
    assert.ok(output.some(event => event.data.label === 'Read email' && event.data.detail === 'Read selected message'));
  } finally { await tools.close(); }
});

test('saved worker, reviewer, Agent and project identity cannot be disguised to inherit owner mailbox access', async () => {
  configured(); const parent = createSession(provider, cwd);
  for (const role of ['executor', 'reviewer', 'peer', undefined]) {
    const child = createSession(provider, cwd); child.parentSessionId = parent.id; if (role) child.role = role; saveSession(child);
    assert.ok(!taskTools(child).some(tool => tool.name === 'gmail_read'));
    await assert.rejects(host({ ...child, parentSessionId: undefined, role: undefined }).call('gmail_read', { operation: 'list' }));
  }
  const reviewer = createSession(provider, cwd); reviewer.role = 'reviewer'; saveSession(reviewer);
  assert.ok(!taskTools({ ...reviewer, role: undefined }).some(tool => tool.name === 'gmail_read'));
  assert.ok(!taskTools({ ...parent, projectRoot: path.join(directory, 'foreign') }).some(tool => tool.name === 'gmail_read'));
  new CoreWorkspaces().configure({ path: path.join(directory, 'managed'), create: true }, { expectedRevision: 0, requestId: randomUUID() });
  const agent = new CoreAgents().create({ name: 'Mailbox boundary fixture', instructions: 'Read authorized project data.', provider: 'codex', model: 'offline-fixture', effort: 'default' }, { requestId: randomUUID() });
  const agentSession = loadSession(agent.sessionId);
  assert.ok(!taskTools(agentSession).some(tool => tool.name === 'gmail_read'));
  await assert.rejects(host(agentSession).call('gmail_read', { operation: 'list' }), { code: 'FORBIDDEN' });
  assert.equal(fs.existsSync(marker), false);
});

test('changing saved owner identity during an in-flight fetch withholds its result', async () => {
  configured(); const session = createSession(provider, cwd), tools = host(session);
  const pending = tools.call('gmail_read', { operation: 'list', search: 'delay' });
  await dispatched(); session.role = 'reviewer'; saveSession(session);
  await assert.rejects(pending, { code: 'FORBIDDEN' }); await tools.close();
});

test('run stop signal cancels an in-flight mailbox request', async () => {
  configured(); const session = createSession(provider, cwd), abort = new AbortController(), tools = host(session, { signal: abort.signal });
  const pending = tools.call('gmail_read', { operation: 'list', search: 'delay' });
  await dispatched(); abort.abort();
  await assert.rejects(pending, { code: 'GMAIL_CANCELLED' }); await tools.close();
});

test('saved disabled-network policy cannot be widened by model metadata or changed during a fetch', async () => {
  configured(); const session = createSession(provider, cwd);
  session.policy = { network: 'disabled' }; saveSession(session);
  const forged = { ...session, policy: { network: 'enabled' } };
  assert.ok(!taskTools(forged).some(tool => tool.name === 'gmail_read'));
  await assert.rejects(host(forged).call('gmail_read', { operation: 'list' }), { code: 'FORBIDDEN' });
  assert.equal(fs.existsSync(marker), false);
  session.policy.network = 'enabled'; saveSession(session);
  const tools = host(session), pending = tools.call('gmail_read', { operation: 'list', search: 'delay' });
  await dispatched(); const current = loadSession(session.id); current.policy.network = 'disabled'; saveSession(current);
  await assert.rejects(pending, { code: 'FORBIDDEN' }); await tools.close();
});
