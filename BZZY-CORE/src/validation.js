export function fail(code, message, status = 400) {
  throw Object.assign(new Error(message), { code, status });
}

export function object(value, allowed, label = 'Input') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('INVALID_REQUEST', `${label} must be a plain object.`);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('INVALID_REQUEST', `${label} contains an unsupported field.`);
  return value;
}

export function opaque(value, label = 'ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) fail('INVALID_REQUEST', `${label} must be an opaque ID of 1–80 letters, digits, _ or -.`);
  return value;
}

export function uuid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) fail('INVALID_REQUEST', 'A full session UUID is required.');
  return value;
}

export function identity(value) {
  object(value, ['userId', 'workspaceId', 'agentId'], 'Principal');
  return Object.freeze(Object.fromEntries(['userId', 'workspaceId', 'agentId'].map(key => [key, opaque(value[key], key)])));
}

export const sameIdentity = (a, b) => ['userId', 'workspaceId', 'agentId'].every(key => a?.[key] === b?.[key]);

export function future(value) {
  if (!Number.isSafeInteger(value) || value <= Date.now()) fail('INVALID_REQUEST', 'An explicit future expiry in milliseconds is required.');
  return value;
}

export function strings(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > 64 || value.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(item)) || new Set(value).size !== value.length) fail('INVALID_REQUEST', `${label} must contain distinct capability names.`);
  return [...value];
}
