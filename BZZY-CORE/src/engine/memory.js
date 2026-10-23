import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { captureEvidence, inside, fileInfo } from './evidence.js';
import { writeProjectRecord, projectRecords, agentRecords } from './project.js';
import { assertPublicWorkspacePath } from './private-paths.js';

function inputInfo(root, relative) {
  assertPublicWorkspacePath(relative);
  const file = inside(root, relative), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Memory inputs must be regular, unlinked project files.');
  return fileInfo(file);
}

const kinds = ['observation', 'hypothesis', 'experiment', 'failed_approach', 'conclusion', 'decision', 'inconclusive', 'disproved', 'blocked', 'question'];
export function remember(session, input) {
  if (!kinds.includes(input.kind) || typeof input.statement !== 'string' || !input.statement.trim()) throw new Error(`Memory needs a statement and kind: ${kinds.join(', ')}.`);
  const evidence = (input.evidence || []).map(id => {
    const item = getRecord('artifact', id);
    if (!item || item.sessionId !== session.id) throw new Error('Memory evidence must reference this session’s recorded artifacts.');
    return id;
  });
  if (['observation', 'disproved'].includes(input.kind) && !evidence.length) throw new Error('Observations and disprovals need recorded evidence.');
  const inputs = (input.inputs || []).map(relative => ({ path: relative, ...inputInfo(session.cwd, relative) }));
  const record = { id: randomUUID(), project: session.projectRoot || session.cwd, agent: session.agentNamespace, sessionId: session.id, kind: input.kind,
    statement: input.statement.trim(), rationale: input.rationale || '', evidence, inputs, revisitWhen: input.revisitWhen || '',
    supersedes: input.supersedes || null, createdAt: now(), provenance: 'agent-recorded', invalidatedAt: null };
  putRecord('memory', record.id, record); writeProjectRecord(session, 'memory', record.id, record);
  appendEvent(session.id, 'memory', { id: record.id, kind: record.kind, statement: record.statement }); return record;
}
export function recall(project, query = '', limit = 12) {
  const terms = query.toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const merged = new Map(listRecords('memory').filter(m => m.project === project).map(m => [m.id, m]));
  for (const entry of [...projectRecords(project, 'memory'), ...agentRecords(project, 'memory')]) if (!merged.has(entry.id)) merged.set(entry.id, { ...entry, provenance: 'project-file' });
  return [...merged.values()].map(m => {
    const staleInputs = (m.inputs || []).filter(i => {
      try { return inputInfo(project, i.path).sha256 !== i.sha256; } catch { return true; }
    }).map(i => i.path);
    const score = terms.reduce((s, t) => s + (`${m.statement} ${m.rationale}`.toLowerCase().includes(t) ? 1 : 0), 0);
    return { ...m, stale: Boolean(m.invalidatedAt || staleInputs.length), staleInputs, score };
  }).filter(m => !terms.length || m.score).sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(50, limit));
}
export function invalidateMemory(id, reason) {
  const item = getRecord('memory', id);
  if (!item || !reason?.trim()) throw new Error('Supply an existing memory ID and invalidation reason.');
  const changed = { ...item, invalidatedAt: now(), invalidationReason: reason };
  putRecord('memory', id, changed); writeProjectRecord({ cwd: item.project, agentNamespace: item.agent }, 'memory', id, changed); return changed;
}
export function checkpoint(session, input) {
  const previous = getRecord('checkpoint', session.id) || {};
  const record = { ...previous, sessionId: session.id, objective: session.goal?.objective || session.contract?.objective,
    constraints: [...new Set([...(session.contract?.constraints || []), ...(previous.constraints || []), ...(input.constraints || [])])], updatedAt: now() };
  for (const key of ['decisions', 'completedWork', 'pendingActions', 'unresolvedQuestions', 'evidence']) {
    if (input[key] != null) {
      if (!Array.isArray(input[key])) throw new Error(`Checkpoint ${key} must be a list.`);
      record[key] = input[key];
    }
  }
  if (record.evidence?.some(id => !getRecord('artifact', id))) throw new Error('Checkpoint evidence must reference recorded artifact IDs.');
  putRecord('checkpoint', session.id, record); writeProjectRecord(session, 'checkpoints', session.id, record);
  appendEvent(session.id, 'checkpoint', record); return record;
}
