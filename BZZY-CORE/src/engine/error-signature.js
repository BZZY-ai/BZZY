import { digest } from './database.js';
import { sanitizeLearningText } from './learning.js';

const cleanIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:+/-]{1,120}$/.test(value) ? value : null;

// Navigation identity, never a claim that two failures have the same cause.
// Preserve semantic numbers (HTTP/SQLSTATE/ABI/version); redact before removing
// variable paths and request identities so normalization cannot expose secrets.
export function normalizeErrorSignature(value, { tool, platform, version, ecosystem } = {}) {
  // Mask the complete input before bounding or folding whitespace. A credential
  // split over lines or the truncation boundary must not become a partial token.
  const masked = String(value || '').replace(/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|cookie|authorization)["']?\s*[:=]\s*(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$))/gi, '$1=<redacted>');
  let text = sanitizeLearningText(masked).slice(0, 128 * 1024)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?\b/g, '<time>')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, '<id>')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|private|var|workspace|app|opt)\/)[^\s"'<>]+/g, '<path>')
    .replace(/\b(?:request|trace|correlation)[-_ ]?id\s*[=:]\s*[^\s,;]+/gi, 'request-id=<id>')
    .replace(/\b0x[a-f0-9]{9,}\b/gi, '<address>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds?|seconds?|ms)\b/gi, '<duration>')
    .replace(/\s+/g, ' ').trim();
  const errorClass = text.match(/\b([A-Za-z][A-Za-z0-9_]*(?:Error|Exception))\b/)?.[1]
    || text.match(/\b(ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|EADDRINUSE|EPIPE|ENOMEM)\b/)?.[1] || null;
  const errorCode = text.match(/\bSQLSTATE[\s\[(:=]+([A-Z0-9]{5})\b/i)?.[1]?.toUpperCase()
    || text.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?)\s*[:=]?\s*([1-5]\d{2})\b/i)?.[1]
    || text.match(/\b(?:error|code)\s*[:=]?\s*(0x[a-f0-9]+|E[A-Z0-9_]+|[A-Z][A-Z0-9_]{3,})\b/i)?.[1]
    || (errorClass?.startsWith('E') ? errorClass : null);
  const inferred = /\b(?:npm|pnpm|yarn|node\.js|node_modules)\b/i.test(text) ? 'node'
    : /\b(?:python|pip|ModuleNotFoundError|ImportError)\b/i.test(text) ? 'python'
      : /\b(?:SQLSTATE|postgres|psql)\b/i.test(text) ? 'postgres'
        : /\b(?:cargo|rustc)\b/i.test(text) ? 'rust' : null;
  text = text.slice(0, 1600);
  const signature = { version: cleanIdentifier(version), tool: cleanIdentifier(tool), platform: cleanIdentifier(platform),
    ecosystem: cleanIdentifier(ecosystem) || inferred, errorClass, errorCode, normalizedMessage: text };
  return { ...signature, signatureHash: digest({ schemaVersion: 1, ...signature }), schemaVersion: 1 };
}

export function signatureApplies(candidate, query) {
  return ['tool', 'platform', 'ecosystem', 'version', 'errorClass', 'errorCode'].every(field =>
    !candidate[field] || query[field] === candidate[field]);
}
