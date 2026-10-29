import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { debugExportFailure } from './debug-export-errors.js';
import { diagnosticPrivateFieldPatterns } from './diagnostic-redaction.js';

const omissions = new Set(['outside_capture_root', 'changed_or_unreadable_source', 'link_or_special_file',
  'opaque_archive_or_database', 'credential_in_binary', 'credential_content', 'unparseable_structured_data']);
const errorCodes = new Set(['SESSION_DEBUG_SPACE', 'SESSION_DEBUG_ACCESS', 'SESSION_DEBUG_FAILED']);

// Python's disk-backed scanner handles complete values without converting a
// multi-gigabyte source into JS strings. Only validated metadata crosses stdout;
// bindings travel through private stdin and scratch is removed before packaging.
export async function captureDebugFile(source, destination, { sourceRoot = path.dirname(source), name = source,
  roots = [], secrets = [], onProgress } = {}) {
  const scratch = fs.mkdtempSync(path.join(path.dirname(destination), '.file-capture-'));
  fs.chmodSync(scratch, 0o700);
  let created;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('python3', ['-I', fileURLToPath(new URL('./debug-file-capture.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
      let pending = '', outcome, invalid = false;
      child.stdout.on('data', chunk => {
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line.length > 4096) { invalid = true; continue; }
          try {
            const value = JSON.parse(line);
            if (value.type === 'progress' && Number.isSafeInteger(value.inspectedBytes) && value.inspectedBytes >= 0) {
              try { onProgress?.({ inspectedBytes: value.inspectedBytes }); } catch { /* Display cannot change capture. */ }
            } else if (value.type === 'complete') {
              const row = value.value;
              if (!row || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(row.sourceBytes) || row.sourceBytes < 0
                || !/^[a-f0-9]{64}$/.test(row.sha256) || !/^[a-f0-9]{64}$/.test(row.sourceSha256)
                || !['utf8', 'binary', 'jsonl'].includes(row.encoding) || typeof row.redacted !== 'boolean' || outcome) invalid = true;
              else outcome = { bytes: row.bytes, sourceBytes: row.sourceBytes, sha256: row.sha256, sourceSha256: row.sourceSha256,
                encoding: row.encoding, redacted: row.redacted };
            } else if (value.type === 'omitted' && omissions.has(value.reason) && !outcome) outcome = { omitted: value.reason };
            else if (value.type === 'error' && errorCodes.has(value.code) && !outcome) outcome = { error: value.code };
            else invalid = true;
          } catch { invalid = true; }
        }
        if (pending.length > 4096) { invalid = true; pending = ''; }
      });
      // Never forward private subprocess exceptions or interpreter diagnostics.
      child.stderr.resume(); child.stdin.on('error', () => {});
      child.once('error', error => reject(debugExportFailure(error.code === 'ENOENT' ? 'SESSION_DEBUG_PYTHON' : 'SESSION_DEBUG_FAILED')));
      child.once('close', code => {
        if (code !== 0 || invalid || !outcome || pending.trim()) reject(debugExportFailure('SESSION_DEBUG_FAILED'));
        else if (outcome.error) reject(debugExportFailure(outcome.error));
        else resolve(outcome);
      });
      const replacements = [...new Set(roots.filter(root => typeof root === 'string' && root.length > 3))]
        .sort((left, right) => right.length - left.length).map(root => [root, '[project]']);
      replacements.push([os.homedir(), '[home]']);
      // The destination inside scratch is exclusively created by the scanner.
      child.stdin.end(JSON.stringify({ source, sourceRoot, destination: path.join(scratch, 'result'), scratch, name,
        roots: replacements, secrets, ...diagnosticPrivateFieldPatterns }));
    });
    if (result.omitted) return result;
    const captured = path.join(scratch, 'result'), stat = fs.lstatSync(captured);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== result.bytes) throw debugExportFailure('SESSION_DEBUG_FAILED');
    // Exclusive publication preserves an existing destination. Both paths are
    // inside the same private stage, so this does not duplicate the large file.
    fs.linkSync(captured, destination); created = stat; fs.unlinkSync(captured);
    return result;
  } catch (error) {
    if (created) {
      try { const stat = fs.lstatSync(destination); if (stat.dev === created.dev && stat.ino === created.ino) fs.unlinkSync(destination); } catch { /* Preserve failure. */ }
    }
    throw error;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
