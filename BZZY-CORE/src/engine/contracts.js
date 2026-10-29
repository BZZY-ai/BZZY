import fs from 'node:fs';
import { inside } from './evidence.js';

function strings(value, name) {
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) throw new Error(`${name} must be a list of nonempty strings.`);
  return value;
}
export function normalizeProgramScope(input) {
  const keys = ['allowedTargets', 'excludedTargets', 'allowedActions', 'excludedActions', 'restrictions', 'cleanupObligations', 'networkMode'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new Error('Program scope needs only supported target, action and restriction fields.');
  const result = {};
  for (const key of keys.filter(key => key !== 'networkMode')) {
    const values = strings(input[key] || [], `scope.${key}`);
    if (values.length > 256 || values.some(value => value.length > 2000 || /[\x00-\x1f\x7f]/.test(value))) throw new Error('Program scope fields exceed their bounds.');
    result[key] = [...new Set(values.map(value => value.trim()))].sort();
  }
  for (const target of [...result.allowedTargets, ...result.excludedTargets]) {
    if (/^https?:\/\//.test(target)) {
      const parsed = new URL(target.replace(/\*$/, ''));
      if (parsed.username || parsed.password || parsed.search || parsed.hash || target.slice(0, -1).includes('*')) throw new Error('Scope URLs cannot contain credentials, queries, fragments or embedded wildcards.');
    } else if (!/^(?:\*\.)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(target)) throw new Error('Scope targets must be hostnames or HTTP(S) URLs.');
  }
  for (const action of [...result.allowedActions, ...result.excludedActions]) if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(action)) throw new Error('Scope actions must be explicit supported HTTP methods.');
  result.networkMode = input.networkMode || 'mediated';
  if (!['offline', 'mediated'].includes(result.networkMode)) throw new Error('Program networkMode must be offline or mediated.');
  return result;
}
export function normalizeContract(input = {}, objective) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Task contract must be an object.');
  const contract = { version: 1, objective: input.objective || objective, context: input.context || '',
    constraints: strings(input.constraints || [], 'constraints'), inputs: strings(input.inputs || [], 'inputs'),
    acceptanceCriteria: input.acceptanceCriteria || [{ id: 'objective', description: input.objective || objective, modelJudgment: true }],
    artifacts: input.artifacts || [], verification: input.verification || [], policy: normalizePolicy(input.policy), limits: input.limits || {}, scope: input.scope || {} };
  if (!contract.scope || typeof contract.scope !== 'object' || Array.isArray(contract.scope)) throw new Error('scope must be an object.');
  for (const name of ['allowedTargets', 'excludedTargets', 'allowedActions', 'excludedActions', 'accountReferences', 'cleanupObligations']) if (contract.scope[name] != null) strings(contract.scope[name], `scope.${name}`);
  if (typeof contract.objective !== 'string' || !contract.objective.trim()) throw new Error('Task contract needs an objective.');
  if (!Array.isArray(contract.acceptanceCriteria) || !contract.acceptanceCriteria.length) throw new Error('Supply acceptanceCriteria.');
  const ids = new Set();
  contract.acceptanceCriteria = contract.acceptanceCriteria.map((c, index) => {
    const criterion = typeof c === 'string' ? { id: `requirement-${index + 1}`, description: c } : c;
    if (!criterion || !/^[a-zA-Z0-9_-]{1,64}$/.test(criterion.id || '') || ids.has(criterion.id) || !criterion.description?.trim()) throw new Error('Acceptance criteria need unique IDs and descriptions.');
    ids.add(criterion.id); return criterion;
  });
  for (const [name, entries] of [['artifacts', contract.artifacts], ['verification', contract.verification]]) if (!Array.isArray(entries)) throw new Error(`${name} must be a list.`);
  for (const item of contract.artifacts) {
    if (!item.path || typeof item.path !== 'string') throw new Error('Required artifacts need a path.');
    if (item.schema) validateSchema(item.schema);
  }
  const checks = new Set();
  for (const check of contract.verification) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(check.id || '') || checks.has(check.id) || !Array.isArray(check.argv) || !check.argv.length || check.argv.some(v => typeof v !== 'string' || v.includes('\0'))) throw new Error('Verification steps need unique IDs and an argv array.');
    checks.add(check.id);
    if (check.timeoutSeconds != null && (!Number.isSafeInteger(check.timeoutSeconds) || check.timeoutSeconds < 1 || check.timeoutSeconds > 3600)) throw new Error('Verification timeout must be 1–3600 seconds.');
  }
  for (const [name, value] of Object.entries(contract.limits)) {
    if (!['runtimeSeconds', 'tokenBudget', 'maxTurns', 'maxRetries', 'concurrency', 'maxAssignments', 'assignmentSeconds'].includes(name) || !Number.isSafeInteger(value) || value < (name === 'maxRetries' ? 0 : 1)) throw new Error(`Invalid task limit ${name}.`);
  }
  return contract;
}
export function normalizePolicy(input = {}) {
  const value = { mode: input.mode || 'workspace-write', writablePaths: input.writablePaths || ['.'], network: input.network || 'inherit' };
  if (!['read-only', 'workspace-write'].includes(value.mode) || !['inherit', 'disabled'].includes(value.network)) throw new Error('Unsupported permission policy.');
  strings(value.writablePaths, 'policy.writablePaths');
  if (value.writablePaths.some(p => p.startsWith('/') || p.split(/[\\/]/).includes('..'))) throw new Error('Writable paths must stay within the task workspace.');
  if (value.mode === 'read-only') value.writablePaths = [];
  return value;
}
export function loadContract(file, objective) {
  if (fs.statSync(file).size > 128 * 1024) throw new Error('Contract exceeds 128 KiB.');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeContract(objective ? { ...input, objective } : input, objective);
}
const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title']);
export function validateSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Output schema must be an object.');
  for (const key of Object.keys(schema)) if (!supported.has(key)) throw new Error(`Unsupported output-schema keyword: ${key}`);
  if (schema.type && !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(schema.type)) throw new Error('Unsupported schema type.');
  for (const child of Object.values(schema.properties || {})) validateSchema(child);
  if (schema.items) validateSchema(schema.items);
  return schema;
}
export function schemaErrors(value, schema, at = '$') {
  const errors = [], type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !(schema.type === 'integer' ? Number.isInteger(value) : schema.type === type)) return [`${at}: expected ${schema.type}`];
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) errors.push(`${at}: value is outside enum`);
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: const mismatch`);
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(child, schema.properties[key], `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unexpected property`);
    }
  }
  if (type === 'array' && schema.items) value.forEach((v, i) => errors.push(...schemaErrors(v, schema.items, `${at}[${i}]`)));
  for (const [key, observed, comparison] of [['minimum', value, 'min'], ['maximum', value, 'max'], ['minLength', value?.length, 'min'], ['maxLength', value?.length, 'max'], ['minItems', value?.length, 'min'], ['maxItems', value?.length, 'max']]) {
    if (schema[key] != null && (comparison === 'min' ? observed < schema[key] : observed > schema[key])) errors.push(`${at}: violates ${key}`);
  }
  return errors;
}
export function validateContractPaths(contract, cwd) {
  for (const relative of [...contract.inputs, ...contract.artifacts.map(a => a.path), ...contract.policy.writablePaths]) inside(cwd, relative, { exists: false });
}
