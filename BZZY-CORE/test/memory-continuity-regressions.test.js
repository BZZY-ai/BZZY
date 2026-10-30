import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject, issue } from '../src/engine/project.js';
import { appendEvent, getRecord, putRecord, database } from '../src/engine/database.js';
import { checkpoint } from '../src/engine/memory.js';
import { compactTaskState, readTaskStateDetails } from '../src/engine/recovery.js';
import { knowledgeContextFor, searchProjectKnowledge } from '../src/engine/knowledge.js';
import { readKnowledgeSource, refreshKnowledgeRecords } from '../src/engine/knowledge-index.js';
import { recordWorkObservation } from '../src/engine/episode.js';
import { agentInstructions } from '../src/engine/instructions.js';
import { sessionMemoryDocument } from '../src/engine/session-memory-document.js';
import { assignmentHandoff } from '../src/engine/assignment-handoff.js';
import { assignmentBudgetView } from '../src/engine/worker-budget.js';

let root, previous, session;
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bzzy-continuity-')));
  process.env.BZZY_HOME = path.join(root,'private');
  const cwd = path.join(root,'fake-program'); fs.mkdirSync(cwd);
  session = createSession(getProvider('codex'),cwd,'offline-fixture','fake-program-session'); initializeProject(session);
  goal();
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(root,{recursive:true,force:true}); });
function goal() {
  if (session.goal) putRecord('goal-history',session.goal.id,{ ...session.goal, sessionId:session.id });
  session.goal = { id:randomUUID(), objective:'Find a new SQLi in the fictional Orbit program.', status:'active' };
  session.contract = { objective:session.goal.objective, constraints:['Use only permitted offline fixtures.'] }; saveSession(session);
}
function attempt(id) {
  putRecord('run',session.id,{id:'run',sessionId:session.id,goalId:session.goal.id,goalMode:true,state:'running'});
  return recordWorkObservation(session,{itemId:id,runId:'run',kind:'command',name:'commandExecution',command:'cat findings/index.json',output:'SQLi candidate Orbit OLD POSITIVE INDEX',exitCode:0});
}

test('automatic delivery retains prior outcomes and archived rejections without remember or raw attempts', () => {
  checkpoint(session,{ completedWork:['Orbit SQLi report package prepared; submission is unknown.'],
    itemOperations:[{op:'add',field:'decisions',id:'retired-lead',text:'Rejected the historical Orbit SQLi lead: no authorized fixture.',disposition:'rejected',subject:'Orbit historical lead',applicability:'Revisit only after permitted scope or evidence changes.'}] });
  checkpoint(session,{decisions:['Keep the second test inconclusive.']});
  const oldGoal = session.goal.id; session.goal.status = 'complete'; goal();
  for (let i=0;i<12;i++) attempt('attempt-'+i);
  for (let i=0;i<10;i++) refreshKnowledgeRecords(session);
  const state = compactTaskState(session);
  assert.equal(state.checkpoint,null);
  const outcome = state.knowledgeBrief.items.find(item=>item.kind==='outcome');
  assert.ok(outcome); assert.equal(outcome.goalId,oldGoal); assert.equal(outcome.outcome,'complete');
  const prompt = knowledgeContextFor(session,'SQLi');
  assert.ok(prompt.items.some(item=>item.kind==='outcome'));
  assert.ok(prompt.items.every(item=>item.kind!=='attempt'));
  const source = readKnowledgeSource(session,{sourceId:outcome.sourceId,sha256:outcome.sha256,limit:8192});
  assert.match(source.text,/Rejected the historical Orbit/); assert.match(source.text,/permitted scope or evidence changes/);
  assert.match(source.text,/submission is unknown/); assert.doesNotMatch(source.text,/OLD POSITIVE INDEX/);
  assert.equal(database().prepare("SELECT count(*) AS n FROM records WHERE kind='memory'").get().n,0);
  assert.ok(searchProjectKnowledge(session,{query:'SQLi',types:['attempt']}).items.length>0);
  assert.match(sessionMemoryDocument(session).markdown,/Rejected the historical Orbit/);
});

test('same-goal rejection survives replacement and compaction with stable originals', () => {
  const first = checkpoint(session,{completedWork:['Rejected Orbit SQLi lead after unavailable scope; do not count as a clean negative.']});
  checkpoint(session,{completedWork:['Checked a separate Orbit SQLi fixture.']});
  session.nativeContext = {threadRef:'offline-thread',epoch:2}; saveSession(session);
  const state = compactTaskState(session), item = state.knowledgeBrief.items.find(item=>item.kind==='outcome');
  assert.ok(item); assert.match(item.statement,/Rejected Orbit/);
  assert.deepEqual(getRecord('core.checkpoint.revision',`${session.id}:${first.revision}`),first);
  const before = database().prepare('SELECT total_changes() AS n').get().n;
  compactTaskState(session,{knownRevision:state.revision,contextGeneration:state.contextGeneration});
  assert.equal(database().prepare('SELECT total_changes() AS n').get().n,before);
});

test('large recovery manifests stay navigable without entering mandatory instructions', () => {
  putRecord('recovery',session.id,{sessionId:session.id,state:'inspection_required',uncertainOperations:[{id:'uncertain-action'}],
    workspaceChanges:Array.from({length:1343},(_,i)=>({path:`HISTORICAL_MANIFEST_ONLY_${i}`,details:'x'.repeat(160)}))});
  const instructions = agentInstructions(session,{goalMode:true});
  assert.doesNotMatch(instructions,/HISTORICAL_MANIFEST_ONLY/); assert.ok(Buffer.byteLength(instructions)<60000);
  assert.match(instructions,/Use only permitted offline fixtures/);
  const state=compactTaskState(session); assert.equal(state.recovery.uncertainOperationCount,1); assert.equal(state.recovery.workspaceChangeCount,1343);
  assert.match(readTaskStateDetails(session,{section:'recovery',revision:state.revision}).text,/uncertain-action/);
});

