import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { initializeProject } from '../src/engine/project.js';
import { database, appendEvent } from '../src/engine/database.js';
import { exportFullSessionDebugInWorker } from '../src/engine/session-full-debug.js';

// Opt in because private staging uses over 4 GiB of disk even though the
// repetitive fixture compresses well. Tests the actual source/capture path,
// not mocked counters. It does not claim a compressed ZIP larger than 4 GiB.
test('complete export captures and verifies an individual project file larger than 4 GiB',
  { skip: process.env.BZZY_TEST_LARGE_DEBUG !== '1' }, async t => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-large-debug-')));
    const previousHome = process.env.BZZY_HOME;
    try {
      process.env.BZZY_HOME = path.join(directory, 'private');
      const project = path.join(directory, 'project'); fs.mkdirSync(project);
      const session = createSession(getProvider('deepseek'), project, 'offline-fixture', 'large-capture'); initializeProject(session);
      appendEvent(session.id, 'text', { text: 'COMPLETE_LARGE_CAPTURE_HISTORY' });
      const count = 1, fileBytes = 4 * 1024 ** 3 + 32 * 1024 ** 2;
      for (let index = 0; index < count; index++) {
        const file = path.join(project, `source-${String(index).padStart(3, '0')}.bin`);
        fs.closeSync(fs.openSync(file, 'wx')); fs.truncateSync(file, fileBytes);
      }
      const state = () => ({ records: database().prepare('SELECT * FROM records ORDER BY kind,id').all(),
        events: database().prepare('SELECT * FROM events ORDER BY seq').all() });
      const before = state(), result = await exportFullSessionDebugInWorker(session.id);
      assert.equal(result.captureMode, 'complete'); assert.equal(result.contextLimited, false);
      assert.equal(result.contextCapture.limitBytes, null);
      assert.ok(result.contextCapture.capturedBytes >= count * fileBytes);
      assert.ok(result.uncompressedBytes > 4 * 1024 ** 3); assert.deepEqual(state(), before);
      const verification = spawnSync('python3', ['-c', `import sys, json, zipfile, hashlib
with zipfile.ZipFile(sys.argv[1]) as archive:
    manifest = json.loads(archive.read('manifest.json'))
    assert manifest['captureMode'] == 'complete' and not manifest['contextLimited']
    entries = [row for row in manifest['inventory'] if row['path'].startswith('workspace/source-')]
    assert len(entries) == 1
    for entry in entries:
        digest, size = hashlib.sha256(), 0
        with archive.open(entry['path']) as source:
            while block := source.read(1024 * 1024): digest.update(block); size += len(block)
        assert size == 4 * 1024 ** 3 + 32 * 1024 ** 2
        assert entry['capture'] == 'disk-backed'
        assert entry['bytes'] == size and entry['sourceBytes'] == size
        assert digest.hexdigest() == entry['sha256'] == entry['sourceSha256']
    assert sum(entry.file_size for entry in archive.infolist()) == int(sys.argv[2])
    assert not any('.file-capture-' in name or name.startswith('.manifest-') or name.startswith('.large-capture-') for name in archive.namelist())
    assert 'COMPLETE_LARGE_CAPTURE_HISTORY' in archive.read('session/messages.jsonl').decode()
print('Single file over 4 GiB: source/export hash and ZIP CRC verified.')`, result.outputPath, String(result.uncompressedBytes)],
      { encoding: 'utf8', maxBuffer: 4096 });
      assert.equal(verification.status, 0, verification.stderr);
      assert.deepEqual(fs.readdirSync(path.join(process.env.BZZY_HOME, 'debug-exports')), []);
      t.diagnostic(`${result.contextCapture.capturedBytes} project bytes; ${result.uncompressedBytes} captured bytes; ${result.bytes} ZIP bytes. ${verification.stdout.trim()}`);
    } finally {
      if (previousHome === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
