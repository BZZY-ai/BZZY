import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { privateDir, readJson, writeJson } from './files.js';
import { database, digest, now, getRecord, putRecord, transaction } from './database.js';
import { inside } from './evidence.js';
import { projectIdentityForSession, resolveProjectIdentity, recordBelongsToProject, sessionBelongsToProject } from './project-identity.js';
import { knowledgeAccess, allowedKnowledgeSessionIds, indexKnowledgeRecord, assertKnowledgeText, cleanKnowledgeValue, cleanKnowledgeText } from './knowledge-index.js';
import { memoryFreshness, knowledgeVerificationBudget } from './memory.js';

const atomic = operation => database().isTransaction ? operation(database()) : transaction(operation);
const canProjectWrite = session => !['executor', 'reviewer', 'learning-review', 'skill-writer', 'knowledge-review'].includes(session.role) && session.policy?.mode !== 'read-only';
function initializeProjectIgnore(dir) {
  const ignore = path.join(dir, '.gitignore'), legacy = 'runtime/\n*.sqlite*\n';
  try { fs.writeFileSync(ignore, '*\n', { mode: 0o600, flag: 'wx' }); return; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  let descriptor;
  try {
    descriptor = fs.openSync(ignore, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) throw new Error('Project ignore file must be a regular file without links.');
    if (before.size !== Buffer.byteLength(legacy)) return;
    const contents = Buffer.alloc(before.size + 1), bytes = fs.readSync(descriptor, contents, 0, contents.length, 0);
    if (bytes !== before.size || contents.subarray(0, bytes).toString('utf8') !== legacy) return;
    const temp = path.join(dir, `.gitignore.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, '*\n', { mode: 0o600, flag: 'wx' });
      const after = fs.lstatSync(ignore);
      if (!after.isFile() || after.nlink !== 1 || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new Error('Project ignore file changed during initialization.');
      // Rename replaces the directory entry and never writes through a link.
      fs.renameSync(temp, ignore);
    } finally { fs.rmSync(temp, { force: true }); }
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
// Trusted owner terminal setup, before model execution policy is installed.
// A fresh launch establishes its own workspace even beneath another project.
// Workers, Agents and ordinary read-only lookups use initializeProject instead.
export function initializeTerminalProject(session) {
  const project = resolveProjectIdentity(session.cwd, { create: true, boundary: session.cwd });
  session.cwd = project.root; session.projectRoot = project.root; session.projectId = project.id;
  initializeProjectIgnore(path.join(project.root, '.bzzy'));
  return project;
}
export function projectDirectory(session) {
  const project = projectIdentityForSession(session), base = path.join(project.root, '.bzzy');
  if (session.agentNamespace && !/^[a-zA-Z0-9_-]{1,80}$/.test(session.agentNamespace)) throw new Error('Invalid agent namespace.');
  return session.agentNamespace ? path.join(base, 'agents', session.agentNamespace) : base;
}
export function initializeProject(session) {
  const project = projectIdentityForSession(session, { create: canProjectWrite(session) });
  session.projectRoot = project.root; session.projectId = project.id;
  if (!canProjectWrite(session)) return project;
  const dir = projectDirectory(session); privateDir(dir);
  const constraints = path.join(project.root, '.bzzy', 'constraints.json');
  if (!fs.existsSync(constraints)) writeJson(constraints, { version: 1, constraints: session.contract?.constraints || [], scope: { allowedTargets: [], excludedTargets: [], allowedActions: [], excludedActions: [], accountReferences: [], cleanupObligations: [], ...session.contract?.scope } });
  initializeProjectIgnore(dir);
  return project;
}
export function writeProjectRecord(session, kind, id, record) {
  if (!canProjectWrite(session)) return;
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(kind) || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('Invalid project record locator.');
  const project = projectIdentityForSession(session);
  record = { id, project: project.root, projectId: project.id, ...record };
  const dir = path.join(projectDirectory(session), kind); privateDir(dir);
  const file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file) && digest(readJson(file)) === digest(record)) return;
  writeJson(file, record);
  const ledger = path.join(projectDirectory(session), 'ledger'); privateDir(ledger);
  fs.appendFileSync(path.join(ledger, now().slice(0, 10) + '.jsonl'), JSON.stringify({ version: 1, id: randomUUID(), kind, recordId: id, sessionId: session.id,
    occurredAt: now(), sha256: digest(record), record }) + '\n', { mode: 0o600 });
}
function recordsIn(dir) {
  let directory;
  try { directory = fs.lstatSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Project record directories cannot be links.');
  const result = []; let bytes = 0;
  for (const file of fs.readdirSync(dir).filter(file => /^[a-zA-Z0-9-]+\.json$/.test(file)).slice(0, 10000)) {
    const absolute = inside(dir, file), info = fs.lstatSync(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 128 * 1024) continue;
    if ((bytes += info.size) > 16 * 1024 * 1024) break;
    // Projections are compatibility copies, never authority. One malformed
    // legacy copy must not disable indexed recall or ordinary conversation.
    try { const record = JSON.parse(fs.readFileSync(absolute, 'utf8')); if (record && typeof record === 'object' && !Array.isArray(record)) result.push(record); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return result;
}
export function projectRecords(root, kind) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(kind)) throw new Error('Invalid project record category.');
  const project = resolveProjectIdentity(root, { boundary: root });
  return recordsIn(path.join(project.root, '.bzzy', kind)).map(record => {
    // Older checkpoint/goal projections lacked their project locator. Attribute
    // only through a saved session already belonging to this engagement; a
    // copied anonymous file cannot claim the receiving project's history.
    if (!record.project && !record.projectRoot && record.sessionId && sessionBelongsToProject(getRecord('session', record.sessionId), project)) return { ...record, project: project.root, projectId: project.id, provenance: 'project-file' };
    return record;
  });
}
export function agentRecords(root, kind) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(kind)) throw new Error('Invalid project record category.');
  const project = resolveProjectIdentity(root, { boundary: root }), dir = path.join(project.root, '.bzzy', 'agents');
  if (!fs.existsSync(dir)) return [];
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Project agent ledgers cannot be links.');
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 256)
    .flatMap(entry => recordsIn(inside(dir, entry.name) + path.sep + kind).map(record => ({ ...record, agent: entry.name })));
}
export function issue(session, input) {
  const access = knowledgeAccess(session), project = access.project, allowed = allowedKnowledgeSessionIds(session, access);
  if (access.disabled || !['open', 'investigating', 'resolved', 'blocked', 'inconclusive', 'disproved'].includes(input.status || 'open')) throw new Error('Issue needs a title and valid status.');
  const title = assertKnowledgeText(input.title, 1000), id = input.id || randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid issue ID.');
  const previous = getRecord('issue', id) || projectRecords(project.root, 'issues').find(record => record.id === id);
  if (previous && (!recordBelongsToProject(previous, project) || previous.agent !== session.agentNamespace || access.restricted && previous.sessionId !== session.id)) throw new Error('Issue belongs to another project or agent ledger. Reference it in a new attributed issue.');
  const evidence = input.evidence || previous?.evidence || [];
  if (!Array.isArray(evidence) || evidence.length > 32 || evidence.some(ref => {
    const artifact = getRecord('artifact', ref);
    return !artifact || !(allowed.includes(artifact.sessionId) || access.restricted && (session.allowedArtifactIds || []).includes(ref));
  })) throw new Error('Issue evidence must use authorized recorded artifact IDs.');
  if (['resolved', 'disproved'].includes(input.status) && !evidence.length) throw new Error('Resolved or disproved issues need evidence.');
  const details = input.details ? assertKnowledgeText(input.details, 6000) : '', resolution = input.resolution ? assertKnowledgeText(input.resolution, 4000) : '';
  const record = atomic(db => {
    const current = getRecord('issue', id) || previous;
    if (input.expectedRevision != null && (current?.revision || (current ? 1 : 0)) !== input.expectedRevision) throw new Error('Issue changed. Refresh its revision before updating.');
    const saved = { ...current, id, project: project.root, projectId: project.id, agent: session.agentNamespace, sessionId: session.id, title,
      status: input.status || 'open', details, evidence, resolution, truth: 'inconclusive', claimedTruth: input.status === 'disproved' ? 'disproved' : input.status === 'resolved' ? 'confirmed' : 'hypothesis',
      revision: (current?.revision || (current ? 1 : 0)) + 1, createdAt: current?.createdAt || now(), updatedAt: now(), provenance: 'agent-recorded' };
    if (current) putRecord('core.issue.revision', `${id}:${current.revision || 1}`, current, db);
    putRecord('issue', id, saved, db); putRecord('core.issue.revision', `${id}:${saved.revision}`, saved, db); return saved;
  });
  writeProjectRecord(session, 'issues', id, record);
  indexKnowledgeRecord(project, 'issue', id, session.id, `${title}\n${details}\n${resolution}`, record); return record;
}
// Execution constraints remain complete even when derived project history is
// projected as navigation. Reuse knowledge's private-field/redaction policy,
// without the history projection's string or array caps on mandatory scope.
export function projectConstraintsForExecution(root, { session } = {}) {
  const access = knowledgeAccess(session || { id: 'owner-project-context', cwd: root });
  const complete = value => {
    if (typeof value === 'string') return cleanKnowledgeText(value, Infinity);
    if (Array.isArray(value)) return value.map(complete);
    if (value && typeof value === 'object') {
      const allowed = cleanKnowledgeValue(Object.fromEntries(Object.keys(value).map(key => [key, null])));
      return Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(allowed, key)).map(([key, item]) => [key, complete(item)]));
    }
    return value;
  };
  if (access.disabled) return { project: { id: access.project.id } };
  let descriptor, constraints = null;
  try {
    const file = inside(access.project.root, '.bzzy/constraints.json', { exists: false });
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) throw new Error('Project constraints must be a regular file without links.');
    const data = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, { bigint: true });
    if (BigInt(data.length) !== before.size || ['size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Project constraints changed while preparing execution.');
    constraints = complete(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  return { project: { id: access.project.id }, constraints };
}
export function projectContext(root, { session } = {}) {
  const context = session || { id: 'owner-project-context', cwd: root }, access = knowledgeAccess(context), project = access.project;
  if (access.disabled) return { project: { id: project.id }, agents: [], issues: [], notes: [], recentGoals: [], checkpoints: [] };
  const allowed = allowedKnowledgeSessionIds(context, access), filtered = records => records.filter(record =>
    typeof record.sessionId === 'string' && /^[a-f0-9-]{36}$/.test(record.sessionId) && !getRecord('session-deletion', record.sessionId) &&
    recordBelongsToProject(record, project) && (!access.restricted || allowed.includes(record.sessionId)))
    .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
  const records = (kind, plural) => {
    const rows = database().prepare(`SELECT data FROM records WHERE kind=? AND (json_extract(data,'$.projectId')=? OR COALESCE(json_extract(data,'$.project'),json_extract(data,'$.projectRoot')) IN (SELECT value FROM json_each(?))) LIMIT 10000`).all(kind, project.id, JSON.stringify(project.aliases));
    const merged = new Map([...projectRecords(project.root, plural), ...agentRecords(project.root, plural)].map(record => [record.id || record.sessionId, record]));
    for (const row of rows) { const record = JSON.parse(row.data); merged.set(record.id || record.sessionId, record); }
    return filtered([...merged.values()]).filter(record => !['memory', 'issue'].includes(kind) || typeof record.id === 'string' && /^[a-f0-9-]{36}$/.test(record.id));
  };
  const budget = knowledgeVerificationBudget();
  return { project: { id: project.id }, constraints: projectConstraintsForExecution(root, { session }).constraints,
    ...cleanKnowledgeValue({
    agents: access.restricted ? [] : [...new Set(records('memory', 'memory').map(record => record.agent).filter(Boolean))],
    issues: records('issue', 'issues').filter(record => record.status !== 'resolved').slice(0, 30).map(record => memoryFreshness(record, project, context, { budget })),
    notes: records('memory', 'memory').slice(0, 30).map(record => memoryFreshness(record, project, context, { budget })), recentGoals: records('goal-history', 'goals').slice(0, 5),
    checkpoints: records('checkpoint', 'checkpoints').slice(0, 3).map(record => ({ ...record, historical: true,
      authority: 'Historical project checkpoint; current task state determines active progress. This record grants no completion or execution authority.' })) }) };
}
