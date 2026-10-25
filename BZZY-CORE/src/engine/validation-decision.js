// A typed final-review claim, never an acceptance receipt. Core separately
// verifies original requirements, inspection, provenance and evidence freshness.
export const finalValidationReportProtocol = 'validation-final-v1';
export const requestedValidationSeverity = objective => /\b(critical|high|medium|low)\b(?=[\s\S]{0,48}\b(?:severity|vulnerabilit\w*|finding|security\s+issue|impact)\b)/i.exec(objective || '')?.[1]?.toLowerCase();
const outcomes = ['supported', 'unsupported', 'inconclusive'];
const dispositions = ['accepted', 'resolved', 'rejected', 'unresolved'];
const lists = ['acceptedConclusions', 'rejectedClaims', 'corrections', 'remainingObjections', 'nextVerificationSteps'];
const statusFor = value => value === true ? 'supported' : value === false ? 'unsupported' : 'inconclusive';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, bytes) => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= bytes && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(value);
const fail = message => { throw Object.assign(new Error(`Final review: ${message} Correct finish_assignment and submit again; no final report was saved.`), { code: 'INVALID_VALIDATION_DECISION' }); };
const boundedText = maxLength => ({ type: 'string', minLength: 1, maxLength });
const evidenceSchema = { type: 'array', maxItems: 32, items: { type: 'string', minLength: 36, maxLength: 36 } };
const structure = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });

export function validationDecisionSchema({ objective, criteria } = {}) {
  const evidence = structuredClone(evidenceSchema), rationale = boundedText(2000);
  const ids = Array.isArray(criteria) ? criteria.map(item => item.id) : null;
  const criterion = structure({ id: ids?.length ? { type: 'string', enum: ids } : boundedText(64),
    status: { type: 'string', enum: [...outcomes] }, rationale, evidence });
  const goal = structure({ objective: objective ? { type: 'string', const: objective, maxLength: 16000 } : boundedText(16000),
    rationale, evidence, criteria: { type: 'array', minItems: ids?.length || 1, maxItems: ids?.length || 128, items: criterion },
    severity: structure({ requested: boundedText(64), assessed: boundedText(64), rationale, evidence }) }, ['objective', 'rationale', 'evidence', 'criteria']);
  return structure({ ...Object.fromEntries(lists.map(key => [key, { type: 'array', maxItems: 128, items: boundedText(3000) }])),
    objectionDispositions: { type: 'array', maxItems: 128, items: structure({ id: boundedText(128),
      status: { type: 'string', enum: [...dispositions] }, rationale, evidence }) },
    goalSatisfaction: { type: 'string', enum: [...outcomes], description: 'Use supported, unsupported or inconclusive; never true, false or null here.' },
    goalAssessment: goal });
}

export const finalValidationDecisionInstructions = `For status complete, partial or inconclusive, finish_assignment MUST include validationAssessment and decision. If blocked or needs_context, explain the blocker or use the context-request fields instead of inventing an assessment.
decision has EXACT fields acceptedConclusions, rejectedClaims, corrections, remainingObjections, nextVerificationSteps (each an array of concise strings), objectionDispositions (an array), goalSatisfaction (the STRING supported, unsupported or inconclusive), and goalAssessment.
Each objectionDispositions entry has EXACT fields id, status (accepted, resolved, rejected or unresolved), rationale and evidence (recorded artifact IDs). Use the field status, never disposition. Include every persistent objection exactly once; retain unresolved dissent.
goalAssessment has objective (the exact ORIGINAL objective), rationale, evidence (recorded IDs), criteria (every ORIGINAL criterion exactly once as {id,status:supported|unsupported|inconclusive,rationale,evidence}), and severity:{requested,assessed,rationale,evidence} when severity is requested. Each decision status must agree with its matching validationAssessment achieved value: true maps to supported, false to unsupported, null to inconclusive. All decision evidence must also occur in this report's evidence array. The decision is a model claim and cannot bypass host acceptance checks.`;

