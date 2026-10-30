import { sharedSecrets, assertShareText } from './share-bundle-policy.js';

const secretAssignment = /\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*["']?[^\s"'<>]+/gi;

export function cleanKnowledgeText(value, maximum = 6000) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/<(?:think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/(?:think|analysis|reasoning)>|$)/gi, '')
    .replace(/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$))/gi, '$1=<redacted>')
    .replace(/\u0000/g, '').replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '<redacted authentication>')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1<redacted authentication>@')
    .replace(secretAssignment, '$1=<redacted>')
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, '<redacted private key>')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '<redacted credential>');
  for (const secret of sharedSecrets()) text = text.split(secret).join('<redacted credential>');
  return text.slice(0, maximum);
}
export function cleanKnowledgeValue(value) {
  if (typeof value === 'string') return cleanKnowledgeText(value);
  if (Array.isArray(value)) return value.slice(0, 100).map(cleanKnowledgeValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(?:backendHomes|backendProcess|engineHome|credentials|accountBindings|ownerToken|privateKey|reasoning|analysis|chainOfThought|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization|sourcePins|dependencySnapshot|dependencyValues)$/i.test(key))
    .map(([key, item]) => [key, cleanKnowledgeValue(item)]));
  return value;
}

export function assertKnowledgeText(value, maximum = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Knowledge text must be bounded plain text.');
  assertShareText(value, sharedSecrets());
  const quoted = [...value.matchAll(/\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*(?:"((?:\\[\s\S]|[^"\\])*)(?:"|$)|'((?:\\[\s\S]|[^'\\])*)(?:'|$))/gi)];
  if (quoted.some(match => !/^\s*(?:<redacted(?:[^>]*)>|\[redacted\])\s*$/i.test(match[1] ?? match[2])) || /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|authorization)["']?\s*[:=]\s*["']?(?!<)[^\s"'<>]+/i.test(value)
    || /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)
    || /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+(?::[^\s/@]*)?@/i.test(value)
    || /<(?:think|analysis|reasoning)\b/i.test(value)) throw new Error('Knowledge cannot contain authentication bindings or private reasoning.');
  return value.trim();
}

