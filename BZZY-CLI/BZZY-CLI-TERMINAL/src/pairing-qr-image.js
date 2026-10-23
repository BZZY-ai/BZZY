import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function openImage(file) {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'linux' ? 'xdg-open' : null;
  if (!command) return Promise.reject(new Error('QR_IMAGE_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, process.platform === 'darwin' ? ['-a', 'Preview', file] : [file], { stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('QR_IMAGE_UNAVAILABLE')); }, 5000);
    timer.unref();
    child.once('error', () => { clearTimeout(timer); reject(new Error('QR_IMAGE_UNAVAILABLE')); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('QR_IMAGE_UNAVAILABLE')); });
  });
}

// The image contains a live invitation. Keep it private and temporary, never
// under the project, chat history, exports or a predictable public filename.
export class PairingQRImage {
  #directory;
  #file;
  #generation = 0;
  constructor({ openFile = openImage, temporaryRoot = os.tmpdir() } = {}) {
    this.openFile = openFile; this.temporaryRoot = temporaryRoot;
  }
  async show(renderImage) {
    const generation = this.#generation;
    if (!this.#file) {
      const bytes = await renderImage();
      if (generation !== this.#generation) return false;
      if (!Buffer.isBuffer(bytes) || bytes.length > 4 * 1024 * 1024 || !bytes.subarray(0, 8).equals(pngSignature)) throw new Error('QR_IMAGE_UNAVAILABLE');
      this.#directory = fs.mkdtempSync(path.join(this.temporaryRoot, 'bzzy-pair-'));
      fs.chmodSync(this.#directory, 0o700);
      this.#file = path.join(this.#directory, 'pair.png');
      try { fs.writeFileSync(this.#file, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { this.clear(); throw error; }
    }
    try { await this.openFile(this.#file); }
    catch (error) { if (generation === this.#generation) this.clear(); throw error; }
    return generation === this.#generation;
  }
  clear() {
    this.#generation++;
    if (this.#directory) fs.rmSync(this.#directory, { recursive: true, force: true });
    this.#directory = undefined; this.#file = undefined;
  }
}
