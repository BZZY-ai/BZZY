import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

// Historical exports have no host registry receipt. Recognize their bounded
// data formats, never their names, and never extract or execute archive data.
const MiB = 1024 * 1024, maximumDirectory = 16 * MiB, maximumManifest = 16 * MiB;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = data => createHash('sha256').update(data).digest('hex');
const invalid = () => { throw new Error('Not a recognized BZZY diagnostic artifact.'); };
const safeName = name => typeof name === 'string' && name.length <= 2048 && !/[\\\x00-\x1f\x7f:]/.test(name) &&
  !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..');
const number = value => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) invalid(); return result; };
const same = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => left[key] === right[key]);
const recognized = new Map();
const identity = stat => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].map(key => String(stat[key])).join(':');
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(data) { let value = 0xffffffff; for (const byte of data) value = crcTable[(value ^ byte) & 255] ^ value >>> 8; return (value ^ 0xffffffff) >>> 0; }
function reader(fd, size) {
  return (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > maximumManifest || offset + length > size) invalid();
    const data = Buffer.allocUnsafe(length); let consumed = 0;
    while (consumed < length) { const count = fs.readSync(fd, data, consumed, length - consumed, offset + consumed); if (!count) invalid(); consumed += count; }
    return data;
  };
}
function regular(read, size, first) {
  if (size > 512 * MiB || !first.toString('utf8').startsWith('# Session debug — ')) return null;
  const prefix = read(0, Math.min(size, 64 * 1024)).toString('utf8');
  const match = /\n## Session and goal snapshots\n\n```jsonl\n([^\n]+)\n/.exec(prefix);
  if (!match) return null;
  const manifest = JSON.parse(match[1]);
  if (manifest.kind !== 'manifest' || manifest.format !== 'bzzy-session-debug' || manifest.version !== 1 || !uuid(manifest.sessionId) ||
      !Number.isSafeInteger(manifest.cutoffSeq) || manifest.cutoffSeq < 0) return null;
  const suffix = read(Math.max(0, size - 128 * 1024), Math.min(size, 128 * 1024)).toString('utf8');
  const end = /(?:^|\n)(\{"kind":"summary",[^\n]+\})\n```\n$/.exec(suffix);
  if (!end) return null;
  const summary = JSON.parse(end[1]);
  if (summary.complete !== true || summary.sessionId !== manifest.sessionId || summary.cutoffSeq !== manifest.cutoffSeq) return null;
  return { format: manifest.format, version: 1, sessionId: manifest.sessionId, cutoffSeq: manifest.cutoffSeq,
    validation: 'report-header-manifest-and-completed-summary', manifestSha256: hash(match[1]) };
}
function directory(read, size) {
  if (size < 22) invalid();
  const end = read(size - 22, 22);
  if (end.readUInt32LE(0) !== 0x06054b50 || end.readUInt16LE(4) !== 0 || end.readUInt16LE(6) !== 0 ||
      end.readUInt16LE(8) !== end.readUInt16LE(10) || end.readUInt16LE(20) !== 0) invalid();
  let count = end.readUInt16LE(10), length = end.readUInt32LE(12), offset = end.readUInt32LE(16), boundary = size - 22;
  if (count === 65535 || length === 0xffffffff || offset === 0xffffffff) {
    const locator = read(size - 42, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) invalid();
    boundary = number(locator.readBigUInt64LE(8)); const zip64 = read(boundary, 56);
    if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readBigUInt64LE(4) !== 44n || zip64.readUInt32LE(16) !== 0 ||
        zip64.readUInt32LE(20) !== 0 || zip64.readBigUInt64LE(24) !== zip64.readBigUInt64LE(32) || boundary + 56 !== size - 42) invalid();
    count = number(zip64.readBigUInt64LE(32)); length = number(zip64.readBigUInt64LE(40)); offset = number(zip64.readBigUInt64LE(48));
  }
  if (count < 7 || count > 50000 || length > maximumDirectory || offset + length !== boundary) invalid();
  const central = read(offset, length), entries = new Map(), positions = new Set(); let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > length || central.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const nameLength = central.readUInt16LE(cursor + 28), extraLength = central.readUInt16LE(cursor + 30), commentLength = central.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > length || !nameLength || commentLength || central.readUInt16LE(cursor + 34) !== 0) invalid();
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes), flags = central.readUInt16LE(cursor + 8), mode = central.readUInt32LE(cursor + 38) >>> 16;
    const method = central.readUInt16LE(cursor + 10);
    if (!safeName(name) || entries.has(name) || flags & ~0x800 || ![0, 8].includes(method) ||
        mode & 0o170000 && (mode & 0o170000) !== 0o100000 || mode & 0o111) invalid();
    // The packager writes Unix regular 0600 files, including captured scripts.
    if (central[cursor + 5] !== 3 || (mode & 0o170000) !== 0o100000) invalid();
    let compressed = central.readUInt32LE(cursor + 20), uncompressed = central.readUInt32LE(cursor + 24), local = central.readUInt32LE(cursor + 42);
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    for (let p = 0; p < extra.length;) {
      if (p + 4 > extra.length) invalid(); const id = extra.readUInt16LE(p), bytes = extra.readUInt16LE(p + 2); p += 4;
      if (p + bytes > extra.length) invalid();
      if (id === 1) {
        let q = p; const take = () => { if (q + 8 > p + bytes) invalid(); const value = number(extra.readBigUInt64LE(q)); q += 8; return value; };
        if (uncompressed === 0xffffffff) uncompressed = take(); if (compressed === 0xffffffff) compressed = take(); if (local === 0xffffffff) local = take();
      }
      p += bytes;
    }
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || local === 0xffffffff || local + 30 + compressed > offset || positions.has(local)) invalid();
    entries.set(name, { name, nameBytes, flags, method, compressed, uncompressed, local, crc: central.readUInt32LE(cursor + 16) });
    positions.add(local); cursor = next;
  }
  if (cursor !== length || !positions.has(0)) invalid();
  let endOfMember = 0, localMetadataBytes = 0;
  for (const entry of [...entries.values()].sort((a, b) => a.local - b.local)) {
    if (entry.local !== endOfMember) invalid();
    const local = read(entry.local, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method ||
        local.readUInt32LE(14) !== entry.crc) invalid();
    const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28);
    localMetadataBytes += 30 + nameLength + extraLength;
    if (localMetadataBytes > maximumDirectory || nameLength !== entry.nameBytes.length) invalid();
    const metadata = read(entry.local + 30, nameLength + extraLength);
    if (!metadata.subarray(0, nameLength).equals(entry.nameBytes)) invalid();
    let compressed = local.readUInt32LE(18), uncompressed = local.readUInt32LE(22);
    const extra = metadata.subarray(nameLength);
    for (let p = 0; p < extra.length;) {
      if (p + 4 > extra.length) invalid(); const id = extra.readUInt16LE(p), bytes = extra.readUInt16LE(p + 2); p += 4;
      if (p + bytes > extra.length) invalid();
      if (id === 1) {
        let q = p; const take = () => { if (q + 8 > p + bytes) invalid(); const value = number(extra.readBigUInt64LE(q)); q += 8; return value; };
        if (uncompressed === 0xffffffff) uncompressed = take(); if (compressed === 0xffffffff) compressed = take();
      }
      p += bytes;
    }
    if (compressed !== entry.compressed || uncompressed !== entry.uncompressed) invalid();
    endOfMember = entry.local + 30 + nameLength + extraLength + compressed;
    if (endOfMember > offset) invalid();
  }
  if (endOfMember !== offset) invalid();
  return { entries, offset };
}
function member(read, entry, centralOffset, maximum) {
  if (!entry || entry.compressed > maximum || entry.uncompressed > maximum) invalid();
  const local = read(entry.local, 30);
  if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.method) invalid();
  const nameLength = local.readUInt16LE(26), extraLength = local.readUInt16LE(28);
  const offset = entry.local + 30 + nameLength + extraLength;
  if (offset + entry.compressed > centralOffset || !read(entry.local + 30, nameLength).equals(entry.nameBytes)) invalid();
  // Local sizes can be ZIP64 sentinels even for tiny historical export files.
  const compressed = read(offset, entry.compressed);
  const data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maximum });
  if (data.length !== entry.uncompressed || crc32(data) !== entry.crc) invalid(); return data;
}
function fullZip(read, size) {
  if (size > 4 * 1024 * MiB + 32 * MiB) return null;
  const { entries, offset } = directory(read, size);
  const manifestBytes = member(read, entries.get('manifest.json'), offset, maximumManifest);
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  if (manifest.format !== 'bzzy-full-session-debug' || manifest.version !== 1 || manifest.complete !== true || !uuid(manifest.sessionId) ||
      !Array.isArray(manifest.inventory) || manifest.inventory.length !== entries.size - 1 || manifest.overview?.path !== 'overview.md' ||
      !Number.isSafeInteger(manifest.cutoffSeq) || manifest.cutoffSeq < 0) invalid();
  const inventoried = new Set(); let bytes = 0;
  for (const item of manifest.inventory) {
    const entry = entries.get(item.path);
    if (!entry || item.path === 'manifest.json' || inventoried.has(item.path) || !safeName(item.path) || !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 || item.bytes !== entry.uncompressed || item.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(item.sha256)) invalid();
    inventoried.add(item.path); bytes += item.bytes;
  }
  if (bytes !== manifest.uncompressedBytes || bytes > 4 * 1024 * MiB) invalid();
  for (const required of ['README_FIRST.txt', 'GUIDE_TO_BZZY_DEBUGGER.txt', 'overview.md', 'session/records.jsonl', 'session/events.jsonl', 'session/messages.jsonl']) if (!inventoried.has(required)) invalid();
  const readme = member(read, entries.get('README_FIRST.txt'), offset, 16 * 1024).toString('utf8');
  if (!readme.startsWith('BZZY FULL DEBUG EXPORT\n')) invalid();
  return { format: manifest.format, version: 1, sessionId: manifest.sessionId, cutoffSeq: manifest.cutoffSeq,
    validation: 'zip-directory-and-completed-manifest', manifestSha256: hash(manifestBytes) };
}

export function recognizedDebugArtifact(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) return null;
    const key = identity(before), cached = recognized.get(key);
    if (cached && same(before, fs.lstatSync(file, { bigint: true }))) {
      recognized.delete(key); recognized.set(key, cached); return { ...cached };
    }
    const size = number(before.size), read = reader(fd, size), first = read(0, Math.min(size, 64));
    const artifact = first.length >= 4 && first.readUInt32LE(0) === 0x04034b50 ? fullZip(read, size) : regular(read, size, first);
    if (!artifact || !same(before, fs.fstatSync(fd, { bigint: true })) || !same(before, fs.lstatSync(file, { bigint: true }))) return null;
    // Removable/non-POSIX volumes and copy tools can synthesize executable mode
    // bits on data files. Complete data-format validation, not that bit, decides
    // classification; shebang/native executable and ZIP stub prefixes fail it.
    const result = { reason: 'bzzy_debug_artifact', ...artifact, bytes: size, outerMode: Number(before.mode & 0o777n) };
    recognized.set(key, result); if (recognized.size > 64) recognized.delete(recognized.keys().next().value);
    return { ...result };
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
