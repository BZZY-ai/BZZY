#!/usr/bin/env node
// Offline synthetic navigation benchmark. No models, accounts or network calls.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createSession, saveSession } from '../src/engine/store.js';
import { BUILTINS } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { knowledgeDatabase, initializeMemoryLinkCoverage } from '../src/engine/knowledge-index.js';
import { taskKnowledgeBrief } from '../src/engine/task-knowledge-brief.js';

const usage = 'node scripts/memory-retrieval-benchmark.mjs [--documents 100000] [--pulls 50] [--source-bytes 20000000]';
const options = { documents: 100000, pulls: 50, 'source-bytes': 0 };
const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help')) { console.log(usage); process.exit(0); }
for (let index = 0; index < arguments_.length; index += 2) {
  const name = arguments_[index].replace(/^--/, ''), value = arguments_[index + 1];
  if (!Object.hasOwn(options, name) || !/^\d+$/.test(value || '')) throw new Error(usage);
  options[name] = Number(value);
}
if (!Number.isSafeInteger(options.documents) || options.documents < 8 || options.documents > 200000
  || !Number.isSafeInteger(options.pulls) || options.pulls < 2 || options.pulls > 1000
  || !Number.isSafeInteger(options['source-bytes']) || options['source-bytes'] > 128 * 1024 * 1024) throw new Error(usage);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-retrieval-benchmark-')));
const previousHome = process.env.BZZY_HOME;
process.env.BZZY_HOME = path.join(root, 'private');
let db;
try {
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const session = createSession(BUILTINS.codex, project, 'offline-fixture'); initializeProject(session);
  session.goal = { id: 'fixture-goal', status: 'active', objective: 'RARE_NAVIGATION_TEST' }; saveSession(session);
  db = knowledgeDatabase();
  initializeMemoryLinkCoverage(session.id);
  const insertRecord = db.prepare('INSERT INTO records VALUES(?,?,?,?)');
  const insertDocument = db.prepare('INSERT INTO knowledge_documents VALUES(?,?,?,?,?,?,?,?)');
  const date = '2026-01-01T00:00:00Z', minimumBodyBytes = Math.ceil(options['source-bytes'] / options.documents);
  const rareInterval = Math.max(1, Math.floor(options.documents / 4));
  let sourceBytes = 0;
  const started = performance.now(); db.exec('BEGIN IMMEDIATE');
  for (let index = 0; index < options.documents; index++) {
    const id = `fixture-${String(index).padStart(6, '0')}`;
    let body = index % rareInterval === 0 ? 'RARE_NAVIGATION_TEST historical finding' : 'COMMON_RECORD unrelated archival memory';
    if (body.length < minimumBodyBytes) body += ' fixture'.repeat(Math.ceil((minimumBodyBytes - body.length) / 8)).slice(0, minimumBodyBytes - body.length);
    sourceBytes += Buffer.byteLength(body);
    const record = { id, sessionId: session.id, projectId: session.projectId, project, kind: 'hypothesis', truth: 'hypothesis',
      statement: body, rationale: '', evidence: [], inputs: [], revision: 1 };
    const data = JSON.stringify(record);
    insertRecord.run('memory', id, data, date);
    insertDocument.run(`${session.projectId}:memory:${id}`, session.projectId, session.id, 'memory', id, body, data, date);
  }
  db.exec('COMMIT');
  const results = { version: 1, documents: options.documents, pulls: options.pulls, sourceBytes,
    requestedMinimumSourceBytes: options['source-bytes'], tokens: null, buildMs: performance.now() - started,
    methodology: 'Synthetic typed source records and FTS documents. Cold lookup followed by warm identifier-cache pulls; canonical sources and freshness are rechecked every pull. Source bytes are UTF-8, not measured tokens. This measures navigation cost, not autonomous investigation quality.', queries: {} };
  const percentile = (values, fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
  for (const [name, objective] of [['rare', 'RARE_NAVIGATION_TEST'], ['broad', 'COMMON_RECORD']]) {
    const latencies = []; let maxBytes = 0, items = 0;
    const before = db.prepare('SELECT total_changes() AS count').get().count;
    for (let index = 0; index < options.pulls; index++) {
      const start = performance.now(), view = taskKnowledgeBrief(session, { ...session.goal, objective });
      latencies.push(performance.now() - start);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(view.brief))); items = view.brief.items.length;
    }
    const after = db.prepare('SELECT total_changes() AS count').get().count;
    const warm = latencies.slice(1).sort((a, b) => a - b), all = [...latencies].sort((a, b) => a - b);
    results.queries[name] = { coldMs: latencies[0], warm: { samples: warm.length, p50Ms: percentile(warm, .5),
      p95Ms: percentile(warm, .95), maxMs: warm.at(-1) }, allP95Ms: percentile(all, .95), maxBytes, items,
      sqliteWriteSnapshot: { before, after, delta: after - before } };
    if (after !== before || maxBytes > 2200) throw new Error('Navigation wrote durable state or exceeded its byte budget.');
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (db?.isTransaction) db.exec('ROLLBACK');
  db?.close();
  if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
}
