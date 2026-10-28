import { digest } from './database.js';
import { maskLearningText } from './learning.js';
import { sharedSecrets } from './share-bundle-policy.js';

const MAX_SOURCE_BYTES = 128 * 1024, MAX_PREVIEW_BYTES = 600;
const email = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/g;
const controls = /\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu;

function prefix(value, bytes = MAX_PREVIEW_BYTES) {
  let result = '', size = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character);
    if (size + length > bytes) break;
    result += character; size += length;
  }
  return result;
}

// Internal immutable source data only. The complete objective is ephemeral
// redaction context, never a model field or a newly persisted copy. Its hash
// covers changes beyond the bounded prefix without depending on current keys.
export function assignmentTaskSource(value) {
  if (typeof value !== 'string') return null;
  if (value.length > MAX_SOURCE_BYTES || Buffer.byteLength(value) > MAX_SOURCE_BYTES) return { omitted: 'over_128_kib' };
  if (!value.trim()) return null;
  const text = prefix(value);
  return { text, fullText: value, sha256: digest(value), truncated: text.length < value.length };
}

// Preserve character offsets while masking the entire original, including
// credentials crossing a preview boundary and plain private email aliases.
// Target hostnames and paths remain useful task data; no text grants authority.
export function maskAssignmentTaskText(value) {
  const text = String(value), addresses = text.match(email) || [];
  const masked = maskLearningText(text, [...sharedSecrets(), ...addresses]);
  return { ...masked, text: masked.text.replace(controls, match => masked.marker.repeat([...match].length)) };
}

export function sanitizedTaskPreview(value) {
  const source = assignmentTaskSource(value);
  if (!source) return undefined;
  if (source.omitted) return '[Task omitted: original exceeds the 128 KiB privacy bound.]';
  const masked = maskAssignmentTaskText(source.fullText);
  let text = '', masking = false;
  for (const character of masked.text) {
    if (character === masked.marker) { if (!masking) text += '[redacted]'; masking = true; }
    else { text += character; masking = false; }
  }
  return prefix(text.replace(/\s+/gu, ' ').trim());
}
