export const chatHelp = `Modes
  --parallel   2–3 agents pursue one goal independently.
  --validate     2–3 agents investigate and validate one goal.
  --delegate   A strong brain model plans and reviews; a cheaper executor does the work.
  --besties    2–3 agents collaborate on a shared goal and review each other’s evidence.

/goal              Reuse, import or export saved goals; choosing an objective starts a fresh goal here.
/goal <objective>  Start a goal; save reusable objectives manually in the Goals tab.
/goal status       Inspect the current goal without starting work.
/goal resume       Continue a paused or stalled goal from its saved checkpoint.
/delegate          Switch this paused chat to the saved Delegate combo (or choose its two agents).
/validate            Validate an achieved goal immediately; otherwise switch this paused chat to its saved combo.
/solo              Return this paused chat to its previous single agent; /singular is an alias.
Pause with /pause or /goal pause before either switch. History and the saved goal stay in this chat; switching never resumes work.
/default           Save this mode’s agents, models and efforts separately.
--parallel, --besties, --validate, --delegate reuse their saved presets automatically.
--default requires a matching saved preset.
/alias [name]      Name this session; omit the name to open a prompt.
/session-folder    Show the actual .bzzy folder tied to this saved chat; click its header path to copy it.
--alias NAME       Name a new session, e.g. bzzy --alias trabajo_01.
/sessions          Open named terminal chats; ↑/↓ select, Enter open, Esc back.
bzzy sessions      The same alias-only list, newest activity first; restores the original directory.
--attach NAME      Open a saved session by alias or ID; --view NAME observes it.
/export [FILE.zip] Export the complete project, sessions, history, notes and evidence.
/share             Share this complete terminal through Relay with an expiring QR/code.
/share library     Share skills, agents, workflows and saved goals through Relay.
/library           Create a Library code or install missing entries from another host.
/library share agents skills  Share only agents and skills; omit types for a checkbox picker.
/import [CODE]     Import a Library or full terminal copy; omit CODE for hidden entry.
/skills            Browse shared workflows; /skills sync copies Codex skills for all models.
/agents            Create and view reusable specialist subagents for any supported model.
/create-skill <description> Ask for a name, then create and enable a global Core skill with the current model.
/create-agent <description> Ask for a name, then create a global Core specialist with the current model.
/workflow          Choose one workflow or None for future goals; manage them from the Workflows tab.
/metrics           Inspect recorded skill, specialist and worker usage for this goal or chat.
/debug             Export this chat with skill/agent definitions to NAME_debug_ddmmyyyy.md here.
/full_debug_export Export complete scoped session/memory/learning data and project context as a ZIP.
/memory [query]    Search this engagement's findings, memory and past conversations.
/learn             Review learning jobs, candidate skills and private user/host preferences.
--import FILE.zip|CODE Restore a project ZIP or Relay terminal copy here; keeps work paused.
/skill_that [name] Turn the last completed goal into SKILL.md with detailed steps and references.
/doctor            Test the current subscription login, backend connection and model reply.
/settings          Workspace, iPhone, Core and private DeepSeek/Abliteration/OrcaRouter API-key setup.
/settings default-models  Edit all provider/model/effort defaults in one table; /settings modes is an alias.
/yolo              Toggle native permission bypass for this terminal’s next run.
/color blue|black|white Switch the complete TUI palette; each launch defaults to blue.
bzzy settings      Open Settings directly without starting a conversation.
bzzy doctor        Check both installed backends; add --live to test actual replies.

/models · /effort · /providers · /usage · /pause · /cancel · /exit
Option+Delete / Alt+Backspace · Ctrl+W delete the previous word at the cursor.
Tab / Shift+Tab switch agent chats. bzzy --help lists options; bzzy --whoami explains the full system.`;

export const chatCommands = [
  { command: '/update', description: 'Check GitHub and update CLI and Core together' },
  { command: '/skills', description: 'View, sync Codex skills, import and enable shared Core skills' },
  { command: '/agents', description: 'Create, view and use reusable specialist subagents across models' },
  { command: '/create-skill', description: 'Create an enabled global skill with the current model', argument: true },
  { command: '/create-agent', description: 'Create a global specialist with the current model', argument: true },
  { command: '/workflow', description: 'Choose a workflow or None for future goals' },
  { command: '/metrics', description: 'Inspect recorded goal and chat skill, specialist and worker usage' },
  { command: '/debug', description: 'Export session history and skill/agent definitions to a debug file' },
  { command: '/full_debug_export', description: 'Export full session, memory, learning, notes and evidence as a ZIP' },
  { command: '/goal', description: 'Choose a saved goal, or add an objective to start a new one' },
  { command: '/yolo', description: 'Toggle native permission bypass for the next run' },
  { command: '/validate', description: 'Check the original goal and evidence; add a focus to review a reply' },
  { command: '/models', description: 'Choose a model and reasoning effort' },
  { command: '/effort', description: 'Choose the current model’s reasoning effort' },
  { command: '/memory', description: 'Search project knowledge and past conversations', argument: true },
  { command: '/learn', description: 'Review learning jobs, fixtures, candidates and preferences' },
  { command: '/color', description: 'Switch the full palette: blue, black or white', argument: true },
  { command: '/providers', description: 'Choose a provider and model from Core' },
  { command: '/default', description: 'Save this mode’s provider, models, efforts and full agent combo' },
  { command: '/delegate', description: 'Switch this paused chat to Delegate' },
  { command: '/solo', description: 'Switch this paused chat back to a single agent' },
  { command: '/alias', description: 'Name this session and keep its working directory' },
  { command: '/session-folder', description: 'Show this saved chat’s actual .bzzy folder and its status' },
  { command: '/sessions', description: 'Open a saved named terminal chat' },
  { command: '/export', description: 'Export the complete project and context as a ZIP' },
  { command: '/share', description: 'Share a complete paused terminal copy through Relay' },
  { command: '/library', description: 'Share skills, agents, workflows and goals; install only missing entries by code' },
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
  if (!/^\/[a-z_-]*$/.test(value)) return [];
  return chatCommands.filter(item => item.command.startsWith(value));
}

export function privateChatCommand(value) { return /^\/(?:import|library|session-action|yolo|workflow|saved-goals|create-skill|create-agent)(?:\s|$)/.test(String(value).trim()); }