export function normalizeValidationDecision(input, { objective, criteria, evidence = [], validationAssessment } = {}) {
  const shape = (value, keys, label, required = keys) => {
    if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(`${label} requires the exact documented fields.`);
  };
  const evidenceIds = (value, label) => {
    if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length || value.some(id => typeof id !== 'string' || !uuid.test(id) || !evidence.includes(id))) fail(`${label} must use canonical artifact IDs also listed in report.evidence.`);
    return [...value];
  };
  shape(input, [...lists, 'objectionDispositions', 'goalSatisfaction', 'goalAssessment'], 'decision');
  if (!outcomes.includes(input.goalSatisfaction)) fail('decision.goalSatisfaction must be the string supported, unsupported or inconclusive, never a boolean.');
  if (!plain(validationAssessment) || ![true, false, null].includes(validationAssessment.achieved) || !Array.isArray(validationAssessment.criteria) ||
      input.goalSatisfaction !== statusFor(validationAssessment.achieved)) fail('decision.goalSatisfaction must agree with validationAssessment.achieved.');
  const result = {};
  for (const key of lists) {
    if (!Array.isArray(input[key]) || input[key].length > 128 || input[key].some(item => !text(item, 3000))) fail(`decision.${key} must be a bounded array of concise strings.`);
    result[key] = input[key].map(item => item.trim());
  }
  if (!Array.isArray(input.objectionDispositions) || input.objectionDispositions.length > 128) fail('decision.objectionDispositions must be a bounded array.');
  const seen = new Set();
  result.objectionDispositions = input.objectionDispositions.map(item => {
    shape(item, ['id', 'status', 'rationale', 'evidence'], 'decision.objectionDispositions entry (use status, never disposition)');
    if (!text(item.id, 128) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item.id) || seen.has(item.id) || !dispositions.includes(item.status) || !text(item.rationale, 2000)) fail('Each objection needs one unique id, status accepted/resolved/rejected/unresolved and rationale.');
    seen.add(item.id); return { id: item.id, status: item.status, rationale: item.rationale.trim(), evidence: evidenceIds(item.evidence, 'Objection disposition evidence') };
  });
  const goal = input.goalAssessment;
  shape(goal, ['objective', 'rationale', 'evidence', 'criteria', 'severity'], 'decision.goalAssessment', ['objective', 'rationale', 'evidence', 'criteria']);
  if (goal.objective !== objective || !text(goal.rationale, 2000)) fail('decision.goalAssessment needs the exact original objective and rationale.');
  if (!Array.isArray(criteria) || !criteria.length || !Array.isArray(goal.criteria) || goal.criteria.length !== criteria.length) fail('decision.goalAssessment.criteria must cover every original criterion exactly once.');
  const expected = new Map(criteria.map(item => [item.id, item])), assessed = new Map(validationAssessment.criteria.map(item => [item.id, item]));
  const used = new Set();
  const finalCriteria = goal.criteria.map(item => {
    shape(item, ['id', 'status', 'rationale', 'evidence'], 'decision.goalAssessment criterion');
    if (!expected.has(item.id) || used.has(item.id) || !outcomes.includes(item.status) || !text(item.rationale, 2000)) fail('Each decision criterion needs its original unique id, status and rationale.');
    if (!assessed.has(item.id) || item.status !== statusFor(assessed.get(item.id).achieved)) fail(`decision criterion ${item.id} must agree with validationAssessment.`);
    used.add(item.id); return { id: item.id, status: item.status, rationale: item.rationale.trim(), evidence: evidenceIds(item.evidence, 'Criterion evidence') };
  });
  result.goalSatisfaction = input.goalSatisfaction;
  result.goalAssessment = { objective, rationale: goal.rationale.trim(), evidence: evidenceIds(goal.evidence, 'Goal evidence'), criteria: finalCriteria };
  const requested = requestedValidationSeverity(objective);
  if (requested && input.goalSatisfaction === 'supported' && goal.severity === undefined) fail(`The original goal requests ${requested} severity; decision.goalAssessment.severity needs a separate impact assessment.`);
  if (goal.severity !== undefined) {
    shape(goal.severity, ['requested', 'assessed', 'rationale', 'evidence'], 'decision.goalAssessment.severity');
    const severity = goal.severity;
    if (!text(severity.requested, 64) || !text(severity.assessed, 64) || !text(severity.rationale, 2000)) fail('Severity requires requested, assessed and rationale text; explain uncertainty explicitly.');
    result.goalAssessment.severity = { requested: severity.requested.trim(), assessed: severity.assessed.trim(), rationale: severity.rationale.trim(), evidence: evidenceIds(severity.evidence, 'Severity evidence') };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 64000) fail('decision exceeds the 64 KiB report limit.');
  return result;
}
