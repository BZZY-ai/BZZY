import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession,saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { database,getRecord,putRecord,removeRecord,transaction,appendEvent,digest } from '../src/engine/database.js';
import { knowledgeDatabase,knowledgeAccess,indexKnowledgeRecord,refreshKnowledgeRecords,knowledgeSourceRevision,readKnowledgeSource } from '../src/engine/knowledge-index.js';
import { searchProjectKnowledge } from '../src/engine/knowledge.js';
import { taskKnowledgeBrief } from '../src/engine/task-knowledge-brief.js';
import { artifact } from '../src/engine/evidence.js';
import { recordWorkObservation } from '../src/engine/episode.js';
import { memoryFreshness } from '../src/engine/memory.js';
import { registerLocalEmbeddingAdapter,configureRetrieval,refreshLocalEmbeddings,localSemanticCandidates } from '../src/engine/retrieval-quality.js';
import { indexSessionMemory,pendingSessionMemoryNodes,publishSessionMemoryFallback,publishSessionMemorySummary,
  readSessionMemory,expandSessionMemory,resetSessionMemory } from '../src/engine/session-memory.js';

let root,priorHome,session;
const saved = cwd => { const value=createSession(BUILTINS.codex,cwd,'offline-fixture'); initializeProject(value); saveSession(value); return value; };
const memory = (id,statement,owner=session) => ({ id,sessionId:owner.id,projectId:owner.projectId,project:owner.cwd,
  kind:'hypothesis',truth:'hypothesis',statement,rationale:'',evidence:[],inputs:[],revision:1,createdAt:'2000-01-01T00:00:00.000Z' });
