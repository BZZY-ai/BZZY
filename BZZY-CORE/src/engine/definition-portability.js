import os from 'node:os';
import { assertShareText, sharedSecrets } from './share-bundle-policy.js';

const portabilityFailure = (message, reasonCode, line) => {
  throw Object.assign(new Error(message), { code: 'DEFINITION_BUNDLE', reasonCode,
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) });
};
const placeholder = value => !value || /^(?:\$[A-Z_][A-Z0-9_]*|\$\{[^}]+\}|<[^>]+>|\[redacted\])$/i.test(value);
const credentialField = /^(?:api[_-]?key|(?:access|refresh|auth|oauth)[_-]?token|token|password|passwd|secret|cookie|authorization|account[_-]?id|email)$/i;
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
function pythonReference(value, remainder) {
  // A variable or runtime lookup is not a literal credential. Restrict this
  // interpretation to Python resources; unquoted YAML/INI values stay literals.
  if (/^(?:str|int|float|bool|bytes|Any)(?:[)\],:]|$)/.test(value)) return true;
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value)) return true;
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\[/.test(value)) return true;
  if (/^(?:os\.getenv|os\.environ\.get|getpass\.getpass|[A-Za-z_]\w*\.get)\(/.test(value)) return true;
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\((?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\))/.test(value)) return true;
  return /^f(["'])(?:Bearer|Basic) \{[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\}\1(?:[ \t]*[,)}\]]|[ \t]*$)/.test(remainder);
}
function credentialSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length === 1 && typeof value.$ref === 'string' && /^#\/[a-zA-Z0-9_/-]+$/.test(value.$ref)) return true;
  return value.type === 'string' && Object.keys(value).every(key => ['type', 'title', 'description', 'format', 'minLength', 'maxLength'].includes(key)) &&
    ['title', 'description', 'format'].every(key => value[key] === undefined || typeof value[key] === 'string') &&
    ['minLength', 'maxLength'].every(key => value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1048576);
}
export function assertPortableDefinitionText(data, context = {}) {
  const text = data.toString('utf8');
  try { assertShareText(text, sharedSecrets()); }
  catch (error) { throw Object.assign(error, { reasonCode: 'CREDENTIAL' }); }
  const account = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.exec(text);
  if (account) portabilityFailure('Reusable definitions contain private account or host-path data. Parameterize it before exporting.', 'PRIVATE_ACCOUNT', lineAt(text, account.index));
  const hostPath = /(?:\/Users\/|\/home\/|\/Volumes\/|\/~?\.bzzy\/|~\/(?:\.codex|\.claude|\.ssh)\/)/i.exec(text);
  const privateOffsets = [context.cwd, context.hostHome, os.homedir(), ...(context.privateRoots || [])]
    .filter(root => typeof root === 'string' && root.length > 3).map(root => text.indexOf(root)).filter(offset => offset >= 0);
  if (hostPath) privateOffsets.push(hostPath.index);
  if (privateOffsets.length) portabilityFailure('Reusable definitions contain private account or host-path data. Parameterize it before exporting.', 'PRIVATE_HOST_PATH', lineAt(text, Math.min(...privateOffsets)));
  let json = false;
  try {
    const parsed = JSON.parse(text); json = true;
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (credentialField.test(key) && item !== null && !(typeof item === 'string' && placeholder(item)) && !credentialSchema(item)) portabilityFailure('Reusable definitions contain a literal credential or account binding.', 'CREDENTIAL_LITERAL');
        visit(item);
      }
    };
    visit(parsed);
  } catch (error) { if (error.code === 'DEFINITION_BUNDLE') throw error; }
  const assignments = /(?<before>^|[\s{,(.\[])(?<opening>["']?)(?<field>api[_-]?key|(?:access|refresh|auth|oauth)[_-]?token|token|password|passwd|secret|cookie|authorization|account[_-]?id|email)(?<closing>["']?)(?:[ \t]*\])?[ \t]*(?<operator>[:=])\s*(?:"(?<double>[^"\r\n]*)"|'(?<single>[^'\r\n]*)'|(?<bare>\$\{[^}\r\n]+\}|<[^>\r\n]+>|\[redacted\]|[^\s,\r\n}]+))/dgim;
  let match;
  while ((match = assignments.exec(text))) {
    const { before, opening, closing, field, operator, double, single, bare } = match.groups;
    const fieldStart = match.indices.groups.field[0], prefix = text.slice(text.lastIndexOf('\n', fieldStart - 1) + 1, fieldStart);
    // Keep scanning inside a matched expression as well (for example an inline
    // conditional followed by a separate literal password assignment).
    assignments.lastIndex = fieldStart + field.length;
    const literal = double ?? single, value = literal ?? bare;
    const python = /\.py$/i.test(context.resourcePath || '');
    // Colons in sentences ("explicit authorization: ...") and diagnostic text
    // are not configuration fields. Quoted keys, HTTP headers, structured keys
    // and standalone/list key lines still receive the literal-value checks.
    if (operator === ':' && !opening && !closing && !/[{,(.\[]/.test(before) && !/^[ \t]*(?:[-*+][ \t]+)?$/.test(prefix)) {
      if (field.toLowerCase() === 'authorization' && literal === undefined && !/^(?:Bearer|Basic)\b/i.test(value)) continue;
      if (python && (/^[ \t]*(?:if|elif|while)\b/.test(prefix) || field.toLowerCase() === 'email' && /\bprint\([f]?["']/.test(prefix))) continue;
      if (python && /\b(?:print|getpass\.getpass)\(/.test(prefix) && /^["'][),;]*$/.test(value)) continue;
    }
    const valueStart = match.indices.groups.bare?.[0];
    const expression = literal === undefined && (/^(?:null|None|undefined|str|string|number|integer|boolean|object|array|true|false)$/.test(value) ||
      json && /^[{[]/.test(value) || /^(?:process\.env|os\.environ|config[.[]|bindings?[.[]|credentials?[.[])/.test(value) ||
      python && pythonReference(value, text.slice(valueStart).split('\n', 1)[0]));
    if (!placeholder(value) && !expression) portabilityFailure('Reusable definitions contain a literal credential or account binding.', 'CREDENTIAL_LITERAL', lineAt(text, match.index + (match[0].match(/^\s*/u)?.[0].length || 0)));
  }
}
