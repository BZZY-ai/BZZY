import { digest } from './database.js';
import { assertKnowledgeText } from './knowledge-index.js';

const fields = ['decisions', 'completedWork', 'pendingActions', 'unresolvedQuestions', 'constraints'];
const normalized = value => typeof value === 'string' ? value : JSON.stringify(value);
export const checkpointOperationProperties = {
  itemOperations: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false,
    properties: { op: { type: 'string', enum: ['add', 'update', 'archive', 'resolve'] }, field: { type: 'string', enum: fields },
      id: { type: 'string' }, text: { type: 'string', maxLength: 2000 }, expectedItemRevision: { type: 'integer', minimum: 1 } }, required: ['op', 'field'] } },
  evidenceOperations: { type: 'object', additionalProperties: false, properties: {
    add: { type: 'array', maxItems: 32, items: { type: 'string' } }, remove: { type: 'array', maxItems: 32, items: { type: 'string' } } } },
  blockerIds: { type: 'array', maxItems: 32, items: { type: 'string' } },
};

// Legacy arrays remain readable/writable. Structured edits name stable items,
// and archive pointers retain the exact original checkpoint revision.
export function applyCheckpointItems(previous, next, input, scope, revision, contractConstraints = []) {
  const contractValues = new Set(contractConstraints.map(value => digest(value)));
  const priorItems = previous.items || fields.flatMap(field => (previous[field] || []).map(value => ({
    id: digest([scope, field, value]), field, value, revision: 1, checkpointRevision: previous.revision || null,
  })));
  let items = [...priorItems], archived = [...(previous.itemArchive || [])];
  const archive = (item, state) => {
    archived.push({ id: item.id, field: item.field, itemRevision: item.revision, checkpointRevision: item.checkpointRevision,
      archivedAtRevision: revision, state });
  };
  for (const field of fields) if (input[field] != null || field === 'constraints') {
    const previousField = items.filter(item => item.field === field), remaining = new Map();
    for (const item of previousField) {
      const key = digest(item.value); remaining.set(key, [...(remaining.get(key) || []), item]);
    }
    const desired = field === 'constraints' && input.constraints == null
      ? (next[field] || []).flatMap(value => Array(Math.max(1, remaining.get(digest(value))?.length || 0)).fill(value)) : next[field] || [];
    const replaced = desired.map(value => {
      const existing = remaining.get(digest(value))?.shift();
      if (existing) return field === 'constraints' && input.constraints != null && !contractValues.has(digest(value))
        ? { ...existing, occurrences: (existing.occurrences || 1) + 1 } : existing;
      return { id: digest([scope, field, value]), field, value, revision, checkpointRevision: revision };
    });
    for (const item of [...remaining.values()].flat()) archive(item, 'replaced');
    items = [...items.filter(item => item.field !== field), ...replaced];
  }
  const operations = input.itemOperations || [];
  if (!Array.isArray(operations) || operations.length > 50) throw new Error('Checkpoint operations must be a bounded list.');
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)
        || Object.keys(operation).some(key => !['op', 'field', 'id', 'text', 'expectedItemRevision'].includes(key))
        || !fields.includes(operation.field) || !['add', 'update', 'archive', 'resolve'].includes(operation.op)) throw new Error('Invalid checkpoint item operation.');
    if (input[operation.field] != null) throw new Error('Use either a replacement list or item operations for each checkpoint field.');
    if (operation.op === 'add') {
      const value = assertKnowledgeText(operation.text, 2000), id = operation.id || digest([scope, operation.field, value]);
      if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new Error('Use a bounded checkpoint item ID.');
      const previous = items.find(item => item.id === id);
      if (previous && (previous.field !== operation.field || previous.value !== value)) throw new Error('Checkpoint item ID already names different content.');
      if (!previous && operation.field === 'constraints' && contractValues.has(digest(value))) throw new Error('This constraint already belongs to the contract; do not add another working item.');
      // The checkpoint sequence stays monotonic even after an ID was archived
      // and its bounded archive pointer has aged out. Re-adding cannot revive
      // an old compare-and-set revision.
      if (!previous) items.push({ id, field: operation.field, value, revision, checkpointRevision: revision });
      else if (operation.field === 'constraints' && !contractValues.has(digest(value))) {
        items = items.map(item => item.id === id ? { ...item, occurrences: (item.occurrences || 1) + 1 } : item);
      }
    } else {
      const index = items.findIndex(item => item.id === operation.id && item.field === operation.field), item = items[index];
      if (!item || item.revision !== operation.expectedItemRevision) throw new Error('Checkpoint item changed. Use its current item revision.');
      if (item.field === 'constraints' && contractValues.has(digest(item.value))) throw new Error('Contract-owned constraints cannot be changed through checkpoint operations.');
      archive(item, operation.op === 'update' ? 'superseded' : operation.op === 'resolve' ? 'resolved' : 'archived');
      if (operation.op === 'update') items[index] = { ...item, value: assertKnowledgeText(operation.text, 2000), occurrences: 1, revision, checkpointRevision: revision };
      else items.splice(index, 1);
    }
  }
  for (const field of fields) {
    const selected = items.filter(item => item.field === field);
    const count = field === 'constraints' ? selected.filter(item => !contractValues.has(digest(item.value))).length : selected.length;
    const previousCount = field === 'constraints' ? priorItems.filter(item => item.field === field && !contractValues.has(digest(item.value))).length : 0;
    // Contract constraints do not consume the working-list allowance. Legacy
    // oversized working lists can be retained/reduced while other work saves.
    if (count > 50 && (field !== 'constraints' || count > previousCount)) throw new Error('A checkpoint field supports at most 50 active working items; replace or archive obsolete entries.');
    if (selected.length || Object.hasOwn(next, field) || operations.some(item => item.field === field)) next[field] = selected.map(item => item.value);
  }
  // Original records stay in core.checkpoint.revision; this compact index does
  // not copy their full text into every later checkpoint.
  items = items.map(item => ({ ...item, contractOwned: item.field === 'constraints' && contractValues.has(digest(item.value)) }));
  return { ...next, items, itemArchive: archived.slice(-100),
    omittedArchivePointers: (previous.omittedArchivePointers || 0) + Math.max(0, archived.length - 100),
    constraintView: checkpointConstraintView(next.constraints || [], items) };
}
export function checkpointConstraintView(constraints, items = []) {
  const groups = new Map();
  for (const value of constraints || []) {
    const key = normalized(value), prior = groups.get(key);
    if (prior) prior.count++; else groups.set(key, { text: value, count: 1 });
  }
  const occurrences = new Map();
  for (const item of items.filter(item => item.field === 'constraints')) {
    const key = normalized(item.value);
    occurrences.set(key, (occurrences.get(key) || 0) + (item.occurrences || 1));
  }
  return [...groups.entries()].map(([key, group]) => ({ ...group, count: occurrences.get(key) || group.count }));
}
