import fs from 'node:fs';
import path from 'node:path';
import { listSubagentDefinitions, getSubagentDefinition, saveSubagentDefinition, deleteSubagentDefinition, setSubagentEnabled } from './subagent-definitions.js';

const usage = 'Usage: bzzy subagents list [--global] | show NAME [--global] | create FILE.json [--global] | update FILE.json --revision N [--global] | enable|disable|delete NAME --revision N [--global]';

function readDefinition(filename, cwd) {
  if (typeof filename !== 'string' || !filename || filename.startsWith('-')) throw new Error(usage);
  const fd = fs.openSync(path.resolve(cwd, filename), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 24 * 1024) throw new Error('A subagent definition must be a regular JSON file without links, at most 24 KiB.');
    const bytes = Buffer.alloc(24 * 1024 + 1); let length = 0, read;
    do { read = fs.readSync(fd, bytes, length, bytes.length - length); length += read; } while (read > 0 && length < bytes.length);
    if (length > 24 * 1024) throw new Error('The subagent definition exceeds 24 KiB.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new Error('The subagent definition is not valid UTF-8 JSON.'); }
  } finally { fs.closeSync(fd); }
}

export function subagentsCLI(args, options = {}, ui) {
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error(usage);
  const values = [], flags = new Set(); let scope, expectedRevision;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--global') {
      if (flags.has(value)) throw new Error(usage);
      flags.add(value); scope = 'global';
    } else if (value === '--revision') {
      if (flags.has(value) || !/^[1-9][0-9]{0,14}$/.test(args[index + 1] || '')) throw new Error(usage);
      flags.add(value); expectedRevision = Number(args[++index]);
      if (!Number.isSafeInteger(expectedRevision)) throw new Error(usage);
    } else if (value.startsWith('-')) throw new Error(usage);
    else values.push(value);
  }
  const [command = 'list', argument, ...rest] = values;
  if (rest.length || !['list', 'show', 'create', 'update', 'delete', 'enable', 'disable'].includes(command) ||
      command === 'list' && argument !== undefined || command !== 'list' && !argument ||
      ['list', 'show', 'create'].includes(command) && expectedRevision !== undefined ||
      ['update', 'delete', 'enable', 'disable'].includes(command) && expectedRevision === undefined) throw new Error(usage);
  const selected = { cwd: path.resolve(options.cwd || process.cwd()), scope };
  let result;
  if (command === 'list') {
    const first = listSubagentDefinitions({ ...selected, limit: 100 });
    const subagents = [...first.subagents]; let offset = first.nextOffset;
    while (offset !== null) {
      const page = listSubagentDefinitions({ ...selected, limit: 100, offset });
      subagents.push(...page.subagents); offset = page.nextOffset;
    }
    result = { subagents, total: subagents.length, nextOffset: null };
  }
  else if (command === 'show') result = getSubagentDefinition(argument, selected);
  else if (command === 'delete') result = deleteSubagentDefinition(argument, { ...selected, expectedRevision });
  else if (['enable', 'disable'].includes(command)) result = setSubagentEnabled(argument, command === 'enable', { ...selected, expectedRevision });
  else result = saveSubagentDefinition(readDefinition(argument, selected.cwd), { ...selected, expectedRevision: expectedRevision || 0 });
  if (ui?.event) ui.event('info', { result, message: JSON.stringify(result, null, 2) });
  else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}
