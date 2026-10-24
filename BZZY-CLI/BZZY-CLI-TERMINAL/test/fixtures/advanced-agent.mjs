#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const claude = !process.argv.includes('app-server');
if (process.argv.includes('--version')) { console.log('codex-cli 0.162.0 (fixture)'); process.exit(0); }
if (process.argv.includes('login') && process.argv.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
if (process.argv.includes('auth') && process.argv.includes('status')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); }
const send = value => console.log(JSON.stringify(value));
const log = value => { if (process.env.BZZY_TEST_LOG) { try { fs.appendFileSync(process.env.BZZY_TEST_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\n'); } catch { /* Read-only workers cannot write the parent's diagnostic log. */ } } };
log({ started: true, claude, args: process.argv.slice(2) });
let tools = [], context = {}, goal, thread = `thread-${process.pid}`, seq = 900, pending = new Map(), currentPrompt = '';
const notify = (method, params) => send({ method, params: { threadId: thread, ...params } });
async function call(name, input = {}) {
  if (claude) {
    const i = process.argv.indexOf('--mcp-config'), server = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8')).mcpServers.bzzy_goal;
    const request = { jsonrpc: '2.0', id: 1, method: name === '_list' ? 'tools/list' : 'tools/call', params: { name, arguments: input } };
    const result = spawnSync(server.command, server.args, { input: JSON.stringify(request) + '\n', encoding: 'utf8', env: { ...process.env, ...server.env } });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const response = JSON.parse(result.stdout.trim());
    if (response.result.isError) throw new Error(response.result.content[0].text);
    if (name === '_list') return response.result.tools;
    const text = response.result.content[0].text; try { return JSON.parse(text); } catch { return text; }
  }
  const id = ++seq; send({ id, method: 'item/tool/call', params: { threadId: thread, turnId: 'turn', callId: String(id), tool: name, arguments: input } });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function work() {
  if (process.env.BZZY_TEST_ADVANCED === 'delegation-ctf') {
    const { runDelegationCTF } = await import('./delegation-ctf.mjs');
    const result = await runDelegationCTF({ call, context, has: name => tools.some(tool => tool.name === name) });
    if (claude) {
      send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: result.text } } });
      send({ type: 'result', subtype: 'success', result: result.text, usage: { input_tokens: 12, output_tokens: 8 } });
    } else {
      notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: result.tokens } } });
      notify('item/agentMessage/delta', { itemId: 'answer', delta: result.text });
      if (goal) { goal.status = 'complete'; goal.tokensUsed = result.tokens; notify('thread/goal/updated', { goal }); }
      notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    }
    return;
  }
  if (process.env.BZZY_TEST_ADVANCED === 'conversation') {
    const directory = claude ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `fixture-chat-${thread}.json`);
    const history = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    history.push(currentPrompt); fs.writeFileSync(file, JSON.stringify(history));
    const marker = [...history.join('\n').matchAll(/Remember this chat marker: ([a-z0-9-]+)/g)].at(-1)?.[1];
    const reply = `The chat marker is ${marker || 'unknown'}.\n`;
    log({ prompt: currentPrompt, reply, threadId: thread });
    if (claude) {
      send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 0.35, resetsAt: Math.floor(Date.now() / 1000) + 86400 } });
      send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: reply } } });
      send({ type: 'result', subtype: 'success', session_id: thread, result: reply, usage: { input_tokens: 12, output_tokens: 8 } });
    } else {
      notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 42 * history.length } } });
      notify('item/agentMessage/delta', { itemId: 'answer', delta: reply });
      if (goal) { goal.status = 'complete'; goal.tokensUsed = 42; notify('thread/goal/updated', { goal }); }
      notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    }
    return;
  }
  if (process.env.BZZY_TEST_ADVANCED === 'wait') { await new Promise(resolve => setTimeout(resolve, 300)); }
  if (process.env.BZZY_TEST_ADVANCED === 'slow') { await new Promise(resolve => setTimeout(resolve, 1800)); }
  if (process.env.BZZY_TEST_ADVANCED === 'question') {
    if (claude) throw new Error('Question fixture uses Codex.');
    const id = ++seq; send({ id, method: 'item/tool/requestUserInput', params: { threadId: thread, questions: [{ id: 'environment', question: 'Which approved account?', options: [] }] } });
    const answer = await new Promise((resolve, reject) => pending.set(id, { resolve, reject, raw: true }));
    log({ answered: answer });
  }
  const has = name => tools.some(t => t.name === name);
  const bestiesFixture = ['besties', 'besties-disputed'].includes(process.env.BZZY_TEST_ADVANCED);
  if (has('activity')) await call('activity', { summary: 'Inspecting ownership controls at /users/getProfile', details: 'The user_id parameter is present. Ownership behavior remains unverified; compare approved controls.', observation: 'Parameter is present', inference: 'Potential ownership issue', nextCheck: 'Verify approved account controls' });
  if (bestiesFixture && has('peer_message')) {
    const collaboration = context.collaboration || {}, ownClaim = collaboration.latestClaims?.find(item => item.from === collaboration.self);
    if (!ownClaim) {
      const evidence = await call('record_evidence', { path: 'source.txt', label: 'bestie-control-evidence' });
      await call('peer_message', { requestId: `fixture-proof-${collaboration.groupId || 'group'}`, text: 'I inspected the supplied challenge independently. Please verify this current evidence and its control assumptions.', evidence: [evidence.id] });
    }
    let incoming = collaboration.latestClaims?.find(item => item.from !== collaboration.self && item.to === collaboration.self);
    for (let attempt = 0; attempt < 200 && !incoming; attempt++) {
      const inbox = await call('peer_inbox', { limit: 20 });
      incoming = inbox.items.find(item => item.evidence?.length);
      if (!incoming) await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (!incoming) throw new Error('Paired evidence did not arrive.');
    for (const id of incoming.evidence) await call('read_artifact', { id });
    await call('peer_review', { messageId: incoming.id, assessment: process.env.BZZY_TEST_ADVANCED === 'besties-disputed' ? 'disputed' : 'supported',
      rationale: process.env.BZZY_TEST_ADVANCED === 'besties-disputed' ? 'The supplied control does not establish the claimed conclusion.' : 'I opened the current artifact and independently checked the supplied control evidence.', evidence: incoming.evidence });
  } else if (has('delegate') && context.role !== 'chat' && !(process.env.BZZY_TEST_ADVANCED === 'delegation-recovery' && !context.previousAcceptance?.delegation)) {
    const job = await call('delegate', { requestId: 'bounded-worker', objective: 'Create result.txt from supplied evidence', context: 'Use source.txt. Return evidence and preserve the full task boundary.', acceptanceCriteria: ['result.txt exists and contains the inspected evidence'] });
    let status;
    do { await call('wait_assignment', { id: job.id, timeoutSeconds: 1 }); status = await call('assignment_status', { id: job.id }); } while (['starting', 'running'].includes(status.round.state));
    if (status.round.state !== 'awaiting_review') throw new Error(JSON.stringify(status.round));
    const evidence = status.round.artifacts.find(a => a.label === 'worker-evidence');
    if (!evidence) throw new Error('Worker evidence missing');
    await call('read_artifact', { id: evidence.id });
    await call('review_assignment', { id: job.id, outcome: 'accepted', rationale: 'Inspected recorded evidence and verified the requested output.', evidence: [evidence.id] });
    await call('apply_assignment', { id: job.id });
  } else if (process.env.BZZY_TEST_ADVANCED === 'debate-no-evidence' && has('finish_assignment') && !has('peer_status')) {
    await call('finish_assignment', { status: 'inconclusive', verdict: 'inconclusive', summary: 'The supplied material could not be validated with the available evidence.', evidence: [],
      objections: [], conclusions: [], position: 'Inconclusive' });
  } else if (has('finish_assignment') && !has('peer_status')) {
    const reviewer = !has('issue');
    if (!reviewer) fs.writeFileSync('result.txt', 'Implemented from ' + fs.readFileSync('source.txt', 'utf8'));
    const evidence = await call('record_evidence', { path: reviewer ? 'BZZY_SELECTED_MATERIAL.txt' : 'result.txt', label: 'worker-evidence' });
    const main = context.contract?.context?.includes('main agent responding');
    const agreement = process.env.BZZY_TEST_ADVANCED === 'debate-agreement';
    let ledger = [];
    if (main) {
      await call('read_artifact', { id: evidence.id });
      try {
        const followup = JSON.parse(currentPrompt.split('FOLLOW-UP:\n').at(-1));
        const match = /PERSISTENT OBJECTION LEDGER(?: \([^\n]*\))?:\n([\s\S]*)$/.exec(followup.feedback || context.contract.context);
        if (match) ledger = JSON.parse(match[1]);
      } catch { /* The opening case has no challenge dispositions. */ }
    }
    const original = context.mission?.goal?.objective || context.contract.objective;
    const goalAssessment = { objective: original, rationale: agreement ? 'The inspected synthetic evidence supports the declared fixture goal.' : 'The independent account-control prerequisite remains unverified.', evidence: [evidence.id],
      criteria: (context.mission?.acceptanceCriteria || []).map(item => ({ id: item.id, status: agreement ? 'supported' : 'inconclusive', rationale: 'The synthetic recorded comparison was inspected.', evidence: [evidence.id] })) };
    await call('finish_assignment', { status: agreement ? 'complete' : reviewer ? 'inconclusive' : 'complete', summary: reviewer ? 'The claim needs an account-control test.' : 'Created and inspected the requested output.', evidence: [evidence.id],
      ...(context.contract?.context?.includes('Independently investigate') ? { verdict: agreement ? 'real' : 'inconclusive' } : {}),
      objections: agreement ? [] : [{ id: 'missing-control', claim: 'An independent account control is not present.', evidence: [evidence.id] }], conclusions: agreement ? ['The supplied conclusion is supported.'] : [], position: agreement ? 'Supported' : 'Requires additional verification',
      ...(main ? { decision: agreement
        ? { acceptedConclusions: ['The supplied conclusion is supported.'], rejectedClaims: [], corrections: [], remainingObjections: [], nextVerificationSteps: [], objectionDispositions: [], goalSatisfaction: 'supported', goalAssessment }
        : { acceptedConclusions: [], rejectedClaims: ['The evidence conclusively establishes IDOR'], corrections: ['Classify the result as unverified'], remainingObjections: ['missing-control'], nextVerificationSteps: ['Run a separately authorized account-control test'],
          objectionDispositions: (ledger.length ? ledger : [{ id: 'missing-control' }]).map(item => ({ id: item.id, status: 'unresolved', rationale: 'The required independent account control is still absent.', evidence: [evidence.id] })), goalSatisfaction: 'inconclusive', goalAssessment } } : {}) });
  } else if (has('peer_status')) {
    const peers = await call('peer_status'); log({ peers: peers.length, objective: context.contract?.objective });
    const evidence = await call('record_evidence', { path: 'source.txt', label: 'peer-evidence' });
    await call('issue', { title: 'Ownership hypothesis', status: 'inconclusive', evidence: [evidence.id] });
    await call('remember', { kind: 'observation', statement: 'The supplied file was inspected.', evidence: [evidence.id], inputs: ['source.txt'] });
  }
  if (process.env.BZZY_TEST_ADVANCED === 'observation-cleanup' && has('assess_requirement')) {
    const file = '.fixture-observation.txt';
    fs.writeFileSync(file, 'Birth date: 1971-06-28\nAs-of date: 2026-10-21\nCalculated age: 55\n');
    const evidence = await call('record_evidence', { path: file, label: 'Recorded age calculation' });
    await call('assess_requirement', { id: 'objective', status: 'supported', rationale: 'Verified the calculation recorded in the saved evidence.', evidence: [evidence.id] });
    fs.rmSync(file);
  }
  if (has('checkpoint')) await call('checkpoint', { completedWork: ['Inspected the supplied material'], pendingActions: [], unresolvedQuestions: ['Live ownership behavior needs separate evidence'] });
  if (claude) {
    if (has('update_goal')) await call('update_goal', { status: 'complete', evidence: ['Inspected source.txt and recorded the bounded outcome.'] });
    send({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Fixture work and evidence recorded.\n' } } });
    send({ type: 'result', subtype: 'success', result: 'Recorded work.', usage: { input_tokens: 12, output_tokens: 8 } });
  } else {
    notify('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 42 } } });
    notify('item/agentMessage/delta', { itemId: 'answer', delta: 'Fixture work and evidence recorded.\n' });
    if (goal) { goal.status = 'complete'; goal.tokensUsed = 42; notify('thread/goal/updated', { goal }); }
    notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  }
}
async function launchWork() {
  try { if (!claude) notify('turn/started', { turn: { id: 'turn' } }); await work(); }
  catch (error) {
    if (claude) send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: error.message });
    else notify('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: error.message } } });
  }
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (pending.has(request.id) && !request.method) {
    const operation = pending.get(request.id); pending.delete(request.id);
    if (request.error) operation.reject(new Error(request.error.message));
    else if (operation.raw) operation.resolve(request.result);
    else if (request.result.success === false) operation.reject(new Error(request.result.contentItems[0].text));
    else { const text = request.result.contentItems[0].text; try { operation.resolve(JSON.parse(text)); } catch { operation.resolve(text); } }
    return;
  }
  if (claude) {
    if (request.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { models: [
      { value: 'default', displayName: 'Default' }, { value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['medium', 'high'] }, { value: 'sonnet', displayName: 'Sonnet' },
    ] } } });
    else if (request.type === 'user') {
      currentPrompt = request.message.content;
      if (process.env.BZZY_TEST_ADVANCED === 'conversation') thread = request.session_id;
      const index = process.argv.indexOf('--append-system-prompt'), text = process.argv[index + 1];
      context = JSON.parse(text.split('DURABLE TASK CONTEXT:\n')[1]); tools = await call('_list');
      send({ type: 'system', subtype: 'init', session_id: request.session_id }); launchWork();
    }
    return;
  }
  let result = {};
  if (request.method === 'account/rateLimits/read') result = { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } };
  else if (request.method === 'model/list') result = { data: [
    { id: 'fixture-brain', model: 'fixture-brain', displayName: 'Brain model', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) },
    { id: 'fixture-light', model: 'fixture-light', displayName: 'Light model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
  ], nextCursor: null };
  else if (request.method === 'thread/start' || request.method === 'thread/resume') {
    if (request.method === 'thread/resume') thread = request.params.threadId;
    log({ threadMethod: request.method, threadId: thread, model: request.params.model, config: request.params.config });
    context = JSON.parse(request.params.developerInstructions.split('DURABLE TASK CONTEXT:\n')[1]);
    const toolFile = path.join(process.env.CODEX_HOME, `fixture-tools-${thread}.json`);
    tools = request.params.dynamicTools || (fs.existsSync(toolFile) ? JSON.parse(fs.readFileSync(toolFile, 'utf8')) : []);
    if (request.params.dynamicTools) fs.writeFileSync(toolFile, JSON.stringify(tools));
    if (!tools.length && context.role === 'reviewer') tools = ['get_task_state', 'record_evidence', 'finish_assignment', 'checkpoint'].map(name => ({ name }));
    result = { thread: { id: thread } };
  } else if (request.method === 'thread/goal/get') result = { goal: goal || { status: 'paused' } };
  else if (request.method === 'thread/goal/clear') goal = null;
  else if (request.method === 'thread/goal/set') {
    log({ goalMethod: request.method, objective: request.params.objective, tokenBudget: request.params.tokenBudget });
    goal = { goalId: 'goal', status: request.params.status, tokensUsed: 0 }; result = { goal };
    if (request.params.objective) {
      currentPrompt = request.params.objective;
      const objectiveFile = /^Read the complete goal objective at (.+) before continuing\./.exec(currentPrompt);
      if (objectiveFile) currentPrompt = fs.readFileSync(objectiveFile[1], 'utf8');
    }
    if (goal.status === 'active') setTimeout(launchWork, 5);
  }
  else if (request.method === 'turn/start') { currentPrompt = request.params.input.map(item => item.text || '').join('\n'); setTimeout(launchWork, 5); }
  else if (request.method === 'turn/interrupt') notify('turn/completed', { turn: { id: 'turn', status: 'interrupted' } });
  if (request.id != null) send({ id: request.id, result });
});
