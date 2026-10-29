import fs from 'node:fs';
import path from 'node:path';
import { listExtensions, getExtension, normalizeExtension, saveExtension, setExtensionEnabled, deleteExtension, EXTENSION_LIMITS } from './extensions.js';

const usage = 'Usage: bzzy extensions list | show ID | validate FILE.json | install FILE.json | update FILE.json --revision N | enable|disable|remove ID --revision N | export ID FILE.json';
export function readExtensionFile(filename, cwd = process.cwd()) {
  const fd = fs.openSync(path.resolve(cwd, filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > EXTENSION_LIMITS.bytes) throw new Error('Extensions must be regular UTF-8 JSON files, without links, at most 64 KiB.');
    const data = Buffer.alloc(EXTENSION_LIMITS.bytes + 1); let length = 0, n;
    do { n = fs.readSync(fd, data, length, data.length - length); length += n; } while (n > 0 && length < data.length);
    if (length > EXTENSION_LIMITS.bytes) throw new Error('The extension exceeds 64 KiB.');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))); }
    catch { throw new Error('The extension must be valid UTF-8 JSON.'); }
    return normalizeExtension(value);
  } finally { fs.closeSync(fd); }
}
export function exportExtensionFile(id, filename, cwd = process.cwd()) {
  const item = getExtension(id), definition = normalizeExtension(item.definition), destination = path.resolve(cwd, filename);
  // Explicitly new file only: never overwrite a private binding or other file.
  fs.writeFileSync(destination, JSON.stringify(definition, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { path: destination, id, version: item.version };
}
export function extensionsCLI(args, options = {}, ui) {
  const values = []; let revision;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--revision') { if (revision !== undefined || !/^[1-9][0-9]*$/.test(args[i + 1] || '')) throw new Error(usage); revision = Number(args[++i]); if (!Number.isSafeInteger(revision)) throw new Error(usage); }
    else if (args[i].startsWith('-')) throw new Error(usage); else values.push(args[i]);
  }
  const [command = 'list', argument, file, ...rest] = values, cwd = options.cwd || process.cwd();
  if (rest.length || !['list', 'show', 'validate', 'install', 'update', 'enable', 'disable', 'remove', 'export'].includes(command)
    || (command === 'list' ? argument !== undefined : !argument) || (command === 'export' ? !file : file !== undefined)
    || ['update', 'enable', 'disable', 'remove'].includes(command) !== (revision !== undefined)) throw new Error(usage);
  let result;
  if (command === 'list') result = { extensions: listExtensions().map(({ definition, ...item }) => item) };
  else if (command === 'show') result = getExtension(argument);
  else if (command === 'validate') { const definition = readExtensionFile(argument, cwd); result = { valid: true, id: definition.id, title: definition.title, actions: definition.actions }; }
  else if (command === 'install' || command === 'update') result = saveExtension(readExtensionFile(argument, cwd), { expectedRevision: revision || 0 });
  else if (command === 'export') result = exportExtensionFile(argument, file, cwd);
  else if (command === 'remove') result = deleteExtension(argument, revision);
  else result = setExtensionEnabled(argument, command === 'enable', revision);
  if (ui?.event) ui.event('info', { result, message: JSON.stringify(result, null, 2) });
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}
