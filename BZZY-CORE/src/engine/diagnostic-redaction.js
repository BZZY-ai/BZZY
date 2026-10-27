import os from 'node:os';
import { sharedSecrets } from './share-bundle-policy.js';
import { sanitizeMissionValue } from './mission-context.js';

const privateField = /^(?:token|nonce|api[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|auth[_-]?tokens?|ownerToken|deviceToken|passwords?|passwd|secrets?|clientSecret|secretAccessKey|accessKeyId|signingSecret|boxSecret|privateKey|cookies?|set-cookie|authorization|credentials|accountBindings?|accountId|email|environment|env|backendHomes|backendProcess|engineHome|engineThreadId|engineSessionId|runner|launcher|inputOwner|inputLease|coreGrantId|toolBindings|notifications|notificationDestinations|workflowAdmission|workflowSelection|workflowReceipt|workflowBinding|reasoning|reasoning_content|reasoningContent|thinking|analysis|chainOfThought)$/i;
const privateSuffix = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i;
const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value || {}, field)).map(field => [field, value[field]]));
export { pick as diagnosticFields };

// An allowlisted projection must precede this second-line scrubber. It cannot
// establish that arbitrary conversation/evidence text contains no private data.
export function diagnosticRedactor({ roots = [], secrets = sharedSecrets(), maxString = 65536, maxItems = 256, maxDepth = 16, maxFields = 128 } = {}) {
  const stats = { redactedValues: 0, shortenedValues: 0 };
  const replacements = [...new Set(roots.filter(root => typeof root === 'string' && root.length > 3))]
    .sort((a, b) => b.length - a.length).map(root => [root, '[project]']);
  replacements.push([os.homedir(), '[home]']);
  const scrub = (value, depth = 0) => {
    if (typeof value === 'string') {
      let text = sanitizeMissionValue(value, { secrets });
      text = text.replace(/<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|analysis|reasoning)>|$)/gi, '[omitted: private-reasoning]');
      text = text.replace(/\bBZZY-(?:LIBRARY|TERMINAL|AGENT|PAIR)-[A-Za-z0-9_.-]+/g, '[redacted-code]')
        .replace(/\b(?:set-cookie|cookie|authorization)["']?[ \t]*:[^\r\n]*/gi, '[redacted-header]')
        .replace(/\b(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)|token|account[_-]?id)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)(?:;[^\r\n]*)?/gi, '[redacted-binding]')
        .replace(/\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
        .replace(/--(?:api[-_]key|(?:access[-_]|auth[-_])?token|password|passwd|secret|cookie)(?:=|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;]+)/gi, '[redacted-flag]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-account]');
      for (const [root, label] of replacements) text = text.replaceAll(root, label);
      text = text.replace(/\/(?:Users|home)\/[^\s/"'<>]+/g, '[home]');
      if (text !== value) stats.redactedValues++;
      // Bound individual payloads, never silently drop the session's old tail.
      if (text.length > maxString) { stats.shortenedValues++; text = text.slice(0, maxString) + `\n[omitted ${text.length - maxString} characters: diagnostic field limit]`; }
      return text;
    }
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (depth >= maxDepth) { stats.shortenedValues++; return '[omitted: diagnostic nesting limit]'; }
    if (value && typeof value === 'object' && /^(?:reasoning|thinking|analysis)$/i.test(value.type || '')) { stats.redactedValues++; return { omitted: 'private-reasoning' }; }
    if (Array.isArray(value)) {
      const entries = value.slice(0, maxItems).map(item => scrub(item, depth + 1));
      if (entries.length < value.length) { stats.shortenedValues++; entries.push({ omittedItems: value.length - entries.length }); }
      return entries;
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value), result = {};
      for (const [key, child] of entries.slice(0, maxFields)) {
        if (privateField.test(key) || privateSuffix.test(key)) { stats.redactedValues++; continue; }
        if (key === 'value' && typeof value.name === 'string' && privateField.test(value.name)) { stats.redactedValues++; result[key] = '[redacted]'; continue; }
        result[key] = scrub(child, depth + 1);
      }
      if (entries.length > maxFields) { stats.shortenedValues++; result.omittedFields = entries.length - maxFields; }
      return result;
    }
    return undefined;
  };
  return { scrub, stats };
}
