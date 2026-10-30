import path from 'node:path';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { privateWorkspacePath } from './private-paths.js';
import { sharedSecrets } from './share-bundle-policy.js';
import { commandInputText } from './command-source-file.js';

const limit = 256 * 1024;
// Display command INPUT, never infer source from command stdout or execute a
// parser/shell. A heredoc body is code even when no source file is created.
export function commandSource(command) {
  command = commandInputText(command);
  if (typeof command !== 'string' || !command.trim() || command.length > limit) return null;
  const heredoc = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1[^\n]*\n([\s\S]*)/m.exec(command);
  const interpreter = heredoc && [...command.slice(0, heredoc.index).split('\n').at(-1).matchAll(/\b(python[\d.]*|node|ruby|perl|php|bash|sh)\b/g)].at(-1)?.[1];
  if (heredoc && interpreter) {
    const end = new RegExp('(?:^|\\n)[ \\t]*' + heredoc[2] + '(?:[ \\t]*[;"\']?[ \\t]*$|\\r?\\n)').exec(heredoc[3]);
    const content = end ? heredoc[3].slice(0, end.index) : heredoc[3];
    const language = /^python/.test(interpreter) ? 'python' : interpreter === 'node' ? 'javascript' : interpreter;
    return { path: language + ' · shell input', language, content, sourceKind: 'command' };
  }
  return { path: 'Shell command', language: 'sh', content: command, sourceKind: 'command' };
}
export function safeCommandSource(session, command, { callId, phase = 'started' } = {}) {
  if (session.agentId || session.importedUntrusted) return null;
  const source = commandSource(command); if (!source) return null;
  const redactor = diagnosticRedactor({ maxString: limit });
  return { ...source, sourceId: 'command:' + callId, callId, phase, content: redactor.scrub(source.content),
    actorSessionId: session.id, observedAt: new Date().toISOString(), provenance: 'native-command-input', redacted: redactor.stats.redactedValues > 0 };
}

// Decode only an actual JSON string value already received from the provider.
// Incomplete escapes stay buffered. This is a display decoder, not JSON repair
// or executable tool input. Filesystem/tool dispatch still uses the native API.
function jsonString(input, start) {
  let value = '', i = start + 1;
  while (i < input.length) {
    const char = input[i++]; if (char === '"') return { value, complete: true, end: i };
    if (char !== '\\') { value += char; continue; }
    if (i >= input.length) break;
    const escape = input[i++], escaped = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    if (escape === 'u') {
      const hex = input.slice(i, i + 4); if (!/^[a-f0-9]{4}$/i.test(hex)) break;
      value += String.fromCharCode(parseInt(hex, 16)); i += 4;
    } else if (Object.hasOwn(escaped, escape)) value += escaped[escape]; else break;
  }
  return { value: value.replace(/[\ud800-\udbff]$/, ''), complete: false, end: i };
}
function stringField(input, field) {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === '"') {
      const key = jsonString(input, i); if (!key.complete) return null;
      let next = key.end; while (/\s/.test(input[next] || '') && next < input.length) next++;
      if (depth === 1 && key.value === field && input[next] === ':') {
        next++; while (/\s/.test(input[next] || '') && next < input.length) next++;
        return input[next] === '"' ? jsonString(input, next) : null;
      }
      i = key.end - 1;
    }
  }
  return null;
}
export function createStreamingSourceObserver(session, emit) {
  const pending = new Map();
  let secrets;
  try { secrets = sharedSecrets(); } catch { return () => {}; } // Optional preview cannot interrupt native execution.
  const scrubber = diagnosticRedactor({ secrets, maxString: limit });
  const project = state => {
    let source, incomplete;
    if (state.name === 'Bash') {
      const command = stringField(state.input, 'command'); if (!command) return null;
      incomplete = !command.complete;
      source = commandSource(command.value); if (!source) return null;
      source.sourceId = 'command:' + state.id;
    } else {
      const file = stringField(state.input, 'file_path'), code = stringField(state.input, state.name === 'Write' ? 'content' : 'new_string');
      if (!file?.complete || !code) return null;
      incomplete = !code.complete;
      const relative = path.relative(session.cwd, path.resolve(session.cwd, file.value));
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || privateWorkspacePath(relative) || relative.split(path.sep).includes('.git')) return null;
      source = { path: relative, language: path.extname(relative).slice(1), content: code.value, sourceKind: 'proposed-edit', sourceId: 'input:' + state.id };
    }
    // Do not expose an unfinished prefix of a known host credential when a
    // provider happens to split it between input chunks.
    let raw = source.content;
    for (const secret of (incomplete ? secrets : []).filter(value => typeof value === 'string' && value.length >= 4)) {
      for (let size = Math.min(raw.length, secret.length - 1); size > 0; size--) if (raw.endsWith(secret.slice(0, size))) { raw = raw.slice(0, -size); break; }
    }
    const content = scrubber.scrub(raw);
    return { ...source, content, actorSessionId: session.id, callId: state.id, phase: 'preparing', provenance: 'native-tool-input-stream', redacted: content !== source.content };
  };
  return event => {
    if (session.agentId || session.importedUntrusted || !session.cwd) return;
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && ['Bash', 'Write', 'Edit'].includes(event.content_block.name)) {
      if (pending.size >= 64) pending.delete(pending.keys().next().value);
      pending.set(event.index, { id: event.content_block.id, name: event.content_block.name, input: '', published: '', revision: 0 });
    } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      const state = pending.get(event.index); if (!state || typeof event.delta.partial_json !== 'string') return;
      state.input += event.delta.partial_json;
      if (state.input.length > limit) { pending.delete(event.index); return; }
      const source = project(state); if (!source || state.published === source.content) return;
      let common = 0; while (common < state.published.length && common < source.content.length && state.published[common] === source.content[common]) common++;
      const { content, ...metadata } = source;
      const revision = ++state.revision;
      emit('source.delta', { ...metadata, revision, replaceFrom: common, text: content.slice(common), observedAt: new Date().toISOString() });
      state.published = content;
    } else if (event.type === 'content_block_stop') {
      const state = pending.get(event.index);
      if (state?.revision) {
        const source = project(state);
        if (source) {
          const { content, ...metadata } = source;
          emit('source.delta', { ...metadata, revision: ++state.revision, replaceFrom: state.published.length, text: '', phase: 'prepared', observedAt: new Date().toISOString() });
        }
      }
      pending.delete(event.index);
    }
  };
}
