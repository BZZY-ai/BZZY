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
import { getRecord, putRecord, now } from '../src/engine/database.js';
import { initializeProject } from '../src/engine/project.js';
import { saveSubagentDefinition } from '../src/engine/subagent-definitions.js';
import { spawnSubagent, followupSubagent } from '../src/engine/subagents.js';
import { assignmentStatus, extendAssignmentBudget, runAssignment } from '../src/engine/delegation.js';
import { currentAssignmentUsage } from '../src/engine/delegation-usage.js';
import { getWorkerBudgetSettings } from '../src/engine/worker-budget.js';
import { ToolHost } from '../src/engine/tools.js';
import { processIdentity } from '../src/engine/recovery.js';

test('Claude hands off with final measured usage and continues the reviewed conversation within its enlarged cumulative allocation', { timeout: 20000 }, async () => {
  const keys = ['BZZY_HOME', 'BZZY_CLAUDE_BIN', 'BZZY_CLAUDE_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-claude-budget-')));
  const cwd = path.join(directory, 'project'), auth = path.join(directory, 'fixture-auth'), fixture = path.join(directory, 'fixture-claude.mjs');
  fs.mkdirSync(cwd); fs.mkdirSync(auth, { mode: 0o700 }); fs.writeFileSync(path.join(cwd, 'baseline.txt'), 'Offline fixture only.');
  Object.assign(process.env, { BZZY_HOME: path.join(directory, 'private'), BZZY_CLAUDE_BIN: fixture, BZZY_CLAUDE_HOME: auth });
  fs.writeFileSync(fixture, `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
import {spawnSync} from 'node:child_process';
const send=value=>console.log(JSON.stringify(value));
if(process.argv.includes('auth')) {send({loggedIn:true,authMethod:'claude.ai'});process.exit(0);}
const continued=process.argv.includes('--resume');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const value=JSON.parse(line);
 if(value.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:value.request_id}});
 if(value.type==='user') {
  const initial={type:'assistant',message:{id:'fixture-message',content:[{type:'text',text:'The local baseline is preserved; remaining checks are explicit.'}],
   usage:{input_tokens:continued?350:850,output_tokens:50}}};
  send(initial);send(initial);
  setTimeout(()=>{
   const index=process.argv.indexOf('--mcp-config');
   const server=JSON.parse(fs.readFileSync(process.argv[index+1],'utf8')).mcpServers.bzzy_goal;
   const report={status:continued?'complete':'partial',summary:continued?'The remaining offline control was inspected.':'The baseline is recorded; one local check remains.',evidence:[]};
   const input=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'finish_assignment',arguments:report}})+'\\n';
   const response=spawnSync(server.command,server.args,{input,env:{...process.env,...server.env},encoding:'utf8',timeout:5000});
   if(response.status!==0||!response.stdout.includes('recorded')) {process.exit(91);return;}
   send({type:'result',subtype:'success',session_id:'offline-claude-allocation-thread',result:'The offline result is ready for supervisor review.',
    usage:{input_tokens:continued?400:900,output_tokens:50}});
  },150);
 }
});
`, { mode: 0o700 });
  try {
    const parent = createSession(getProvider('claude'), cwd, 'offline-parent');
    parent.mode = 'solo'; parent.policy = normalizePolicy(); parent.contract = normalizeContract({}, 'Inspect two offline controls.');
    parent.goal = newGoal(parent.contract.objective, 10000, { workerBudgetPolicy: {
      ...getWorkerBudgetSettings(), initialTokenBudget: 1000, initialRuntimeSeconds: 60, maxTokenBudget: 5000, maxRuntimeSeconds: 600,
    } });
    parent.executionState = 'running'; parent.usage = { tokens: 0, available: true, accountingComplete: true };
    parent.backendHomes = { claudeConfigDir: auth, claudeSecureStorageConfigDir: auth };
    initializeProject(parent); saveSession(parent);
    const launched = [], context = { goalMode: true, runId: randomUUID(), prompt: parent.goal.objective,
      launch: (id, round) => launched.push({ id, round }) };
    putRecord('run', parent.id, { id: context.runId, sessionId: parent.id, state: 'running', goalMode: true,
      goalId: parent.goal.id, runner: processIdentity(), startedAt: now() });
    const definition = saveSubagentDefinition({ name: 'claude-allocation-analyst', description: 'Inspect only supplied offline controls.',
      instructions: 'Preserve local observations and report unfinished checks before the allocation ends.', model: 'offline-worker' }, { cwd });
    const admitted = spawnSubagent(parent, { name: definition.name, requestId: 'claude-budget-fixture', objective: 'Inspect both supplied offline controls.' }, context);
    await runAssignment(admitted.id, 1);
    const first = assignmentStatus(admitted.id), workerId = first.workerSessionId;
    assert.equal(first.round.state, 'awaiting_review', first.round.error);
    assert.equal(first.round.stopReason, 'allocation_checkpoint'); assert.equal(first.latestReport.report.status, 'partial');
    assert.equal(currentAssignmentUsage(first).tokens, 950); assert.equal(currentAssignmentUsage(first).accountingComplete, true);
    const evidence = first.latestReport.artifacts.find(item => item.label === 'agent-output'); assert.ok(evidence);
    await new ToolHost(parent, { event() {} }, context).call('read_artifact', { id: evidence.id });
    const extended = extendAssignmentBudget(parent, first.id, { id: first.id, requestId: 'claude-budget-extension',
      expectedRevision: first.workerBudget.revision, addTokens: 1000, progress: 'The baseline was inspected; the remaining local control is identified.', evidence: [evidence.id] }, context);
    assert.equal(extended.budget.tokenLimit, 2000); assert.equal(extended.budget.tokensUsed, 950);
    const followup = followupSubagent(parent, first.id, { requestId: 'claude-budget-followup', objective: 'Inspect the remaining local control.',
      feedback: 'Continue from the inspected baseline without repeating completed work.' }, context);
    assert.equal(followup.round, 2); await runAssignment(first.id, 2);
    const finished = assignmentStatus(first.id);
    assert.equal(finished.workerSessionId, workerId); assert.equal(finished.round.state, 'awaiting_review', finished.round.error);
    assert.equal(finished.latestReport.report.status, 'complete'); assert.equal(currentAssignmentUsage(finished).tokens, 1400);
    assert.equal(currentAssignmentUsage(finished).accountingComplete, true);
    assert.equal(loadSession(workerId).usage.tokens, 1400); assert.equal(launched.length, 2);
    assert.equal(loadSession(parent.id).goal.status, 'active'); assert.equal(getRecord('assignment', first.id).closure, 'open');
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
