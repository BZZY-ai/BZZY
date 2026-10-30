import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, loadSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { normalizeContract, normalizePolicy } from '../src/engine/contracts.js';
import { newGoal } from '../src/engine/goals.js';
import { getRecord, putRecord, listRecords, events, now } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { saveSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { spawnSubagent, followupSubagent } from '../src/engine/subagents.js';
import { assignmentStatus, extendAssignmentBudget, runAssignment } from '../src/engine/delegation.js';
import { currentAssignmentUsage, delegationUsage } from '../src/engine/delegation-usage.js';
import { getWorkerBudgetSettings } from '../src/engine/worker-budget.js';
import { ToolHost } from '../src/engine/tools.js';
import { processIdentity, identityAlive, signalProcess } from '../src/engine/recovery.js';
import { artifact } from '../src/engine/evidence.js';

test('a real offline runner hands off near its allocation and resumes one reviewed worker with cumulative usage', { timeout: 25000 }, async () => {
  const keys = ['BZZY_HOME', 'BZZY_CODEX_BIN', 'BZZY_CODEX_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-worker-budget-runner-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'), auth = path.join(directory, 'fixture-auth'), fixture = path.join(directory, 'budget-worker.mjs');
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'baseline.txt'), 'Offline control only.');
  fs.mkdirSync(auth, { mode: 0o700 }); fs.writeFileSync(path.join(auth, 'auth.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(fixture, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0 (offline allocation fixture)'); process.exit(0); }
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const counter=path.join(process.env.CODEX_HOME,'allocation-round.txt');
const round=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;
fs.writeFileSync(counter,String(round));
const threadId='offline-allocation-worker', turnId='allocation-turn-'+round;
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>send({method,params:{threadId,...params}});
const usage=()=>notify('thread/tokenUsage/updated',{tokenUsage:{total:{totalTokens:round===1?900:1200}}});
for await (const line of readline.createInterface({input:process.stdin})) {
 const request=JSON.parse(line);
 fs.appendFileSync(path.join(process.env.CODEX_HOME,'allocation-calls.jsonl'),JSON.stringify({round,...request})+'\\n');
 if (request.id===901 && !request.method) {
  if (round===2) {
   if(!request.result?.success) process.exit(12);
   usage(); notify('item/agentMessage/delta',{itemId:'reply-'+round,delta:'The remaining offline check is complete; the parent goal still needs its own review.'});
   notify('turn/completed',{turn:{id:turnId,status:'completed'}});
  }
  continue;
 }
 if(!request.method) continue;
 const result=['thread/start','thread/resume'].includes(request.method)?{thread:{id:threadId}}
  :request.method==='turn/start'?{turn:{id:turnId}}:{};
 if(request.id!==undefined) send({id:request.id,result});
 if(request.method==='turn/start') setTimeout(()=>{
  notify('turn/started',{turn:{id:turnId}}); usage();
  notify('item/agentMessage/delta',{itemId:'reply-'+round,delta:round===1?'The baseline is recorded; one local control remains unresolved.':'The focused continuation checked the remaining control.'});
  setTimeout(()=>send({id:901,method:'item/tool/call',params:{threadId,turnId,callId:'finish-'+round,tool:'finish_assignment',arguments:{
   status:round===1?'partial':'complete',summary:round===1?'The baseline was inspected; one offline control remains.':'Both assigned offline controls were inspected.',evidence:[],
   uncertainties:round===1?['The second local control remains unchecked.']:[],nextSteps:round===1?['Inspect the remaining local control after supervisor review.']:[]
  }}}),round===1?250:10);
 },10);
 if(request.method==='turn/interrupt') {usage();notify('turn/completed',{turn:{id:turnId,status:'interrupted'}});}
}
`, { mode: 0o700 });
  let worker;
  try {
    process.env.BZZY_CODEX_BIN = fixture; process.env.BZZY_CODEX_HOME = auth;
    const parent = createSession(getProvider('codex'), cwd, 'offline-parent');
    parent.mode = 'solo'; parent.policy = normalizePolicy(); parent.contract = normalizeContract({}, 'Inspect two offline controls.');
    parent.goal = newGoal(parent.contract.objective, 10000, { workerBudgetPolicy: {
      ...getWorkerBudgetSettings(), initialTokenBudget: 1000, initialRuntimeSeconds: 60, maxTokenBudget: 5000, maxRuntimeSeconds: 600,
    } });
    parent.executionState = 'running'; parent.usage = { tokens: 0, available: true, accountingComplete: true };
    initializeProject(parent); saveSession(parent);
    const parentGoal = structuredClone(parent.goal), parentContract = structuredClone(parent.contract), launched = [];
    const context = { goalMode: true, runId: randomUUID(), prompt: parent.goal.objective, launch: (id, round) => launched.push({ id, round }) };
    putRecord('run', parent.id, { id: context.runId, sessionId: parent.id, state: 'running', goalMode: true, goalId: parent.goal.id, runner: processIdentity(), startedAt: now() });
    const definition = saveSubagentDefinition({ name: 'allocation-analyst', description: 'Inspect only the supplied offline controls.',
      instructions: 'Record local observations and keep unfinished checks explicit. Do not claim the parent goal is complete.', model: 'offline-worker' }, { cwd });
    const admitted = spawnSubagent(parent, { name: definition.name, requestId: 'allocation-worker', objective: 'Inspect the two supplied offline controls.' }, context);
    assert.equal(admitted.contract.limits.tokenBudget, 1000); assert.equal(admitted.workerBudget.mode, 'adaptive');
    await runAssignment(admitted.id, 1);
    const first = assignmentStatus(admitted.id); worker = loadSession(first.workerSessionId);
    assert.equal(first.round.state, 'awaiting_review', first.round.error);
    assert.equal(first.round.stopReason, 'allocation_checkpoint');
    assert.equal(first.round.report.status, 'partial'); assert.equal(first.round.missingReport, false);
    assert.deepEqual(first.round.report.uncertainties, ['The second local control remains unchecked.']);
    assert.deepEqual(first.round.report.nextSteps, ['Inspect the remaining local control after supervisor review.']);
    assert.equal(first.round.usage.tokens, 900); assert.equal(currentAssignmentUsage(first).chargedTokens, 900);
    const report = getRecord('artifact', first.round.reportArtifactId); assert.ok(report && fs.existsSync(report.path));
    const retained = JSON.parse(fs.readFileSync(report.path, 'utf8')); assert.equal(retained.stopReason, 'allocation_checkpoint'); assert.equal(retained.report.status, 'partial');
    assert.deepEqual(loadSession(parent.id).goal, parentGoal); assert.deepEqual(loadSession(parent.id).contract, parentContract);
    assert.equal(loadSession(parent.id).executionState, 'running');
    assert.ok(events(parent.id, 0, 1000).some(event => event.type === 'assignment.budget.warning'));
    const host = new ToolHost(parent, { event() {} }, context);
    await host.call('read_artifact', { id: first.round.reportArtifactId });
    const extended = extendAssignmentBudget(parent, first.id, { id: first.id, requestId: 'reviewed-allocation-extension', expectedRevision: 1,
      addTokens: 1000, addSeconds: 60, progress: 'The reviewed baseline identifies one remaining offline control.', evidence: [first.round.reportArtifactId] }, context);
    assert.equal(extended.budget.tokenLimit, 2000); assert.equal(extended.budget.runtimeLimitSeconds, 120);
    assert.equal(extended.budget.tokensUsed, 900);
    const continuation = followupSubagent(parent, first.id, { requestId: 'continue-same-allocation-worker', objective: 'Inspect only the remaining local control.',
      feedback: 'Use the reviewed baseline; do not repeat the first check.' }, context);
    assert.equal(continuation.id, first.id); assert.equal(continuation.round, 2);
    assert.equal(getRecord('assignment', first.id).workerSessionId, worker.id);
    await runAssignment(first.id, 2);
    const second = assignmentStatus(first.id), usage = currentAssignmentUsage(second);
    assert.equal(second.round.state, 'awaiting_review', second.round.error); assert.equal(second.round.report.status, 'complete');
    assert.equal(second.workerSessionId, worker.id); assert.equal(second.currentRound, 2);
    assert.equal(second.contract.limits.tokenBudget, 2000); assert.equal(second.contract.limits.runtimeSeconds, 120);
    assert.equal(usage.tokens, 1200); assert.equal(usage.chargedTokens, 1200); assert.equal(usage.accountingComplete, true);
    assert.equal(delegationUsage(loadSession(parent.id)).delegatedTokens, 1200);
    assert.equal(listRecords('assignment', { parentSessionId: parent.id }).length, 1);
    assert.deepEqual(launched, [{ id: first.id, round: 1 }, { id: first.id, round: 2 }]);
    assert.deepEqual(loadSession(parent.id).goal, parentGoal); assert.equal(loadSession(parent.id).executionState, 'running');
    assert.ok(!events(parent.id, 0, 1000).some(event => event.type === 'goal.completed'));
    const calls = fs.readFileSync(path.join(auth, 'allocation-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.round === 1 && call.method === 'turn/interrupt'));
    assert.ok(calls.some(call => call.round === 2 && call.method === 'thread/resume'));
    assert.equal(calls.filter(call => call.method === 'thread/start').length, 1);
    await host.close();
  } finally {
    const identities = [...listRecords('session').map(item => item.backendProcess), ...listRecords('round').flatMap(item => [item.runner, item.launcher])]
      .filter(identity => identity && identity.pid !== process.pid);
    for (const identity of identities) if (identityAlive(identity)) signalProcess(identity, 'SIGKILL', { group: identity.pgid === identity.pid });
    const deadline = Date.now() + 2000;
    while (identities.some(identityAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const scenario of ['token-jump', 'backend-exit', 'reported-backend-exit', 'preparation-exhausted']) test('offline specialist preserves an incomplete receipt after ' + scenario, { timeout: 25000 }, async () => {
  const keys = ['BZZY_HOME', 'BZZY_CODEX_BIN', 'BZZY_CODEX_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-worker-handoff-runner-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  const cwd = path.join(directory, 'project'), auth = path.join(directory, 'auth'), fixture = path.join(directory, 'worker.mjs');
  fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'baseline.txt'), 'Offline control only.');
  fs.mkdirSync(auth, { mode: 0o700 }); fs.writeFileSync(path.join(auth, 'auth.json'), '{}', { mode: 0o600 });
  fs.writeFileSync(fixture, [
    '#!' + process.execPath,
    "import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';",
    "if(process.argv.includes('--version')){console.log('codex-cli 0.163.0 (offline receipt fixture)');process.exit(0);}",
    "if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}",
    "const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');",
    "const notify=(method,params)=>send({method,params:{threadId:'receipt-thread',...params}});",
    "const usage=(inputTokens,outputTokens)=>notify('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens,outputTokens,totalTokens:inputTokens+outputTokens}}});",
    "for await(const line of readline.createInterface({input:process.stdin})){",
    " const request=JSON.parse(line); if(!request.method)continue;",
    " fs.appendFileSync(path.join(process.env.CODEX_HOME,'calls.jsonl'),JSON.stringify(request)+'\\n');",
    " const result=['thread/start','thread/resume'].includes(request.method)?{thread:{id:'receipt-thread'}}:request.method==='turn/start'?{turn:{id:'receipt-turn'}}:{};",
    " if(request.id!==undefined)send({id:request.id,result});",
    " if(request.method==='turn/start')setTimeout(()=>{",
    "  notify('turn/started',{turn:{id:'receipt-turn'}});",
    "  fs.writeFileSync('partial-check.txt','A local control was inspected; the remaining checks are unknown.');",
    "  notify('item/completed',{turnId:'receipt-turn',item:{id:'saved-control',type:'commandExecution',command:'cat baseline.txt',aggregatedOutput:'Offline control only.',exitCode:0,status:'completed'}});",
    "  usage(37448,293);",
    scenario === 'reported-backend-exit' ? "  send({id:901,method:'item/tool/call',params:{threadId:'receipt-thread',turnId:'receipt-turn',callId:'finish',tool:'finish_assignment',arguments:{status:'complete',summary:'The assigned local baseline was inspected; this is a worker claim.',evidence:[],nextSteps:[]}}});" : '',
    "  setTimeout(()=>{" + (scenario.endsWith('backend-exit') ? 'process.exit(23);' : 'usage(75406,795);') + "},500);",
    " },10);",
    " if(request.method==='turn/interrupt')notify('turn/completed',{turn:{id:'receipt-turn',status:'interrupted'}});",
    "}",
  ].join('\n'), { mode: 0o700 });
  try {
    process.env.BZZY_CODEX_BIN = fixture; process.env.BZZY_CODEX_HOME = auth;
    const parent = createSession(getProvider('codex'), cwd, 'offline-parent');
    parent.mode = 'solo'; parent.policy = normalizePolicy(); parent.contract = normalizeContract({}, 'Inspect offline fixtures.');
    parent.goal = newGoal(parent.contract.objective, 200000, { workerBudgetPolicy: { ...getWorkerBudgetSettings(), initialTokenBudget: 60000, initialRuntimeSeconds: 60 } });
    parent.executionState = 'running'; parent.usage = { tokens: 0, available: true, accountingComplete: true };
    initializeProject(parent); saveSession(parent);
    const parentGoal = structuredClone(parent.goal), launched = [];
    const context = { goalMode: true, runId: randomUUID(), prompt: parent.goal.objective, launch: (id, round) => launched.push({ id, round }) };
    putRecord('run', parent.id, { id: context.runId, sessionId: parent.id, state: 'running', goalMode: true, goalId: parent.goal.id, runner: processIdentity(), startedAt: now() });
    const definition = saveSubagentDefinition({ name: 'receipt-analyst', description: 'Inspect only supplied offline controls.', instructions: 'Keep unfinished checks explicit.', model: 'offline-worker', limits: { tokenBudget: 60000, runtimeSeconds: 60 } }, { cwd });
    const admitted = spawnSubagent(parent, { name: definition.name, requestId: 'receipt-worker', objective: 'Inspect the supplied offline controls.' }, context);
    if (scenario === 'preparation-exhausted') {
      const worker = createSession(getProvider('codex'), cwd, 'offline-worker');
      Object.assign(worker, { assignmentId: admitted.id, assignmentRound: 1, parentSessionId: parent.id, elapsedSeconds: 65, executionState: 'idle' }); saveSession(worker);
      putRecord('assignment', admitted.id, { ...getRecord('assignment', admitted.id), workerSessionId: worker.id });
      artifact(worker, 'A saved local observation remains available.', 'saved-observation');
      putRecord('worker-report', worker.id, { round: 0, status: 'complete', summary: 'Earlier round only.' });
    }
    await runAssignment(admitted.id, 1);
    const saved = assignmentStatus(admitted.id), worker = loadSession(saved.workerSessionId), receipt = saved.round.hostHandoff;
    const reported = scenario === 'reported-backend-exit';
    assert.equal(saved.round.missingReport, !reported);
    if (reported) { assert.equal(saved.round.report.status, 'complete'); assert.equal(saved.round.report.provenance, 'worker-claim'); }
    else assert.equal(saved.round.report, null);
    assert.equal(receipt.state, 'incomplete'); assert.equal(receipt.assignmentId, admitted.id); assert.equal(receipt.round, 1);
    assert.equal(receipt.workerSessionId, worker.id); assert.match(receipt.remainingChecks[0], /Not fully recorded/);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 8192); assert.equal(receipt.report, undefined);
    assert.equal(saved.latestReport.hostHandoff.workerSessionId, worker.id);
    const retained = JSON.parse(fs.readFileSync(getRecord('artifact', saved.round.reportArtifactId).path, 'utf8'));
    assert.equal(retained.hostHandoff.state, 'incomplete'); assert.equal(retained.hostHandoff.missingReport, !reported);
    if (reported) assert.equal(retained.report.status, 'complete'); else assert.equal(retained.report, null);
    if (scenario === 'preparation-exhausted') {
      assert.equal(saved.round.state, 'timed_out'); assert.equal(saved.round.stopReason, 'runtime_limit');
      assert.ok(receipt.artifacts.some(item => item.label === 'saved-observation'));
      assert.ok(!fs.existsSync(path.join(auth, 'calls.jsonl')));
    } else {
      assert.ok(receipt.attempts.some(item => item.name === 'commandExecution' && item.outcome === 'succeeded'));
      assert.ok(receipt.changedPaths.includes('partial-check.txt'));
      const calls = fs.readFileSync(path.join(auth, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(calls.filter(item => item.method === 'turn/start').length, 1);
      assert.equal(calls.filter(item => item.method === 'thread/start').length, 1);
      if (scenario === 'token-jump') {
        assert.equal(saved.round.state, 'budget_limited'); assert.equal(saved.round.stopReason, 'token_limit');
        assert.equal(saved.round.usage.tokens, 76201); assert.equal(saved.contract.limits.tokenBudget, 60000);
        assert.equal(currentAssignmentUsage(saved).chargedTokens, 76201);
        assert.ok(events(parent.id, 0, 1000).some(event => event.type === 'assignment.budget.warning' && event.data.tokensUsed === 37741));
      } else assert.equal(saved.round.state, 'failed');
    }
    assert.deepEqual(loadSession(parent.id).goal, parentGoal); assert.equal(loadSession(parent.id).executionState, 'running');
    assert.equal(launched.length, 1); assert.equal(listRecords('assignment', { parentSessionId: parent.id }).length, 1);
  } finally {
    const identities = listRecords('session').map(item => item.backendProcess).filter(identity => identity && identity.pid !== process.pid);
    for (const identity of identities) if (identityAlive(identity)) signalProcess(identity, 'SIGKILL', { group: identity.pgid === identity.pid });
    const deadline = Date.now() + 2000;
    while (identities.some(identityAlive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
