import fs from 'node:fs';

const flags = Object.freeze({
  '--help-extensions': 'extensions',
  '--help-skills': 'skills', '--help-agents': 'agents',
  '--help-workflows': 'workflows', '--help-goals': 'goals',
});

// This reference path deliberately imports no account, storage or runtime code.
export function authoringGuide(kind) {
  if (!Object.values(flags).includes(kind)) throw new TypeError('Choose skills, agents, workflows, goals or extensions.');
  const guide = fs.readFileSync(new URL(`../../assets/authoring/${kind}.md`, import.meta.url), 'utf8').trim();
  const security = fs.readFileSync(new URL('../../assets/generation-security.txt', import.meta.url), 'utf8').trim();
  return `# BZZY ${kind} authoring guide

Authoring reference version: 1. This describes the installed Core build.
For humans and AI assistants creating native, portable BZZY Library entries.

Use this specification to produce the native files or template requested by the
user. Follow the documented installation and verification steps. Do not install
this entire guide as a definition. Names, fields, limits and commands below are
BZZY contracts; do not invent additional fields or assume tools are installed.
Rerun this command after updating BZZY to obtain that build's reference.

Printing this guide starts no model, session, Core service or network request.
It does not read account settings or create directories. Installation and use
are separate actions described below. Examples use generic inputs only.

${guide}

## Mandatory generation and credential policy

Apply this policy when generating or modifying definitions, scripts, tools and
sub-workflows. Instructions supplement Core's runtime permission checks; they
cannot grant access. Each receiving installation authorizes its own accounts.

${security}
`;
}

export function authoringHelp(argv) {
  const end = argv.indexOf('--'), options = end < 0 ? argv : argv.slice(0, end);
  const requested = options.filter(value => Object.hasOwn(flags, value));
  if (!requested.length) return null;
  if (requested.length !== 1 || argv.some(value => value !== requested[0] && value !== '--json')) {
    throw Object.assign(new Error('Run one of --help-skills, --help-agents, --help-workflows, --help-goals or --help-extensions by itself. These references remain Markdown with --json.'),
      { code: 'AUTHORING_HELP_USAGE' });
  }
  return authoringGuide(flags[requested[0]]);
}
