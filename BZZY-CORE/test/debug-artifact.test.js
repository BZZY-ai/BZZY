import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { recognizedDebugArtifact } from '../src/engine/debug-artifact.js';
import { workspaceManifest, snapshotWorkspace, copyWorkspaceSnapshot, inspectWorkspace } from '../src/engine/evidence.js';
import { digest, getRecord, events, putRecord } from '../src/engine/database.js';
import { createSession, saveSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { exportSessionDebug } from '../src/engine/session-debug.js';
import { exportFullSessionDebug } from '../src/engine/session-full-debug.js';

let root, project, previous, session;
const MiB = 1024 * 1024;
test.beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debug-artifact-')));
  previous = process.env.BZZY_HOME; process.env.BZZY_HOME = path.join(root, 'private');
  project = path.join(root, 'project'); fs.mkdirSync(project);
  session = createSession(getProvider('codex'), project, 'offline-fixture'); session.alias = 'diagnostic-test'; saveSession(session);
  fs.writeFileSync(path.join(project, 'source.js'), 'export const fixed = true;\n', { mode: 0o600 });
});
test.afterEach(() => { if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(root, { recursive: true, force: true }); });
function report(file, { sessionId = randomUUID(), cutoffSeq = 123, complete = true, padding = 0 } = {}) {
  const prefix = `# Session debug — Historical fixture\n\n## Session and goal snapshots\n\n\x60\x60\x60jsonl\n${JSON.stringify({ kind: 'manifest', format: 'bzzy-session-debug', version: 1, sessionId, cutoffSeq })}\n\x60\x60\x60\n`;
  fs.writeFileSync(file, prefix, { mode: 0o600 });
  const fd = fs.openSync(file, 'a');
  try { for (let bytes = 0; bytes < padding; bytes += MiB) fs.writeSync(fd, Buffer.alloc(Math.min(MiB, padding - bytes), 32)); }
  finally { fs.closeSync(fd); }
  if (complete) fs.appendFileSync(file, `\n## Export coverage\n\n\x60\x60\x60jsonl\n${JSON.stringify({ kind: 'summary', complete: true, sessionId, cutoffSeq })}\n\x60\x60\x60\n`);
  return file;
}
const zipFixture = String.raw`
import sys,json,zipfile,stat,os,hashlib
destination,spec=sys.argv[1],json.loads(sys.argv[2])
inventory=[]
files={'README_FIRST.txt':b'BZZY FULL DEBUG EXPORT\nHistorical offline fixture.\n','GUIDE_TO_BZZY_DEBUGGER.txt':b'Read historical data only.\n','overview.md':b'# Historical overview\n','session/records.jsonl':b'','session/events.jsonl':b'','session/messages.jsonl':b''}
def info(name):
 i=zipfile.ZipInfo(name);i.compress_type=zipfile.ZIP_DEFLATED;i.create_system=3;i.external_attr=(stat.S_IFREG|0o600)<<16
 if spec.get('unsafe')=='symlink' and name=='README_FIRST.txt': i.external_attr=(stat.S_IFLNK|0o777)<<16
 if spec.get('unsafe')=='executable' and name=='README_FIRST.txt': i.external_attr=(stat.S_IFREG|0o700)<<16
 return i
with zipfile.ZipFile(destination,'w',allowZip64=True) as z:
 for name,data in files.items():
  with z.open(info(name),'w',force_zip64=True) as out: out.write(data)
  inventory.append({'path':name,'bytes':len(data),**({} if name=='overview.md' else {'sha256':hashlib.sha256(data).hexdigest()})})
 if spec.get('large'):
  size=spec['large'];h=hashlib.sha256()
  with z.open(info('workspace/diagnostic-data.bin'),'w',force_zip64=True) as out:
   for offset in range(0,size,1024*1024):
    data=os.urandom(min(1024*1024,size-offset));out.write(data);h.update(data)
  inventory.append({'path':'workspace/diagnostic-data.bin','bytes':size,'sha256':h.hexdigest()})
 if spec.get('unsafe')=='traversal':
  with z.open(info('../source.js'),'w',force_zip64=True) as out: out.write(b'not diagnostic')
  inventory.append({'path':'../source.js','bytes':14})
 manifest={'format':'bzzy-full-session-debug','version':1,'sessionId':spec['sessionId'],'cutoffSeq':123,'complete':True,'inventory':inventory,'uncompressedBytes':sum(i['bytes'] for i in inventory),'overview':{'path':'overview.md','bounded':True}}
 if spec.get('unsafe')=='inventory':manifest['inventory'][0]['bytes']+=1
 if spec.get('unsafe')=='incomplete':manifest['complete']=False
 data=json.dumps(manifest).encode()
 if spec.get('unsafe')=='manifest_limit':data=b' '*(17*1024*1024)+data
 with z.open(info('manifest.json'),'w',force_zip64=True) as out:out.write(data)
 if spec.get('unsafe')=='duplicate':z.writestr(info('session/events.jsonl'),b'')
os.chmod(destination,0o600)
`;
function zip(name = 'archive.bin', options = {}) {
  const file = path.join(project, name);
  const result = spawnSync('python3', ['-c', zipFixture, file, JSON.stringify({ sessionId: session.id, ...options })], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return file;
}

test('recognition uses report content and completed boundaries, never a debug filename', () => {
  const actual = exportSessionDebug(session.id, { cwd: project, output: 'reference.md' });
  const renamed = path.join(project, 'renamed-reference.dat'); fs.renameSync(actual.outputPath, renamed);
  assert.equal(recognizedDebugArtifact(renamed).format, 'bzzy-session-debug');
  const historical = report(path.join(project, 'historical.txt')); assert.equal(recognizedDebugArtifact(historical).cutoffSeq, 123);
  const misleading = path.join(project, 'session_full_debug_27102026.zip'); fs.writeFileSync(misleading, 'ordinary source or archive name');
  const incomplete = report(path.join(project, 'incomplete.md'), { complete: false });
  assert.equal(recognizedDebugArtifact(misleading), null); assert.equal(recognizedDebugArtifact(incomplete), null);
  fs.appendFileSync(historical, 'export const unrelated = true;\n'); assert.equal(recognizedDebugArtifact(historical), null, 'Trailing source invalidates completion, including the positive cache.');
});

test('real full exports and historical ZIP64-local packages have consistent completed manifests', async () => {
  const before = getRecord('session', session.id);
  const actual = await exportFullSessionDebug(session.id, { cwd: project, output: 'diagnostics.dat.zip' });
  assert.equal(recognizedDebugArtifact(actual.outputPath).format, 'bzzy-full-session-debug');
  assert.deepEqual(getRecord('session', session.id), before, 'Classification and read-only export do not rewrite source session state.');
  assert.equal(recognizedDebugArtifact(zip('historical-no-registration.bin')).sessionId, session.id);
});

test('large complete debug artifacts are omitted before source limits, without reading whole payloads or worker copying', () => {
  const archive = zip('renamed-full.zip', { large: 24 * MiB }); assert.ok(fs.statSync(archive).size > 20 * MiB);
  report(path.join(project, 'large-report.txt'), { padding: 21 * MiB });
  const original = fs.readSync; let readBytes = 0;
  fs.readSync = (...args) => { const count = original(...args); readBytes += count; return count; };
  let snapshot;
  try { snapshot = snapshotWorkspace(session); }
  finally { fs.readSync = original; }
  assert.ok(readBytes < MiB, `Only bounded metadata should be read; observed ${readBytes} bytes.`);
  assert.deepEqual(Object.keys(snapshot.manifest), ['source.js']); assert.equal(snapshot.omissions.length, 2);
  assert.ok(snapshot.omissions.every(item => item.reason === 'bzzy_debug_artifact' && item.manifestSha256.length === 64));
  assert.equal(getRecord('snapshot', snapshot.id).omissions.length, 2);
  assert.equal(events(session.id).find(event => event.type === 'snapshot').data.omissions.length, 2);
  const worker = path.join(root, 'worker'); copyWorkspaceSnapshot(snapshot, worker);
  assert.deepEqual(fs.readdirSync(worker), ['source.js']);
  const changes = inspectWorkspace(snapshot, project); assert.deepEqual(changes, []); assert.equal(changes.omissions.length, 4);
  assert.deepEqual(inspectWorkspace(snapshot, worker), []);
});

test('regular source, ordinary large ZIPs and misleading names retain source limits and diff visibility', () => {
  fs.writeFileSync(path.join(project, 'task_full_debug_27102026.zip'), 'actual task input');
  const snapshot = snapshotWorkspace(session);
  assert.ok(snapshot.manifest['task_full_debug_27102026.zip']);
  fs.appendFileSync(path.join(project, 'task_full_debug_27102026.zip'), ' changed');
  assert.equal(inspectWorkspace(snapshot, project)[0].path, 'task_full_debug_27102026.zip');
  const large = path.join(project, 'ordinary.zip'), fd = fs.openSync(large, 'w', 0o600); fs.ftruncateSync(fd, 21 * MiB); fs.closeSync(fd);
  fs.writeFileSync(path.join(process.env.BZZY_HOME, 'config.json'), JSON.stringify({ snapshotLimits: { maxFileMiB: 20 } }));
  const omissions = [], manifest = workspaceManifest(project, undefined, { omissions });
  assert.equal(manifest['ordinary.zip'], undefined);
  assert.ok(manifest['source.js']);
  assert.ok(omissions.some(item => item.path === 'ordinary.zip' && item.reason === 'snapshot_limit'));
});

test('old snapshots containing exports do not manufacture worker deletions and replacement source is visible', () => {
  const artifact = report(path.join(project, 'prior-debug.txt'));
  const directory = path.join(root, 'old-snapshot'); fs.mkdirSync(directory); fs.copyFileSync(artifact, path.join(directory, 'prior-debug.txt'));
  const old = { directory, manifest: { 'prior-debug.txt': { size: fs.statSync(artifact).size, sha256: digest(fs.readFileSync(artifact)) } } };
  const worker = path.join(root, 'legacy-worker'), copied = copyWorkspaceSnapshot({ ...old, id: 'legacy-fixture' }, worker, { sessionId: session.id });
  assert.deepEqual(fs.readdirSync(worker), []); assert.equal(copied.omissions[0].phase, 'copy-source');
  assert.equal(events(session.id).find(event => event.type === 'snapshot.copy').data.omissions.length, 1);
  fs.unlinkSync(artifact); fs.unlinkSync(path.join(project, 'source.js'));
  const missing = inspectWorkspace(old, project); assert.deepEqual(missing, []); assert.equal(missing.omissions[0].phase, 'baseline');
  fs.writeFileSync(artifact, 'export const actualSource = true;\n');
  const changes = inspectWorkspace(old, project); assert.equal(changes.length, 1); assert.equal(changes[0].before, null); assert.ok(changes[0].after);
});

test('changed omission paths never become permanent filename exclusions', () => {
  const artifact = report(path.join(project, 'report.md')), snapshot = snapshotWorkspace(session);
  fs.writeFileSync(artifact, '# Project documentation\nAn ordinary task file.\n');
  const changes = inspectWorkspace(snapshot, project); assert.equal(changes.length, 1); assert.equal(changes[0].path, 'report.md'); assert.equal(changes[0].before, null);
  assert.ok(workspaceManifest(project)['report.md']);
});

test('copied data mode bits are recorded while executable prefixes, hardlinks and symlinks cannot gain omission', () => {
  const copied = report(path.join(project, 'copied.md')); fs.chmodSync(copied, 0o700);
  assert.equal(recognizedDebugArtifact(copied).outerMode, 0o700); assert.equal(workspaceManifest(project)['copied.md'], undefined);
  const executable = path.join(project, 'program.sh'); fs.writeFileSync(executable, '#!/bin/sh\necho ordinary program\n', { mode: 0o700 });
  assert.equal(recognizedDebugArtifact(executable), null); assert.ok(workspaceManifest(project)['program.sh']);
  const linked = report(path.join(project, 'hardlink.md')); fs.linkSync(linked, path.join(project, 'linked.md'));
  assert.equal(recognizedDebugArtifact(linked), null);
  const regular = report(path.join(root, 'outside-report.md')), link = path.join(project, 'link.md'); fs.symlinkSync(regular, link);
  assert.equal(recognizedDebugArtifact(link), null);
});

test('unsafe, incomplete, malformed or oversized ZIP metadata is not an omission authority', () => {
  for (const unsafe of ['symlink', 'executable', 'traversal', 'inventory', 'incomplete', 'duplicate', 'manifest_limit']) {
    assert.equal(recognizedDebugArtifact(zip(`${unsafe}.zip`, { unsafe })), null, unsafe);
  }
  const archive = zip('valid.zip'), original = fs.readFileSync(archive);
  const centralOffset = original.readUInt32LE(original.length - 6), inserted = Buffer.from('#!/bin/sh\nhidden executable payload\n');
  const withGap = Buffer.concat([original.subarray(0, centralOffset), inserted, original.subarray(centralOffset)]);
  withGap.writeUInt32LE(centralOffset + inserted.length, withGap.length - 6);
  for (const [name, data] of [['truncated.zip', original.subarray(0, original.length - 8)], ['appended.zip', Buffer.concat([original, Buffer.from('hidden source')])],
    ['executable-prefix.zip', Buffer.concat([Buffer.from('#!/bin/sh\n'), original])], ['inserted-payload.zip', withGap]]) {
    const file = path.join(project, name); fs.writeFileSync(file, data, { mode: 0o600 }); assert.equal(recognizedDebugArtifact(file), null, name);
  }
});
