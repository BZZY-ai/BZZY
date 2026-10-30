import path from 'node:path';

// Recognize a direct interpreter launch without executing a shell, expanding
// variables, inspecting stdout, or guessing filenames from arbitrary prose.
function words(command) {
  if (typeof command !== 'string' || command.length > 256 * 1024) return null;
  const result = []; let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote === "'") { if (char === "'") quote = ''; else word += char; continue; }
    if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '`') return null;
      else if (char === '\\' && /["\\]/.test(command[i + 1] || '')) word += command[++i];
      else word += char;
      continue;
    }
    if (/\s/.test(char)) { if (started) { result.push(word); word = ''; started = false; } }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === '\\') { if (i + 1 === command.length) return null; word += command[++i]; started = true; }
    else if (/[;|&<>]/.test(char)) { if (started) result.push(word); return result; }
    else if (/[$`()[\]{}*?~]/.test(char)) return result.length ? result : null;
    else { word += char; started = true; }
  }
  if (quote) return null;
  if (started) result.push(word);
  return result;
}

export function launchedSourceFile(command, depth = 0) {
  if (depth > 2) return null;
  let args = Array.isArray(command) && command.length <= 256 && command.every(arg => typeof arg === 'string' && arg.length <= 256 * 1024)
    ? command.slice() : words(command);
  if (!args?.length) return null;
  if (args[0] === 'exec') args.shift();
  if (path.basename(args[0] || '') === 'env') {
    args.shift(); while (/^[A-Za-z_][\w]*=/.test(args[0] || '')) args.shift();
  }
  const interpreter = path.basename(args.shift() || '');
  if (/^(?:bash|sh|zsh)$/.test(interpreter) && /^-[A-Za-z]*c[A-Za-z]*$/.test(args[0] || '')) return launchedSourceFile(args[1], depth + 1);
  if (!/^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|ruby|perl|php|bash|sh|zsh)$/.test(interpreter)) return null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { const file = args[i + 1]; return file && file !== '-' ? file : null; }
    if (!arg.startsWith('-')) return arg || null;
    if (arg === '-' || /^(?:--eval|--print)(?:=|$)/.test(arg)
      || /^python/.test(interpreter) && /^-(?:c|m)/.test(arg)
      || /^(?:node|nodejs|ruby|perl)$/.test(interpreter) && /^-(?:e|p)/.test(arg)
      || interpreter === 'php' && /^-r/.test(arg)) return null;
    if (/^-W$|^-X$/.test(arg) && /^python/.test(interpreter)) { i++; continue; }
    // Only known no-argument options are skipped. Unknown flags can consume a
    // filename-looking value, so they cannot establish an executed source path.
    if (!(/^(?:-u|-B|-E|-s|-S|-I|-O|-OO|-q|-v|-vv|-x|-W.+|-X.+)$/.test(arg) && /^python/.test(interpreter)
      || /^(?:--enable-source-maps|--no-warnings|--trace-warnings)$/.test(arg) && /^(?:node|nodejs)$/.test(interpreter)
      || /^-[euxv]+$/.test(arg) && /^(?:bash|sh|zsh)$/.test(interpreter))) return null;
  }
  return null;
}

export function commandInputText(command) {
  if (typeof command === 'string') return command;
  if (!Array.isArray(command) || !command.length || command.length > 256 || !command.every(arg => typeof arg === 'string' && arg.length <= 256 * 1024) || command.reduce((size, arg) => size + arg.length, 0) > 256 * 1024) return null;
  if (/^(?:bash|sh|zsh)$/.test(path.basename(command[0])) && /^-[A-Za-z]*c[A-Za-z]*$/.test(command[1] || '') && typeof command[2] === 'string') return command[2];
  const text = command.map(arg => /^[\w./=-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
  return text.length <= 256 * 1024 ? text : null;
}
