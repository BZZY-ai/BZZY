import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PairingQRImage } from '../src/pairing-qr-image.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
function fixture(t, openFile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-qr-test-'));
  const image = new PairingQRImage({ temporaryRoot: root, openFile });
  t.after(() => { image.clear(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, image };
}

test('QR image stays in private temporary storage, reuses the same image, and clears it', async t => {
  const opened = [], { image, root } = fixture(t, async file => {
    opened.push(file);
    assert.deepEqual(fs.readFileSync(file), png);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });
  let renders = 0;
  const render = async () => { renders++; return png; };
  assert.equal(await image.show(render), true); assert.equal(await image.show(render), true);
  assert.equal(renders, 1); assert.equal(opened.length, 2); assert.equal(opened[0], opened[1]);
  image.clear(); assert.deepEqual(fs.readdirSync(root), []); assert.equal(fs.existsSync(opened[0]), false);
});

test('a late QR render cannot recreate an invitation image after clear', async t => {
  let finish, opened = false;
  const { image, root } = fixture(t, async () => { opened = true; });
  const rendering = image.show(() => new Promise(resolve => { finish = resolve; }));
  image.clear(); finish(png);
  assert.equal(await rendering, false); assert.equal(opened, false); assert.deepEqual(fs.readdirSync(root), []);
});

test('failed open removes the temporary image, and invalid image data never reaches an opener', async t => {
  let calls = 0;
  const { image, root } = fixture(t, async () => { calls++; throw new Error('fixture-opener-unavailable'); });
  await assert.rejects(image.show(async () => png)); assert.equal(calls, 1); assert.deepEqual(fs.readdirSync(root), []);
  for (const data of [Buffer.from('<svg>not a PNG</svg>'), 'fixture-private-code', Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    await assert.rejects(image.show(async () => data));
  }
  assert.equal(calls, 1); assert.deepEqual(fs.readdirSync(root), []);
});
