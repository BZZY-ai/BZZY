import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const helper = fileURLToPath(new URL('../src/engine/definition-archive.py', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const harness = String.raw`
import ctypes, errno, io, json, os, runpy, stat, sys, types
def no_links(*args, **kwargs):
    raise AssertionError('Export must work without hard-link support')
os.link = no_links
if sys.argv[3] == 'fallback':
    def unavailable(*args):
        ctypes.set_errno(errno.ENOTSUP)
        return -1
    ctypes.CDLL = lambda *args, **kwargs: types.SimpleNamespace(renameatx_np=unavailable, renameat2=unavailable)
    original_sync = os.fsync
    def sync(fd):
        if stat.S_ISDIR(os.fstat(fd).st_mode):
            raise OSError(errno.EINVAL, 'Directory sync unavailable on this fixture filesystem')
        return original_sync(fd)
    os.fsync = sync
sys.stdin = io.StringIO(sys.argv[2])
runpy.run_path(sys.argv[1], run_name='__main__')
`;

for (const fallback of [false, true]) test(`ZIP publication preserves content and existing files without hard links${fallback ? ' or exclusive-rename support' : ''}`, () => {
  // All test archives stay in temporary storage; no user drive is touched.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-definition-publish-')));
  try {
    const source = path.join(directory, 'source'), output = path.join(directory, 'output');
    fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(output, { mode: 0o700 });
    const data = Buffer.from('{"fixture":"portable definitions"}\n'); fs.writeFileSync(path.join(source, 'manifest.json'), data);
    const stat = fs.statSync(output, { bigint: true });
    const spec = { operation: 'create', cwd: output, fingerprint: `${stat.dev}:${stat.ino}`, source, name: 'reviewed.zip',
      files: [{ path: 'manifest.json', bytes: data.length, sha256: sha256(data) }] };
    const run = () => spawnSync('python3', ['-I', '-c', harness, helper, JSON.stringify(spec), fallback ? 'fallback' : 'native'], {
      encoding: 'utf8', timeout: 10000,
    });
    const result = run(); assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout), file = path.join(output, spec.name), bytes = fs.readFileSync(file);
    const published = fs.statSync(file, { bigint: true });
    assert.equal(receipt.published, true); assert.equal(receipt.sha256, sha256(bytes)); assert.equal(receipt.bytes, bytes.length);
    assert.equal(receipt.device, String(published.dev)); assert.equal(receipt.inode, String(published.ino));
    assert.equal(bytes.subarray(0, 2).toString(), 'PK');
    assert.notEqual(run().status, 0, 'A repeated export must never replace the existing archive.');
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readdirSync(output), ['reviewed.zip'], 'Only the reviewed output remains after success and conflict.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
