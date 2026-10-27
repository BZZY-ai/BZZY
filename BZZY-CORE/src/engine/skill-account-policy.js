import fs from 'node:fs';
import path from 'node:path';
import { home, writeJson } from './files.js';
import { inspectSkill } from './skills.js';

const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message = 'The private skill account policy is unavailable. Check Core configuration.', code = 'SKILL_ACCOUNT_POLICY_INVALID') => {
  throw Object.assign(new Error(message), { code });
};
const email = value => typeof value === 'string' && value.length <= 254 && value.indexOf('@') <= 64
  && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
  && !value.startsWith('.') && !value.includes('..') && !value.includes('.@') && value.split('@')[1].split('.').every(label => label.length <= 63);
function aliases(value, { empty = false } = {}) {
  if (!Array.isArray(value) || value.length > 32 || !empty && !value.length || [...value].some(item => !email(item))
    || new Set(value.map(item => item.toLowerCase())).size !== value.length) {
    fail('Provide 1–32 distinct explicit email aliases without display names or surrounding whitespace.');
  }
  return [...value];
}
function configuration() {
  let fd;
  try {
    fd = fs.openSync(path.join(home(), 'config.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || stat.mode & 0o077
      || process.getuid && stat.uid !== process.getuid()) fail();
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!plain(value) || value.skillAccountPolicies !== undefined && !plain(value.skillAccountPolicies)) fail();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    fail(); // Parse fragments and filesystem details can contain private data.
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function skillFor(identifier, options) {
  const skill = inspectSkill(identifier, options);
  if (options.enabledOnly && !skill.enabled || options.expectedSkillVersion !== undefined && skill.version !== options.expectedSkillVersion
    || options.expectedSkillId !== undefined && skill.id !== options.expectedSkillId) {
    fail('The skill changed or is disabled. Reopen its current version.', 'SKILL_ACCOUNT_POLICY_STALE');
  }
  return skill;
}
function policyFor(config, skillId) {
  const policies = config.skillAccountPolicies;
  if (!policies || !Object.hasOwn(policies, skillId)) return null;
  const value = policies[skillId];
  if (!plain(value) || Object.keys(value).some(key => !['skillId', 'approvedSignupAliases', 'revision'].includes(key))
    || value.skillId !== skillId || !Number.isSafeInteger(value.revision) || value.revision < 1) fail();
  return { skillId, approvedSignupAliases: aliases(value.approvedSignupAliases, { empty: true }), revision: value.revision };
}
function checkRevision(value, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== (value?.revision || 0)) {
    fail('The private skill account policy changed. Reopen it before replacing it.', 'SKILL_ACCOUNT_POLICY_STALE');
  }
}

// Trusted host administration only. These methods are never model tools and
// policies never enter skill packages, immutable versions or Library archives.
export function getSkillSignupAliases(identifier, options = {}) {
  const skill = skillFor(identifier, options);
  return policyFor(configuration(), skill.id);
}

export function setSkillSignupAliases(identifier, value, options = {}) {
  const approvedSignupAliases = aliases(value), skill = skillFor(identifier, options), config = configuration();
  const previous = policyFor(config, skill.id); checkRevision(previous, options.expectedRevision);
  const next = { skillId: skill.id, approvedSignupAliases, revision: (previous?.revision || 0) + 1 };
  writeJson(path.join(home(), 'config.json'), { ...config, skillAccountPolicies: { ...config.skillAccountPolicies, [skill.id]: next } });
  return structuredClone(next);
}

export function clearSkillSignupAliases(identifier, options = {}) {
  const skill = skillFor(identifier, options), config = configuration(), previous = policyFor(config, skill.id);
  checkRevision(previous, options.expectedRevision);
  if (!previous?.approvedSignupAliases.length) return { skillId: skill.id, cleared: false, revision: previous?.revision || 0 };
  const next = { skillId: skill.id, approvedSignupAliases: [], revision: previous.revision + 1 };
  writeJson(path.join(home(), 'config.json'), { ...config, skillAccountPolicies: { ...config.skillAccountPolicies, [skill.id]: next } });
  return { skillId: skill.id, cleared: true, revision: next.revision };
}