test.beforeEach(() => {
  priorHome=process.env.BZZY_HOME; root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'bzzy-memory-scale-')));
  process.env.BZZY_HOME=path.join(root,'private'); const project=path.join(root,'project'); fs.mkdirSync(project); session=saved(project);
});
test.afterEach(() => {
  registerLocalEmbeddingAdapter(null);
  if (priorHome===undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME=priorHome;
  fs.rmSync(root,{recursive:true,force:true});
});

test('historical projection advances bounded session/keyset batches and processes edits behind its cursor', () => {
  const db=knowledgeDatabase(),access=knowledgeAccess(session);
  transaction(() => { for (let i=0;i<2105;i++) { const value=memory(`archive-${String(i).padStart(5,'0')}`,`Historical fixture claim ${i}`); putRecord('memory',value.id,value); } });
  let result,rounds=0;
  do { result=refreshKnowledgeRecords(session,{limit:64}); assert.ok(result.indexed<=64); rounds++; } while(result.remaining && rounds<150);
  assert.equal(result.remaining,false); assert.ok(rounds>1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_documents WHERE kind='memory'").get().n,2105);
  const before=knowledgeSourceRevision(session),id='archive-00000';
  putRecord('memory',id,{...getRecord('memory',id),statement:'UPDATED_OLDEST_FINDING',revision:2});
  assert.ok(knowledgeSourceRevision(session)>before);
  const update=refreshKnowledgeRecords(session,{limit:4}); assert.equal(update.indexed,1);
  assert.match(db.prepare('SELECT body FROM knowledge_documents WHERE source_id=?').get(id).body,/UPDATED_OLDEST_FINDING/);
  removeRecord('memory',id); refreshKnowledgeRecords(session,{limit:4});
  assert.equal(db.prepare('SELECT 1 FROM knowledge_documents WHERE source_id=?').get(id),undefined);
  const plan=db.prepare(`EXPLAIN QUERY PLAN SELECT kind,id FROM records WHERE kind=? AND json_extract(data,'$.sessionId')=? AND id>? ORDER BY id LIMIT 33`)
    .all('memory',session.id,'');
  assert.ok(plan.some(row=>row.detail.includes('knowledge_record_scope'))); assert.ok(plan.every(row=>!row.detail.includes('TEMP B-TREE')));
  assert.equal(access.project.id,session.projectId);
});

test('legacy relationship freshness stays unknown until bounded migration reaches late supersession and contradiction sources', () => {
  const superseded=memory('000-original','LEGACY_RELATION_TARGET original'),disputed=memory('001-disputed','LEGACY_RELATION_TARGET disputed');
  const replacement={...memory('zzz-replacement','Replacement source'),supersedes:superseded.id,contradictions:[disputed.id]};
  transaction(()=>{
    putRecord('memory',superseded.id,superseded);putRecord('memory',disputed.id,disputed);
    for(let i=0;i<100;i++) {const value=memory(`noise-${String(i).padStart(3,'0')}`,'Unrelated legacy');putRecord('memory',value.id,value);}
    putRecord('memory',replacement.id,replacement);
  });
  const first=refreshKnowledgeRecords(session,{limit:16}),access=knowledgeAccess(session,{readOnly:true});
  assert.equal(first.remaining,true);
  for(const source of [superseded,disputed]) {
    const fresh=memoryFreshness(source,access.project,session,{readOnly:true});
    assert.equal(fresh.relationshipCoverage,'backfill-pending');assert.equal(fresh.stale,false);
    assert.equal(fresh.freshnessStatus,'unverified');assert.equal(fresh.truth,source.truth);
    assert.deepEqual(fresh.staleReasons,[]);
  }
  const before=database().prepare('SELECT total_changes() AS n').get().n;
  const brief=taskKnowledgeBrief(session,{id:'legacy-goal',status:'active',objective:'LEGACY_RELATION_TARGET'});
  assert.ok(brief.brief.items.every(item=>item.relationshipCoverage==='backfill-pending' && item.freshnessStatus==='unverified' && !item.stale));
  assert.equal(database().prepare('SELECT total_changes() AS n').get().n,before);
  let result,round=0;do {result=refreshKnowledgeRecords(session,{limit:16});round++;}while(result.remaining && round<30);
  assert.equal(result.remaining,false);
  const current=memoryFreshness(superseded,access.project,session,{readOnly:true});
  assert.equal(current.relationshipCoverage,'complete');assert.equal(current.supersededBy,replacement.id);assert.ok(current.staleReasons.includes('superseded'));
  const contradiction=memoryFreshness(disputed,access.project,session,{readOnly:true});
  assert.equal(contradiction.relationshipCoverage,'complete');assert.equal(contradiction.disputed,true);assert.deepEqual(contradiction.contradictions,[replacement.id]);
  assert.deepEqual(getRecord('memory',superseded.id),superseded);
  // Matching document text/payload cannot bypass repair of a newly rebuilt
  // relationship projection on an existing database.
  const document=database().prepare('SELECT body,payload FROM knowledge_documents WHERE source_id=?').get(replacement.id);
  database().prepare('DELETE FROM knowledge_memory_links WHERE source_id=?').run(replacement.id);
  indexKnowledgeRecord(access.project,'memory',replacement.id,session.id,document.body,JSON.parse(document.payload));
  assert.equal(memoryFreshness(superseded,access.project,session,{readOnly:true}).supersededBy,replacement.id);
});

test('indexed task polling has fixed candidate hydration, no writes, and explicit session/project attribution', t => {
  const db=knowledgeDatabase(),access=knowledgeAccess(session),other=saved(session.cwd);
  session.goal={id:'fixture-goal',status:'active',objective:'Inspect ORBIT_SIGNAL historical findings'}; saveSession(session);
  transaction(() => {
    for(let i=0;i<3000;i++) { const value=memory(`noise-${i}`,'Unrelated historical fixture'); putRecord('memory',value.id,value); }
    for(let i=0;i<45;i++) { const value=memory(`match-${i}`,`ORBIT_SIGNAL distinct claim ${i}`,i===0?session:other); putRecord('memory',value.id,value);
      indexKnowledgeRecord(access.project,'memory',value.id,value.sessionId,`${value.statement}\n`,value); }
  });
  const prepare=db.prepare.bind(db),queries=[];
  t.mock.method(db,'prepare',sql=>{ queries.push(sql); return prepare(sql); });
  const before=prepare('SELECT total_changes() AS n').get().n;
  const first=taskKnowledgeBrief(session,session.goal),firstQueries=queries.length,second=taskKnowledgeBrief(session,session.goal);
  assert.equal(prepare('SELECT total_changes() AS n').get().n,before);
  assert.equal(first.revision,second.revision); assert.equal(first.brief.items[0].sourceScope,'session');
  assert.ok(first.brief.items.some(item=>item.sourceScope==='project-history'));
  assert.ok(Buffer.byteLength(JSON.stringify(first.brief))<=2200); assert.ok(first.brief.omitted>0);
  assert.ok(firstQueries<750,`Hydration uses ${firstQueries} bounded queries, not 3,000 historical records.`);
  assert.ok(queries.length-firstQueries<=firstQueries+5);
  assert.ok(queries.every(sql=>!(/count\(\*\)|max\(updated_at\)/i.test(sql))), 'Polling never counts the source ledger or FTS corpus.');
  assert.ok(queries.every(sql=>!(/^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(sql))));
});

test('source mutations invalidate cached text before a delayed maintenance pass can publish it', () => {
  const access=knowledgeAccess(session),value=memory('old-source','ORIGINAL_QUERY_TERM old assertion');
  knowledgeDatabase(); putRecord('memory',value.id,value); indexKnowledgeRecord(access.project,'memory',value.id,session.id,`${value.statement}\n`,value);
  // Keep enough lower keys ahead of this edit to defer projection this turn.
  transaction(()=>{for(let i=0;i<100;i++) { const row=memory(`a-${i}`,'Other fixture');putRecord('memory',row.id,row); }});
  putRecord('memory',value.id,{...value,statement:'Replacement statement',revision:2});
  assert.deepEqual(searchProjectKnowledge(session,{query:'ORIGINAL_QUERY_TERM',types:['memory']}).items,[]);
  removeRecord('memory',value.id);
  assert.deepEqual(searchProjectKnowledge(session,{query:'ORIGINAL_QUERY_TERM',types:['memory']}).items,[]);
});

test('newly projected legacy records invalidate a warm candidate cache without rewriting source records', () => {
  knowledgeDatabase();const value=memory('legacy-cache-source','LATE_PROJECTION_SIGNAL');putRecord('memory',value.id,value);
  const goal={id:'legacy-goal',status:'active',objective:'LATE_PROJECTION_SIGNAL'};
  assert.deepEqual(taskKnowledgeBrief(session,goal).brief.items,[]);
  const revision=knowledgeSourceRevision(session);refreshKnowledgeRecords(session);
  assert.equal(knowledgeSourceRevision(session),revision);
  assert.equal(taskKnowledgeBrief(session,goal).brief.items[0].sourceId,value.id);
});

test('artifact search exposes only scoped metadata and never opens artifact contents', () => {
  const source=artifact(session,'PRIVATE_ARTIFACT_BODY_ONLY','ORBIT_SCREENSHOT offline label');
  const hit=searchProjectKnowledge(session,{query:'ORBIT_SCREENSHOT',types:['artifact']}).items[0];
  assert.equal(hit.sourceId,source.id); assert.equal(hit.metadataOnly,true); assert.equal(hit.truth,'inconclusive');
  assert.equal(hit.sha256,source.sha256); assert.doesNotMatch(JSON.stringify(hit),/PRIVATE_ARTIFACT_BODY_ONLY|"path"|private\/artifacts/);
  assert.deepEqual(searchProjectKnowledge(session,{query:'PRIVATE_ARTIFACT_BODY_ONLY',types:['artifact']}).items,[]);
  putRecord('artifact',source.id,{...getRecord('artifact',source.id),importedUntrusted:true});
  assert.deepEqual(searchProjectKnowledge(session,{query:'ORBIT_SCREENSHOT',types:['artifact']}).items,[]);
  const imported=searchProjectKnowledge(session,{query:'ORBIT_SCREENSHOT',types:['artifact'],includeStale:true}).items[0];
  assert.equal(imported.stale,true);assert.equal(imported.provenance,'imported-artifact-metadata');
  removeRecord('artifact',source.id); assert.deepEqual(searchProjectKnowledge(session,{query:'ORBIT_SCREENSHOT',types:['artifact']}).items,[]);
});

test('attempt discovery reaches beyond recent episode windows and expands only exact host-observed metadata', () => {
  knowledgeDatabase(); session.goal={id:'prior-goal',status:'active',objective:'Offline observation fixture'}; saveSession(session);
  putRecord('run',session.id,{id:'fixture-run',sessionId:session.id,state:'running',goalMode:true,goalId:session.goal.id});
  let original;
  transaction(()=>{for(let i=0;i<550;i++) {
    const result=recordWorkObservation(session,{itemId:`fixture-${i}`,runId:'fixture-run',kind:'command',name:'offline-check',
      command:'echo FICTIONAL_COMMAND_BODY',output:i===0?'ARCHIVE_ATTEMPT_MARKER password="FICTIONAL_ATTEMPT_SECRET"':`Ordinary result ${i}`,exitCode:0});
    if(i===0) original=result;
  }});
  let projection,round=0; do { projection=refreshKnowledgeRecords(session,{limit:64}); round++; } while(projection.remaining && round<50);
  assert.equal(projection.remaining,false);
  session.goal={id:'new-goal',status:'active',objective:'A different authorized investigation'}; saveSession(session);
  const hit=searchProjectKnowledge(session,{query:'ARCHIVE_ATTEMPT_MARKER',types:['attempt']}).items[0];
  assert.equal(hit.sourceId,original.id); assert.equal(hit.goalId,'prior-goal'); assert.equal(hit.outcome,'succeeded');
  assert.equal(hit.truth,'inconclusive'); assert.equal(hit.metadataOnly,true); assert.ok(hit.operationFingerprint);
  const expanded=readKnowledgeSource(session,{sourceId:hit.sourceId,sha256:hit.sha256,limit:8192});
  assert.match(expanded.text,/ARCHIVE_ATTEMPT_MARKER/); assert.doesNotMatch(expanded.text,/FICTIONAL_ATTEMPT_SECRET|FICTIONAL_COMMAND_BODY|"changedFiles"|"command"\s*:/);
  assert.equal(expanded.metadataOnly,true); assert.equal(getRecord('session',session.id).goal.id,'new-goal');
  putRecord('core.episode.observation',original.id,{...original,summary:'Forged source revision'});
  assert.throws(()=>readKnowledgeSource(session,{sourceId:hit.sourceId,sha256:hit.sha256}),/unavailable|changed/);
});

test('embedding maintenance reaches archives beyond the former newest-2,000 window and revisits dirty old keys', async () => {
  const db=knowledgeDatabase(),access=knowledgeAccess(session);
  registerLocalEmbeddingAdapter({kind:'local-embedding',local:true,model:'fixture',modelVersion:'one',dimensions:2,
    embed:async text=>text.includes('RARE_ARCHIVED')?[1,0]:[0,1]});
  configureRetrieval(session,{localEmbeddingsEnabled:true},{expectedRevision:0,reviewed:true});
  let oldId;
  for(let i=0;!oldId;i++) { const id=`old-${i}`; if(digest([access.project.id,1,`${access.project.id}:memory:${id}`]).startsWith('00')) oldId=id; }
  transaction(()=>{
    for(let i=0;i<2005;i++) { const value=memory(`new-${String(i).padStart(5,'0')}`,'Ordinary recent fixture'); value.createdAt='2026-01-01T00:00:00.000Z';
      putRecord('memory',value.id,value); indexKnowledgeRecord(access.project,'memory',value.id,session.id,`${value.statement}\n`,value); }
    const value=memory(oldId,'RARE_ARCHIVED older finding'); putRecord('memory',value.id,value); indexKnowledgeRecord(access.project,'memory',value.id,session.id,`${value.statement}\n`,value);
  });
  let result,rounds=0;
  do { result=await refreshLocalEmbeddings(session,{limit:16}); assert.ok(result.indexed<=16); rounds++; } while(result.remaining && rounds<400);
  assert.equal(result.remaining,false); assert.equal(db.prepare("SELECT count(*) AS n FROM records WHERE kind='core.retrieval.vector'").get().n,2006);
  assert.equal((await localSemanticCandidates(session,'RARE_ARCHIVED',{limit:1})).items[0].sourceId,oldId);
  const changed={...getRecord('memory',oldId),statement:'Changed archival fixture'}; putRecord('memory',oldId,changed);
  assert.deepEqual((await localSemanticCandidates(session,'RARE_ARCHIVED',{limit:1})).items,[], 'Even a legacy edit without a revision bump invalidates the old source hash.');
  indexKnowledgeRecord(access.project,'memory',oldId,session.id,`${changed.statement}\n`,changed);
  assert.equal((await refreshLocalEmbeddings(session,{limit:4})).indexed,1);
  assert.deepEqual((await localSemanticCandidates(session,'RARE_ARCHIVED',{limit:1})).items,[]);
});

test('host fallback remains pending, preserves original sources, and query navigation combines older matches with the recent tail', () => {
  transaction(()=>{for(let i=0;i<160;i++) appendEvent(session.id,'message.user',{text:i<8?`Decision RARE_OLD_ROUTE ${i}. password="FICTIONAL_PRIVATE_VALUE"`:`Recent ordinary request ${i}.`});});
  let indexed; do { indexed=indexSessionMemory(session,{force:true,maxParts:128}); } while(indexed.indexingRemaining);
  const nodes=pendingSessionMemoryNodes({sessionId:session.id,limit:100}).sort((a,b)=>a.firstSeq-b.firstSeq),original=database().prepare('SELECT data FROM events WHERE session_id=? ORDER BY seq').all(session.id);
  for(const node of nodes) {
    const fallback=publishSessionMemoryFallback(session,node.id); assert.equal(fallback.state,'pending');
    assert.ok(Buffer.byteLength(fallback.fallback)<=2048); assert.doesNotMatch(fallback.fallback,/FICTIONAL_PRIVATE_VALUE/);
  }
  const view=readSessionMemory(session,{query:'RARE_OLD_ROUTE',limit:3,maxBytes:6000});
  assert.equal(view.selection,'recent-and-relevant'); assert.ok(view.items.some(item=>item.id===nodes[0].id));
  assert.ok(view.items.some(item=>item.id===nodes.at(-1).id)); assert.ok(view.items.every(item=>item.provenance==='host-extractive-v1'));
  const relevant=readSessionMemory(session,{query:'RARE_OLD_ROUTE',limit:3,maxBytes:6000,recent:false});
  assert.equal(relevant.selection,'relevant'); assert.deepEqual(relevant.items.map(item=>item.id),[nodes[0].id]);
  assert.throws(()=>readSessionMemory(session,{recent:'yes'}),/bounds/);
  assert.match(expandSessionMemory(session,{id:nodes[0].id}).text,/RARE_OLD_ROUTE/);
  assert.deepEqual(database().prepare('SELECT data FROM events WHERE session_id=? ORDER BY seq').all(session.id),original);
  publishSessionMemorySummary(session,nodes[0].id,{text:'Model consolidation of historical RARE_OLD_ROUTE decisions.'});
  assert.equal(getRecord('core.session.memory.node',nodes[0].id).state,'ready');
  const previous=view.generation; resetSessionMemory(session,{expectedGeneration:previous});
  assert.deepEqual(readSessionMemory(session,{query:'RARE_OLD_ROUTE'}).items,[]);
});
