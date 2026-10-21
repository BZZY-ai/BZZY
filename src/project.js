import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, readJson, writeJson } from './files.js';
import { digest, now, getRecord, putRecord } from './database.js';
import { inside } from './evidence.js';

export function projectDirectory(session) {
  const base = path.join(session.projectRoot || session.cwd, '.bzzy');
  if (session.agentNamespace && !/^[a-zA-Z0-9_-]{1,80}$/.test(session.agentNamespace)) throw new Error('Invalid agent namespace.');
  return session.agentNamespace ? path.join(base, 'agents', session.agentNamespace) : base;
}
export function initializeProject(session) {
  if (session.role === 'executor' || session.role === 'reviewer' || session.policy?.mode === 'read-only') return;
  const dir = projectDirectory(session); privateDir(dir);
  const file = path.join(dir, 'project.json');
  if (!fs.existsSync(file)) writeJson(file, { version: 1, id: randomUUID(), createdAt: now(), description: 'bzzy project knowledge. No credentials or private account tokens belong here.' });
  const constraints = path.join(session.projectRoot || session.cwd, '.bzzy', 'constraints.json');
  if (!fs.existsSync(constraints)) writeJson(constraints, { version: 1, constraints: session.contract?.constraints || [], scope: { allowedTargets: [], excludedTargets: [], allowedActions: [], excludedActions: [], accountReferences: [], cleanupObligations: [], ...session.contract?.scope } });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignore) || fs.readFileSync(ignore, 'utf8') === 'runtime/\n*.sqlite*\n') fs.writeFileSync(ignore, '*\n', { mode: 0o600 });
}
export function writeProjectRecord(session, kind, id, record) {
  if (session.role === 'executor' || session.role === 'reviewer' || session.policy?.mode === 'read-only') return;
  const dir = path.join(projectDirectory(session), kind); privateDir(dir);
  writeJson(path.join(dir, `${id}.json`), record);
  const ledger = path.join(projectDirectory(session), 'ledger'); privateDir(ledger);
  fs.appendFileSync(path.join(ledger, now().slice(0, 10) + '.jsonl'), JSON.stringify({ version: 1, id: randomUUID(), kind, recordId: id, sessionId: session.id,
    occurredAt: now(), sha256: digest(record), record }) + '\n', { mode: 0o600 });
}
function recordsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => /^[a-zA-Z0-9-]+\.json$/.test(file)).map(file => readJson(inside(dir, file)));
}
export function projectRecords(root, kind) { return recordsIn(path.join(root, '.bzzy', kind)); }
export function agentRecords(root, kind) {
  const dir = path.join(root, '.bzzy', 'agents');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).flatMap(e => recordsIn(inside(dir, e.name) + path.sep + kind).map(record => ({ ...record, agent: e.name })));
}
export function issue(session, input) {
  if (!['open', 'investigating', 'resolved', 'blocked', 'inconclusive', 'disproved'].includes(input.status || 'open') || !input.title?.trim()) throw new Error('Issue needs a title and valid status.');
  const id = input.id || randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid issue ID.');
  const previous = getRecord('issue', id) || projectRecords(session.projectRoot || session.cwd, 'issues').find(i => i.id === id);
  if (previous && (previous.project !== (session.projectRoot || session.cwd) || previous.agent !== session.agentNamespace)) throw new Error('Issue belongs to another project or agent ledger. Reference it in a new attributed issue.');
  const evidence = input.evidence || previous?.evidence || [];
  if (evidence.some(ref => !getRecord('artifact', ref))) throw new Error('Issue evidence must use recorded artifact IDs.');
  if (['resolved', 'disproved'].includes(input.status) && !evidence.length) throw new Error('Resolved or disproved issues need evidence.');
  const record = { ...previous, id, project: session.projectRoot || session.cwd, agent: session.agentNamespace, sessionId: session.id, title: input.title, status: input.status || 'open',
    details: input.details || '', evidence, resolution: input.resolution || '', createdAt: previous?.createdAt || now(), updatedAt: now() };
  putRecord('issue', id, record); writeProjectRecord(session, 'issues', id, record); return record;
}
export function projectContext(root) {
  const agentDir = path.join(root, '.bzzy', 'agents');
  const agents = fs.existsSync(agentDir) ? fs.readdirSync(agentDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
  return { project: readJson(path.join(root, '.bzzy', 'project.json'), null),
    constraints: readJson(path.join(root, '.bzzy', 'constraints.json'), null), agents,
    issues: [...projectRecords(root, 'issues'), ...agentRecords(root, 'issues')].filter(i => i.status !== 'resolved').slice(-30),
    notes: [...projectRecords(root, 'memory'), ...agentRecords(root, 'memory')].slice(-30),
    recentGoals: projectRecords(root, 'goals').sort((a, b) => (b.summary?.finishedAt || '').localeCompare(a.summary?.finishedAt || '')).slice(0, 5),
    checkpoints: projectRecords(root, 'checkpoints').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3) };
}
