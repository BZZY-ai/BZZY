const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_VALIDATION_ASSESSMENT' }); };
const plain = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).every(key => keys.includes(key));
const triState = value => value === true || value === false || value === null;
const bounded = (value, bytes) => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= bytes && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value);
const artifactId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export function naturalValidationSummary(value) {
  if (!bounded(value, 3000) || /^(?:true|false|null)[.!?]?$/i.test(value.trim())) return false;
  try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' || typeof parsed === 'boolean' || parsed === null) return false; } catch {}
  return true;
}

// This is a bounded model claim, never a completion/permission grant. Evidence
// ownership and source freshness are checked by the caller using host records.
export function normalizeValidationAssessment(input, { objective, criteria, evidence = [] } = {}) {
  if (!plain(input, ['objective', 'achieved', 'criteria']) || !triState(input.achieved) || !bounded(input.objective, 16000) || input.objective !== objective) {
    fail('Validation requires the exact original goal and achieved true, false or null.');
  }
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 128 || !Array.isArray(input.criteria) || input.criteria.length !== criteria.length ||
      !Array.isArray(evidence) || evidence.length > 32 || evidence.some(id => !artifactId(id)) || new Set(evidence).size !== evidence.length) {
    fail('Validation must assess every original acceptance criterion and cite bounded canonical evidence IDs.');
  }
  const allowed = new Set(evidence), expected = new Set(criteria.map(item => item.id));
  if (expected.size !== criteria.length || [...expected].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) fail('Original validation criteria are invalid.');
  const seen = new Set(), assessed = input.criteria.map(item => {
    if (!plain(item, ['id', 'achieved', 'rationale', 'evidence']) || !expected.has(item.id) || seen.has(item.id) || !triState(item.achieved) ||
        !bounded(item.rationale, 2000) || !Array.isArray(item.evidence) || item.evidence.length > 32 ||
        item.evidence.some(id => !artifactId(id) || !allowed.has(id)) || new Set(item.evidence).size !== item.evidence.length ||
        item.achieved !== null && !item.evidence.length) fail('Each original criterion needs one explicit assessment, rationale and scoped evidence references.');
    seen.add(item.id); return { id: item.id, achieved: item.achieved, rationale: item.rationale.trim(), evidence: [...item.evidence] };
  });
  if (input.achieved === true && (!evidence.length || assessed.some(item => item.achieved !== true)) ||
      input.achieved === false && (!evidence.length || !assessed.some(item => item.achieved === false))) {
    fail('The overall validation assessment must agree with the original criterion assessments and evidence.');
  }
  const result = { objective: input.objective, achieved: input.achieved, criteria: assessed };
  if (Buffer.byteLength(JSON.stringify(result)) > 64000) fail('The structured validation assessment exceeds 64 KiB.');
  return result;
}

export function remapValidationAssessment(input, aliases) {
  return { ...input, criteria: input.criteria.map(item => ({ ...item, evidence: item.evidence.map(id => aliases.get(id) || id) })) };
}