test('unrelated attempts do not invalidate state; a section survives unrelated edits but not a new goal', () => {
  checkpoint(session,{decisions:['Preserve exact uncertainty.']});
  const state=compactTaskState(session), page=readTaskStateDetails(session,{section:'contract',revision:state.revision,limit:30});
  attempt('background-observation');
  assert.equal(compactTaskState(session).revision,state.revision);
  checkpoint(session,{decisions:['Another current decision.']});
  const next=readTaskStateDetails(session,{section:'contract',revision:state.revision,sourceRevision:page.sourceRevision,offset:page.nextOffset});
  assert.equal(next.sourceRevision,page.sourceRevision);
  goal();
  assert.throws(()=>readTaskStateDetails(session,{section:'contract',revision:state.revision,sourceRevision:page.sourceRevision,offset:page.nextOffset}),/section changed/);
});

test('outcome source readers reject another project and changed source hashes', () => {
  checkpoint(session,{decisions:['Orbit SQLi reviewed conclusion.']}); goal();
  const item=compactTaskState(session).knowledgeBrief.items.find(item=>item.kind==='outcome'); assert.ok(item);
  const cwd=path.join(root,'foreign');fs.mkdirSync(cwd);
  const other=createSession(getProvider('codex'),cwd,'offline');initializeProject(other);saveSession(other);
  assert.throws(()=>readKnowledgeSource(other,{sourceId:item.sourceId,sha256:item.sha256}),/outside/);
  const record=getRecord('core.checkpoint.scope',item.sourceId);putRecord('core.checkpoint.scope',item.sourceId,{...record,decisions:['Changed source'],revision:record.revision+1});
  assert.throws(()=>readKnowledgeSource(session,{sourceId:item.sourceId,sha256:item.sha256}),/changed/);
});

test('host handoffs retain missing-report uncertainty and input-aware warning headroom', () => {
  const worker=createSession(getProvider('codex'),session.cwd,'offline-worker');
  Object.assign(worker,{parentSessionId:session.id,assignmentId:'fixture-assignment',assignmentRound:1,role:'executor',usage:{tokens:37741,available:true,accountingComplete:true,lastRequestInputTokens:37448}});saveSession(worker);
  const job={id:worker.assignmentId,parentSessionId:session.id,workerSessionId:worker.id,currentRound:1,closure:'open',contract:{objective:'Inspect the offline SQLi control.',limits:{tokenBudget:60000,runtimeSeconds:600}},workerBudget:{revision:1,mode:'fixed',reportReserveTokens:4000}};
  putRecord('assignment',job.id,job);
  const receipt=assignmentHandoff(job,worker,1,{stopReason:'token_limit',artifacts:[{id:'evidence-id',label:'Saved local observation',sha256:'a'.repeat(64)}]});
  assert.equal(receipt.missingReport,true);assert.equal(receipt.state,'incomplete');assert.match(receipt.remainingChecks[0],/Not fully recorded/);
  assert.equal(receipt.artifacts[0].id,'evidence-id');assert.equal(receipt.report,undefined);
  const budget=assignmentBudgetView(job);assert.equal(budget.softReached,true);assert.ok(budget.handoffReserveTokens>37448);
  assert.equal(budget.tokenLimit,60000);assert.equal(budget.tokensUsed,37741);
});

test('changed scope retains historical rejections without making them current conclusions', () => {
  session.contract.constraints = ['Offline fixture scope version one.']; saveSession(session);
  checkpoint(session,{itemOperations:[{op:'add',field:'decisions',id:'old-scope-rejection',text:'Rejected Orbit SQLi under fixture scope version one.',disposition:'rejected',applicability:'Recheck after the permitted fixture scope changes.'}]});
  const oldGoal = session.goal.id; goal();
  session.contract.constraints = ['Offline fixture scope version two.']; saveSession(session);
  const state = compactTaskState(session), item = state.knowledgeBrief.items.find(item=>item.kind==='outcome');
  assert.equal(state.checkpoint,null); assert.ok(item); assert.equal(item.goalId,oldGoal);
  assert.equal(item.applicabilityStatus,'changed'); assert.equal(item.historical,true); assert.equal(item.truth,'inconclusive');
  assert.match(item.statement,/Rejected Orbit SQLi/);
  const source = readKnowledgeSource(session,{sourceId:item.sourceId,sha256:item.sha256,limit:8192});
  assert.match(source.text,/"requiresRevalidation": true/);
  assert.match(agentInstructions(session,{goalMode:true}),/Offline fixture scope version two/);
});

test('outcome details page older goals independently from UTF-8 source pages', () => {
  for(let i=0;i<15;i++) { checkpoint(session,{completedWork:[`Orbit SQLi historical goal ${i}.`]}); goal(); }
  const state=compactTaskState(session);
  const read = recordOffset => {
    let text='', offset=0, sourceRevision;
    do {
      const page=readTaskStateDetails(session,{section:'outcomes',revision:state.revision,recordOffset,offset,limit:8192,...(sourceRevision?{sourceRevision}:{})});
      text+=page.text; offset=page.nextOffset; sourceRevision=page.sourceRevision;
    } while(offset!==null);
    return JSON.parse(text);
  };
  const first=read(0); assert.equal(first.items.length,12); assert.equal(first.nextOffset,12);
  const second=read(first.nextOffset); assert.equal(second.items.length,3); assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.items,...second.items].map(item=>item.goalId)).size,15);
});
