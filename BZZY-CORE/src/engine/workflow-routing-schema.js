// Portable routing describes required consultation, never execution authority.
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => { throw Object.assign(new Error(message), { code: 'INVALID_WORKFLOW_ROUTING' }); };
export const routingDispositions = ['not_applicable', 'policy_excluded', 'blocked'];
const name = value => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 64;
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
function names(value, label, maximum = 16) {
  if (!Array.isArray(value) || value.length > maximum || value.some(item => !name(item)) || new Set(value).size !== value.length) fail(`Invalid ${label}. Use distinct lowercase names.`);
  return [...value];
}
export function normalizeCapabilities(value) {
  if (!exact(value, ['version', 'tags']) || value.version !== 1) fail('Specialist capabilities require version 1 and tags.');
  return { version: 1, tags: names(value.tags, 'specialist capability tags', 32) };
}
export function normalizeRouting(value) {
  if (!exact(value, ['version', 'requireWorkUnits', 'rules']) || value.version !== 1 || value.requireWorkUnits !== true ||
      !Array.isArray(value.rules) || !value.rules.length || value.rules.length > 64) fail('Routing requires version 1, requireWorkUnits true and 1–64 rules.');
  const rules = value.rules.map(rule => {
    if (!exact(rule, ['classId', 'specialist', 'skills', 'reportSkills', 'allowedDispositions']) || !name(rule.classId) ||
        rule.specialist !== undefined && !name(rule.specialist)) fail('Invalid routing rule class or specialist.');
    const skills = names(rule.skills === undefined ? [] : rule.skills, 'routing skills'), reportSkills = names(rule.reportSkills === undefined ? [] : rule.reportSkills, 'reporting skills');
    if (!rule.specialist && !skills.length && !reportSkills.length) fail('A routing rule must require a specialist or skill.');
    if (!Array.isArray(rule.allowedDispositions) || rule.allowedDispositions.some(item => !routingDispositions.includes(item)) ||
        new Set(rule.allowedDispositions).size !== rule.allowedDispositions.length) fail('Routing dispositions must explicitly permit only not_applicable, policy_excluded or blocked.');
    return { classId: rule.classId, ...(rule.specialist ? { specialist: rule.specialist } : {}), skills, reportSkills,
      allowedDispositions: [...rule.allowedDispositions] };
  });
  if (new Set(rules.map(rule => rule.classId)).size !== rules.length) fail('Routing class IDs must be distinct.');
  const result = { version: 1, requireWorkUnits: true, rules };
  if (Buffer.byteLength(JSON.stringify(result)) > 16 * 1024) fail('Routing metadata exceeds 16 KiB. Nothing was truncated.');
  return result;
}
