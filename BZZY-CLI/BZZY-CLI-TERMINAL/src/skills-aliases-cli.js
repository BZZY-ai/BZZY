import { getSkillSignupAliases, setSkillSignupAliases, clearSkillSignupAliases } from '@bzzy/core/engine/skill-account-policy.js';

const usage = 'Use bzzy skills aliases set NAME EMAILS, show NAME, or clear NAME. Separate aliases with semicolons inside quotes, or pass separate arguments.';

export function skillsAliasesCLI(args, options, ui) {
  const [action, identifier, ...values] = args;
  if (!['set', 'show', 'clear'].includes(action) || !identifier || (action === 'set' ? !values.length : values.length)) throw new Error(usage);
  const context = { projectRoot: options.cwd }, current = getSkillSignupAliases(identifier, context);
  if (action === 'show') {
    const aliases = current?.approvedSignupAliases || [];
    ui.event('info', { skillId: current?.skillId || identifier, approvedSignupAliases: aliases, revision: current?.revision || 0,
      message: aliases.length ? `Approved signup aliases for ${current.skillId}:\n${aliases.join('\n')}` : `No local signup aliases configured for ${identifier}.` });
    return 0;
  }
  if (action === 'clear') {
    const result = clearSkillSignupAliases(identifier, { ...context, expectedRevision: current?.revision || 0 });
    ui.event('info', { skillId: result.skillId, cleared: result.cleared,
      message: `Local signup aliases cleared for ${result.skillId}.` });
    return 0;
  }
  const aliases = values.flatMap(value => value.split(/[;,\s]+/u).filter(Boolean));
  const result = setSkillSignupAliases(identifier, aliases, { ...context, expectedRevision: current?.revision || 0 });
  ui.event('info', { skillId: result.skillId, aliasCount: result.approvedSignupAliases.length, revision: result.revision,
    message: `Saved ${result.approvedSignupAliases.length} approved signup aliases for ${result.skillId} on this host. Mailbox authentication is configured separately.` });
  return 0;
}
