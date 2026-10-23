export const chatHelp = `Modes
  --parallel   2–3 agents pursue one goal independently.
  --debate     2–3 agents investigate and debate one goal.
  --delegate   A strong brain model plans and reviews; a cheaper executor does the work.
  --besties    2–3 agents collaborate on a shared goal and review each other’s evidence.

/goal <objective>  Start a goal, replacing the current one.
/default           Save this mode’s agents, models and efforts separately.
--default          Skip selection and reuse the saved preset, e.g. bzzy --parallel --default.
/alias [name]      Name this session; omit the name to open a prompt.
--alias NAME       Name a new session, e.g. bzzy --alias trabajo_01.
/sessions          Open named terminal chats; ↑/↓ select, Enter open, Esc back.
bzzy sessions      The same alias-only list, newest activity first; restores the original directory.
--attach NAME      Open a saved session by alias or ID; --view NAME observes it.
/export [FILE.zip] Export the complete project, sessions, history, notes and evidence.
/share             Share this complete terminal through Relay with an expiring QR/code.
/import [CODE]     Import a terminal copy here; omit CODE for hidden entry.
--import FILE.zip|CODE Restore a project ZIP or Relay terminal copy here; keeps work paused.
/skill_that [name] Turn the last completed goal into SKILL.md with detailed steps and references.
/doctor            Test the current subscription login, backend connection and model reply.
/settings          Workspace, iPhone, Core and private DeepSeek API-key setup.
/settings modes    Save models, efforts and counts for terminal agent modes.
/yolo              Toggle native permission bypass for this terminal’s next run.
bzzy settings      Open Settings directly without starting a conversation.
bzzy doctor        Check both installed backends; add --live to test actual replies.

/models · /providers · /usage · /pause · /cancel · /exit
Tab / Shift+Tab switch agent chats. bzzy --help lists options; bzzy --whoami explains the full system.`;

export const chatCommands = [
  { command: '/update', description: 'Check GitHub and update CLI and Core together' },
  { command: '/skills', description: 'View, create, import and enable shared Core skills' },
  { command: '/goal', description: 'Work until an objective is resolved', argument: true },
  { command: '/yolo', description: 'Toggle native permission bypass for the next run' },
  { command: '/debate', description: 'Choose agents to challenge the latest reply' },
  { command: '/models', description: 'Choose a model and reasoning effort' },
  { command: '/providers', description: 'Choose Codex, Claude or DeepSeek' },
  { command: '/default', description: 'Save this mode’s provider, models, efforts and full agent combo' },
  { command: '/alias', description: 'Name this session and keep its working directory' },
  { command: '/sessions', description: 'Open a saved named terminal chat' },
  { command: '/export', description: 'Export the complete project and context as a ZIP' },
  { command: '/share', description: 'Share a complete paused terminal copy through Relay' },
  { command: '/import', description: 'Import a terminal copy here using a hidden expiring code' },
  { command: '/skill_that', description: 'Turn a completed goal into a portable AI skill' },
  { command: '/usage', description: 'Show weekly quotas and the DeepSeek balance' },
  { command: '/doctor', description: 'Check subscription login, connection and a short model reply' },
  { command: '/chat', description: 'Show the conversation' },
  { command: '/room', description: 'Show besties messages, evidence and peer reviews' },
  { command: '/activity', description: 'Show detailed agent activity' },
  { command: '/http', description: 'Show observed HTTP requests' },
  { command: '/settings', description: 'Workspace, iPhone, Core and terminal mode defaults' },
  { command: '/copy', description: 'Select and copy text with your terminal' },
  { command: '/help', description: 'Show commands and shortcuts' },
  { command: '/new', description: 'Start a new conversation' },
  { command: '/pause', description: 'Pause the current execution' },
  { command: '/cancel', description: 'Cancel the current execution' },
  { command: '/tabs', description: 'List parallel agent chats' },
  { command: '/tab', description: 'Switch to an agent by number or name', argument: true },
  { command: '/detach', description: 'Leave execution running and close this view' },
  { command: '/exit', description: 'Exit this terminal session' },
];

export function commandSuggestions(value) {
  if (!/^\/[a-z_]*$/.test(value)) return [];
  return chatCommands.filter(item => item.command.startsWith(value));
}

export function privateChatCommand(value) { return /^\/(?:import|session-action|yolo)(?:\s|$)/.test(String(value).trim()); }
