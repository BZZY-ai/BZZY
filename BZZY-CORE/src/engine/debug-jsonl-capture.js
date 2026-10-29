import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { assertShareText } from './share-bundle-policy.js';
import { debugExportFailure } from './debug-export-errors.js';

// JSONL has an explicit privacy boundary: one complete JSON value per line.
// Never scrub arbitrary byte chunks; bindings and reasoning may span chunks
// inside a value. The aggregate ledger can be large without retaining it in RAM.
export function captureDebugJsonl(source, destination, { scrub, secrets = [],
  maxRecordBytes = 64 * 1024 ** 2, validateSource = () => {}, onProgress } = {}) {
  let input, output, identity, sourceBytes = 0, bytes = 0;
  const sourceHash = createHash('sha256'), exportedHash = createHash('sha256');
  const sourceFailure = () => new Error('changed_or_unreadable_source');
  const readSource = operation => { try { return operation(); } catch { throw sourceFailure(); } };
  try {
    input = readSource(() => fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK));
    const before = readSource(() => fs.fstatSync(input, { bigint: true }));
    if (!before.isFile() || before.nlink !== 1n) throw sourceFailure();
    output = fs.openSync(destination, 'wx', 0o600);
    identity = fs.fstatSync(output);
    let parts = [], length = 0, tail = '';
    const tailLength = secrets.reduce((longest, secret) => Math.max(longest, secret.length - 1), 0);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const append = data => {
      length += data.length;
      if (length > maxRecordBytes) throw debugExportFailure('SESSION_DEBUG_SOURCE_SIZE');
      if (data.length) parts.push(data);
    };
    const flush = newline => {
      const raw = parts.length === 1 ? parts[0] : Buffer.concat(parts, length);
      let text;
      try { text = decoder.decode(raw); } catch { throw new Error('unparseable_structured_data'); }
      const clean = (text.trim() ? JSON.stringify(scrub(JSON.parse(text))) : '') + (newline ? '\n' : '');
      // Known bindings can contain newlines. Preserve the same whole-output
      // rejection across record boundaries, without storing the whole ledger.
      assertShareText(tail + clean, secrets);
      if (tailLength) tail = (tail + clean).slice(-tailLength);
      const data = Buffer.from(clean);
      let offset = 0;
      while (offset < data.length) offset += fs.writeSync(output, data, offset);
      exportedHash.update(data); bytes += data.length;
      parts = []; length = 0;
    };
    while (BigInt(sourceBytes) < before.size) {
      // Parts may retain this buffer until their logical record is complete.
      const buffer = Buffer.allocUnsafe(64 * 1024);
      // Capture a fixed source boundary. A busy append-only ledger must not
      // extend this export indefinitely; the final stat detects any change.
      const remaining = before.size - BigInt(sourceBytes);
      const size = remaining < BigInt(buffer.length) ? Number(remaining) : buffer.length;
      const count = readSource(() => fs.readSync(input, buffer, 0, size, null));
      if (!count) break;
      const data = buffer.subarray(0, count);
      sourceHash.update(data); sourceBytes += count;
      let offset = 0, newline;
      while ((newline = data.indexOf(10, offset)) !== -1) {
        append(data.subarray(offset, newline)); flush(true); offset = newline + 1;
      }
      append(data.subarray(offset));
      try { onProgress?.({ sourceBytes, bytes }); } catch { /* Display cannot alter capture. */ }
    }
    if (length) flush(false);
    const after = readSource(() => fs.fstatSync(input, { bigint: true }));
    if (BigInt(sourceBytes) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
        || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n) throw sourceFailure();
    readSource(validateSource);
    fs.fsyncSync(output);
    fs.closeSync(output); output = undefined;
    const sourceSha256 = sourceHash.digest('hex'), sha256 = exportedHash.digest('hex');
    return { bytes, sourceBytes, sha256, sourceSha256, encoding: 'jsonl', redacted: sha256 !== sourceSha256 };
  } catch (error) {
    if (output !== undefined) { try { fs.closeSync(output); } catch { /* Preserve original failure. */ } output = undefined; }
    if (identity) {
      try {
        const current = fs.lstatSync(destination);
        if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(destination);
      } catch { /* The enclosing private staging cleanup is also authoritative. */ }
    }
    throw error;
  } finally {
    if (input !== undefined) fs.closeSync(input);
  }
}
