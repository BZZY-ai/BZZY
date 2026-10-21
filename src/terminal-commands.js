export const chatHelp = `Modes
  --parallel   2–3 agents pursue one goal independently.
  --debate     2–3 agents investigate and debate one goal.
  --delegate   A strong brain model plans and reviews; a cheaper executor does the work.
  --besties    2–3 agents collaborate on a shared goal and review each other’s evidence.

/goal <objective>  Start a goal, replacing the current one.
/default           Save this mode’s agents, models and efforts separately.
--default          Skip selection and reuse the saved preset, e.g. bzzy --parallel --default.

/models · /providers · /usage · /telegram · /pause · /cancel · /exit
Tab / Shift+Tab switch agent chats. bzzy --help lists options; bzzy --whoami explains the full system.`;

export const chatCommands = [
  { command: '/goal', description: 'Work until an objective is resolved', argument: true },
  { command: '/debate', description: 'Choose agents to challenge the latest reply' },
  { command: '/models', description: 'Choose a model and reasoning effort' },
  { command: '/providers', description: 'Choose Codex, Claude or DeepSeek' },
  { command: '/default', description: 'Save this mode’s provider, models, efforts and full agent combo' },
  { command: '/usage', description: 'Show weekly quotas and the DeepSeek balance' },
  { command: '/telegram', description: 'Open Telegram settings and conversation relay' },
  { command: '/chat', description: 'Show the conversation' },
  { command: '/room', description: 'Show besties messages, evidence and peer reviews' },
  { command: '/activity', description: 'Show detailed agent activity' },
  { command: '/http', description: 'Show observed HTTP requests' },
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

const telegramCommands = [
  { command: '/telegram pair', description: 'Pair your bot and detect the chat ID automatically' },
  { command: '/telegram attach', description: 'Mirror new messages and chat through Telegram' },
  { command: '/telegram detach', description: 'Stop Telegram chat forwarding' },
  { command: '/telegram setup', description: 'Pair the bot and detect the chat ID automatically' },
  { command: '/telegram on', description: 'Enable goal achieved and stalled notifications' },
  { command: '/telegram off', description: 'Disable Telegram notifications' },
  { command: '/telegram status', description: 'Show notification settings' },
];

export function commandSuggestions(value) {
  if (/^\/telegram\s+[a-z]*$/.test(value)) return telegramCommands.filter(item => item.command.startsWith(value));
  if (!/^\/[a-z]*$/.test(value)) return [];
  return chatCommands.filter(item => item.command.startsWith(value));
}
