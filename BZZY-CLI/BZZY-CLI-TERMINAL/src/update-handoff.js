import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { home } from './store.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const folder = () => path.join(home(), 'runtime', 'cli-handoff');
const maximum = 4 * 1024 * 1024;
function validated(value) {
  if (!value || value.v !== 1 || value.sessionId !== null && !uuid(value.sessionId) || !['CONTROL', 'VIEW'].includes(value.mode) || typeof value.settingsOnly !== 'boolean' || typeof value.coreStopped !== 'boolean' || !Array.isArray(value.drafts) || value.drafts.length > 128) throw new Error('Invalid CLI update recovery state.');
  const drafts = value.drafts.map(([id, draft]) => {
    if (!uuid(id) || typeof draft?.value !== 'string' || Buffer.byteLength(draft.value) > maximum || !Number.isSafeInteger(draft.cursor) || draft.cursor < 0 || draft.cursor > [...draft.value].length) throw new Error('Invalid CLI update draft.');
    return [id, { value: draft.value, cursor: draft.cursor }];
  });
  return { v: 1, sessionId: value.sessionId, mode: value.mode, settingsOnly: value.settingsOnly, coreStopped: value.coreStopped,
    activeTab: uuid(value.activeTab) ? value.activeTab : value.sessionId, drafts };
}
export function writeUpdateHandoff(ui, { coreStopped = false } = {}) {
  const tui = ui.tui;
  if (tui?.hidden || tui?.promptDraft || ui.privateView) throw new Error('Finish the private input before updating.');
  const drafts = new Map(tui?.drafts || []), selected = ui.activeTab || ui.sessionId;
  if (uuid(selected)) drafts.set(selected, tui?.settingsDraft || { value: tui?.value || '', cursor: tui?.cursor || 0 });
  const value = validated({ v: 1, sessionId: uuid(ui.sessionId) ? ui.sessionId : null,
    activeTab: ui.activeTab, mode: ui.sessionMode && ui.sessionMode !== 'CONTROL' ? 'VIEW' : 'CONTROL', settingsOnly: Boolean(ui.settingsOnly), coreStopped, drafts: [...drafts] });
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > maximum) throw new Error('The unsent drafts are too large to preserve during this update.');
  fs.mkdirSync(folder(), { recursive: true, mode: 0o700 });
  const directory = fs.lstatSync(folder());
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid() || fs.realpathSync(folder()) !== path.join(fs.realpathSync(home()), 'runtime', 'cli-handoff')) throw new Error('CLI recovery storage must remain private to this user.');
  const file = path.join(folder(), `${randomUUID()}.json`);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return file;
}
export function readUpdateHandoff(file = process.env.BZZY_CLI_HANDOFF) {
  delete process.env.BZZY_CLI_HANDOFF;
  if (!file) return null;
  if (path.dirname(file) !== folder() || !/^[a-f0-9-]{36}\.json$/.test(path.basename(file))) throw new Error('Invalid CLI update recovery location.');
  const claimed = file + '.claimed'; fs.renameSync(file, claimed);
  let fd;
  try {
    fd = fs.openSync(claimed, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid() || stat.size > maximum || Date.now() - stat.mtimeMs > 30 * 60000) throw new Error('CLI update recovery must be recent and private to this user.');
    return validated(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(claimed, { force: true }); }
}
export function discardUpdateHandoff(file) { if (file && path.dirname(file) === folder()) fs.rmSync(file, { force: true }); }

export function updateLaunchTarget(check) {
  const bin = process.env.BZZY_LAUNCHER_BIN_DIR || process.env.BZZY_BIN_DIR || path.join(os.homedir(), '.local', 'bin');
  const launcher = path.join(bin, 'bzzy');
  try {
    const stat = fs.lstatSync(launcher);
    if (stat.isFile() && !(stat.mode & 0o022) && (!process.getuid || stat.uid === process.getuid()) && fs.readFileSync(launcher, 'utf8').startsWith('#!/bin/sh\n# bzzy-managed launcher\n')) return { file: '/bin/sh', args: ['/bin/sh', launcher] };
  } catch { /* Direct source launches can reload their updated entry point. */ }
  if (check.packaged) throw new Error('The updated BZZY launcher is unavailable. Run bzzy from its installed launcher.');
  const entry = path.join(check.directory, 'bin', 'bzzy.js'); fs.accessSync(entry, fs.constants.R_OK);
  return { file: process.execPath, args: [process.execPath, entry] };
}
export function execUpdatedCLI({ file, check, target = updateLaunchTarget(check) }, exec = process.execve) {
  if (typeof exec !== 'function') throw new Error('This Node runtime cannot reload the CLI. Run bzzy again.');
  exec(target.file, target.args, { ...process.env, BZZY_CLI_HANDOFF: file });
}
