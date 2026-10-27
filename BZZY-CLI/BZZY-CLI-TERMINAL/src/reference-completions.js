import { listSkills } from '@bzzy/core/engine/skills.js';
import { listSubagentDefinitions } from '@bzzy/core/engine/subagent-definitions.js';
import { subagentsAvailable } from '@bzzy/core/engine/subagents.js';
import { loadSession } from '@bzzy/core/engine/store.js';

// Cursor offsets use code points, like the terminal composer. A dollar sign in
// an escaped string, currency amount, ${variable} or $(command) stays literal.
export function referenceToken(value, cursor) {
  const chars = [...value], before = chars.slice(0, cursor).join('');
  const match = /(?:^|[\s("'\[\{,:;])\$([a-z][a-z0-9_-]{0,63}|)$/u.exec(before);
  if (!match) return null;
  const start = cursor - [...match[1]].length - 1;
  let end = cursor;
  while (end < chars.length && /[a-z0-9_-]/.test(chars[end])) end++;
  return { start, end, query: match[1].replaceAll('_', '-') };
}

function context(ui) {
  const sessionId = ui.activeTab || ui.sessionId;
  const session = sessionId && loadSession(sessionId);
  return { ...(session ? { session } : {}), cwd: session?.projectRoot || session?.cwd || ui.tui?.cwd || process.cwd() };
}

function pageFor(selected, kind, query, offset = 0) {
  if (kind === 'skill') {
    const page = listSkills({ ...(selected.session ? { session: selected.session } : { projectRoot: selected.cwd }),
      enabledOnly: true, query, offset, limit: 100 });
    return { ...page, items: page.skills };
  }
  if (selected.session && !subagentsAvailable(selected.session)) return { items: [], total: 0, nextOffset: null };
  const page = listSubagentDefinitions({ cwd: selected.cwd, enabledOnly: true, query, offset, limit: 100 });
  return { ...page, items: page.subagents };
}

const choiceFor = (entry, referenceKind) => ({ kind: 'reference', referenceKind, id: entry.id, name: entry.name,
  command: referenceKind === 'skill' ? '$' + entry.name : entry.name,
  insertText: referenceKind === 'skill' ? '$' + entry.name : 'subagent ' + entry.name,
  description: `${referenceKind === 'skill' ? 'Skill' : 'Agent'} · ${entry.scope} · ${entry.description}` });

export function referenceCatalog(ui, query) {
  const selected = context(ui), skills = pageFor(selected, 'skill', query), agents = pageFor(selected, 'agent', query);
  const choices = [...skills.items.map(skill => choiceFor(skill, 'skill')), ...agents.items.map(agent => choiceFor(agent, 'agent'))]
    .sort((a, b) => a.name.localeCompare(b.name) || a.referenceKind.localeCompare(b.referenceKind));
  return { choices, total: skills.total + agents.total, truncated: skills.nextOffset != null || agents.nextOffset != null };
}

export function insertReference(ui, value, cursor, choice) {
  const token = referenceToken(value, cursor);
  if (!token || choice?.kind !== 'reference' || !['skill', 'agent'].includes(choice.referenceKind)) return null;
  const selected = context(ui);
  let current, offset = 0;
  do {
    const page = pageFor(selected, choice.referenceKind, choice.name, offset);
    current = page.items.find(entry => entry.id === choice.id);
    offset = page.nextOffset;
  } while (!current && offset != null);
  if (!current) throw new Error('This entry is unavailable. Type $ again to refresh the selector.');
  const chars = [...value], suffix = chars.slice(token.end).join('');
  const inserted = choiceFor(current, choice.referenceKind).insertText + (suffix ? '' : ' ');
  chars.splice(token.start, token.end - token.start, ...inserted);
  return { value: chars.join(''), cursor: token.start + [...inserted].length };
}
