import { extensionsCLI } from '@bzzy/core/engine/extensions-cli.js';
import { saveSessionDefaultSelection, savedDefaultMessage } from './session-defaults.js';
import fs from 'node:fs';
import path from 'node:path';
import { config, modeDefault, providers, getProvider, setDefault, addProvider, apiKey, saveKey, ensureApiKey, chooseProvider, saveDefaultSelection } from './providers.js';
import { chooseModel } from './models.js';
import { home, findSession, sessions, loadSession, normalizeSessionAlias, setSessionAlias } from './store.js';
import { chooseSavedSession, namedTerminalSessions, promptSessionAlias, queueSessionBrowser, sessionLabel } from './session-browser.js';
import { exportProject, importProject } from './project-bundle.js';
import { shareTerminal, relayImportArgument, forgetPrivateImportInput } from './share-ui.js';
import { libraryCommand, shareLibrary, importRelayShare } from './library-ui.js';
import { skillThat } from './skill-that.js';
import { skillsCommand as terminalSkillsCommand } from './skills-ui.js';
import { root } from './process.js';
import { checkConnections } from './connection-check.js';
import { UI } from './ui.js';
import { NotificationHub } from './notifications.js';
import { executeManaged, submitManagedGoal, viewSession, attachSession, changeSessionModel, conversationModeCommand, controlSession } from './runtime-client.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from './runtime.js';
import { agentChoice } from './delegation.js';
import { readContextFile } from './task.js';
import { reconcileSession, identityAlive } from './recovery.js';
import { recall, invalidateMemory } from './memory.js';
import { sandboxSupport } from './policy.js';
import { projectContext } from './project.js';
import { subscriptionStatus } from './auth.js';
import { prepareChatDebate, finishChatDebate, defaultChatDebateAgents } from './chat-debate.js';
import { restoreConversation, conversationInput } from './runtime-client.js';
import { changeConversationProvider } from './conversation-settings.js';
import { chooseDelegation, describeDelegation } from './delegation-setup.js';
import { chooseBestiesWithDefault, configuredBesties, describeBesties } from './besties-setup.js';
import { chooseParallelWithDefault, chooseParallelGoal, configuredParallel } from './parallel-setup.js';

import { chooseDebate, configuredDebate } from './debate-setup.js';
import { chooseSavedCombo } from './mode-presets.js';
import { chatHelp } from './terminal-commands.js';
import { whoami } from './whoami.js';
import { authoringHelp } from '@bzzy/core/engine/authoring-guides.js';
import { updateCoreAndCLI } from './update.js';
import { readUpdateHandoff, execUpdatedCLI } from './update-handoff.js';
import { retireTelegram } from './migrations.js';
import { backendCommand } from '@bzzy/core/engine/entry.js';
import { activateCLIHost, coreHostStatus, stopCoreHost, restartCoreHost } from '@bzzy/core/engine/host-service.js';
import { syncCodexSkills, skillSyncSummary, skillSyncReport } from '@bzzy/core/engine/skill-sync.js';
import { knowledgeCLI, sessionMemoryCLI, sessionCostCLI } from './knowledge-command.js';
import { subagentsCLI } from '@bzzy/core/engine/subagents-cli.js';
import { skillsAliasesCLI } from './skills-aliases-cli.js';
import { workflowsCLI } from '@bzzy/core/engine/workflows-cli.js';
import { workflowSelection } from '@bzzy/core/engine/workflows.js';
import { resolveInteractiveGoal } from './goal-controls.js';
import { createDebugExportProgressReporter, debugExportContextNotice, debugExportSummary } from './debug-export-progress.js';
import { namedGoalCLI } from './named-goal-command.js';
import { customNotificationCLI } from './custom-notification-command.js';
import { backgroundCLI } from './background-command.js';
import { selectedProvider, authenticateSubscription, applyLaunchDefault, createChatSession, openOrCreateChatSession, newConversation, startConversationGoal,
  prepareConversationTurn, controlSavedGoal, prepareResume, recordProjectMemory, createTaskSession, activateTaskGoal } from '@bzzy/core/engine/host-commands.js';

const HELP = `bzzy 0.2.0 · a persistent coding agent

Usage:
  bzzy [options]                         Open the Codex-style terminal chat
  bzzy "initial context" --goal "task"  Send context first, then start a durable goal
  bzzy --context-file FILE --goal "task" Load saved instructions and start the goal directly
  bzzy --preprompt FILE --goal "task" --detach  Same saved instructions; Core keeps running
  bzzy --background SCRIPT [--notif] -- ARG...  Submit a durable Core script job
  bzzy background list|status ID|logs ID|cancel ID  Inspect saved script jobs
  bzzy --codex|--claude|--deepseek        Open chat directly with that provider
  bzzy skills sync                     Choose and import Codex skill folders
  bzzy skills aliases set NAME EMAILS Set this host's explicit signup alias list
  bzzy skills aliases show NAME       Read this host's approved signup aliases
  bzzy skills aliases clear NAME      Clear this host's signup alias list
  bzzy extensions list                Manage native extensions (see --help-extensions)
  bzzy subagents list                  List reusable specialist subagents
  bzzy subagents create FILE.json      Save a specialist definition for this project
  bzzy workflows list                 List reusable project/global goal instructions
  bzzy workflows import FILE.txt --name NAME [--global]
  bzzy workflows use NAME --session ID --revision N [--workflow-revision N]
  bzzy workflows selection --session ID | clear --session ID --revision N
  bzzy library share                  Share skills, agents, workflows and goals by Relay code
  bzzy library share agents skills    Share only the named Library types
  bzzy library import                 Install missing Library entries from a hidden code
  bzzy knowledge search TEXT           Search this engagement's knowledge and past chats
  bzzy knowledge review [SESSION]      Queue a bounded lesson review for an existing chat
  bzzy session-memory status [SESSION] Inspect this session's history index and background budget
  bzzy session-memory cost [SESSION]   Inspect lifetime background compactor spending and historical gaps
  bzzy cost [SESSION]                  Inspect DeepSeek Chat + Compactor = Total estimates
  bzzy session-memory build [SESSION]  Index saved history without replaying the chat
  bzzy session-memory document [SESSION] Read a generated session MEMORY.md view
  bzzy session-memory export [SESSION] Save that view under .bzzy/sessions/SESSION/
  bzzy --delegate                       Choose brain and hands; chat normally or start /goal
  bzzy --besties                        Choose two peers; chat normally or start a shared /goal
  bzzy --parallel [2|3]                 Select agents, enter a goal, then open their chat tabs
  bzzy --validate                         Analyze, test, then validate the next reply
  bzzy run "task" [options]              Run one task
  bzzy goal "objective" [options]        Work until the goal completes or stalls
  bzzy goal status|pause|resume|clear [session]
  bzzy resume [session]                  Resume the latest session in this directory
  bzzy --view SESSION                   Replay history and watch without taking input
  bzzy --attach NAME                    Open a saved chat, or create a named chat here
  bzzy --resume SESSION                 Resume a saved chat or unfinished goal
  bzzy delegate "objective" --supervisor codex --executor deepseek
  bzzy validate "question" --artifact FILE --participant claude --participant deepseek
  bzzy parallel "objective" --agents codex,claude,deepseek
  bzzy besties "objective" --agents codex:MODEL,claude:MODEL
  bzzy service start|status|stop|restart|web  Manage the local background runtime
  bzzy recover [session]                Reconcile interrupted work without replaying it
  bzzy memory list|search TEXT|add FILE|invalidate ID REASON
  bzzy project                          Inspect this directory's .bzzy context
  bzzy activity [session] [--detailed]   Watch simple/detailed activity entries
  bzzy traffic [session]                Watch recorded outbound HTTP requests
  bzzy integration                      Explain API, live events and client integration
  bzzy service token SESSION            Create a session-scoped observer token
  bzzy service grants                   List session grants without token values
  bzzy service revoke GRANT_ID          Revoke a session token and its input lease
  bzzy service grant SESSION RECIPIENT PERMISSIONS [SECONDS]
                                       Grant explicit session actions to a client
  bzzy sessions                         Open named terminal chats; ↑/↓ select, Enter open
  bzzy debug export SESSION [FILE.md]   Export session + skills/agents here without stopping work
  bzzy debug full SESSION [FILE.zip] [--bounded]  Full diagnostic ZIP; --bounded limits project capture
  bzzy --full-debug-export SESSION [FILE.zip]    Detach full export; notify iPhone on completion/error
  bzzy debug full SESSION --detach              Same detached full export
  bzzy debug status JOB_ID                      Saved export progress, output path or failure
  bzzy full_debug_export SESSION [--bounded]    Same full debug ZIP in the current directory
  bzzy export [FILE.zip]                Export this directory and all saved project context
  bzzy --import FILE.zip|CODE          Restore a project ZIP or Relay terminal copy here
  bzzy setup                            Choose a backend and authenticate
  bzzy settings                         API key, default folder, Pair iPhone and Core controls
  bzzy --settings                       Open the full-screen Settings view directly
  bzzy auth [codex|claude|deepseek|name]  Log in or save an API key
  bzzy providers                        List providers
  bzzy provider use NAME                 Set the default provider
  bzzy provider add NAME --base-url URL --model MODEL --env-key KEY_NAME
  bzzy notifications [list|retry]        Inspect the delivery outbox
  bzzy doctor [--live]                   Verify CLI, subscription login and connection; --live tests replies

Options:
  --minimal             Use the ultra-compact transcript-only layout
  --provider NAME       Select a provider for a new session
  --model MODEL         Select a model (provider default otherwise)
  --cwd DIRECTORY       Working directory
  --alias NAME          Name a session; restore it later with --attach NAME or --resume NAME
  --workflow NAME       Select a workflow for new goals; use none to clear it
  --import FILE.zip|CODE Restore a project ZIP or expiring Relay terminal copy into --cwd; never starts work
  --g ACTION            With --attach: continue, pause or status of the saved goal; no chat UI
  --goal OBJECTIVE      Start a persistent goal; quoted positional text is sent first as context
  --context-file FILE   UTF-8 task instructions (up to 1 MiB), relative to --cwd; no initialization chat
  --preprompt FILE      Alias for --context-file; full instructions saved before work
  --custom-notification TEXT  Queue a custom iPhone push alert (up to 180 characters)
  --background SCRIPT   Run a script through Core and immediately return its job ID
  --timeout SECONDS     Script deadline (1–604800); omitted means no deadline
  --notif               Opt in to iPhone completion/failure alerts for this script
  --token-budget N      Optional goal token budget
  --max-turns N         Optional goal turn limit; pauses rather than completes
  --runtime N           Total active runtime limit in seconds
  --max-retries N       Bounded acceptance follow-ups (default 2)
  --contract FILE       Task JSON: constraints, criteria, artifacts, checks and limits
  --read-only           Enforce read-only tools (requires a working OS sandbox)
  --detach              Leave execution running after this terminal exits
  --follow              Keep a noninteractive view connected
  --mode MODE           solo, delegate, besties, validate or parallel
  --delegate            Choose supervisor/executor models; the brain plans, delegates and verifies
  --besties             2–3 agents work together on one goal and review each other’s evidence
  --validate              2–3 agents investigate and validate one goal
  --parallel [2|3]      Choose 2 or 3 agents, continue to goal setup, then open agent chat tabs
  --supervisor NAME     Supervisor provider, optionally provider:model
  --executor NAME       Delegation executor provider, optionally provider:model
  --supervisor-model M  Independently select the supervisor model
  --executor-model M    Independently select the executor model
  --participant NAME    Validate participant; repeat to select more agents
  --agents A,B[,C]      Parallel or besties agents; optionally provider:model
  --default             Reuse this mode’s saved preset without questions or selectors
  --whoami              Print the detailed architecture, storage and integration reference
  --help-api            Print the current Core API reference and integration examples
  --help-extensions     Print the complete native extension framework reference
  --help-skills         Print the complete native skill creation and sharing guide
  --help-agents         Print the complete specialist agent creation and sharing guide
  --help-workflows      Print the complete workflow creation and sharing guide
  --help-goals          Print the complete saved goal creation and sharing guide
  --update              Pull the latest source and reinstall bzzy
  --artifact FILE       Material to snapshot and validate
  --rounds N            Legacy review-only challenge limit (default 5, maximum 5)
  --review-only         Skip independent investigation; validate a fixed snapshot
  --concurrency N       Maximum active workers
  --request-id ID       Idempotency key for a retried request
  --no-capture-network  Disable automatic shell HTTP/HTTPS observation
  --capture-network     Enable shell HTTP/HTTPS observation (default)
  --detailed            Include detailed activity entries
  --effort LEVEL        Model reasoning effort
  --yolo                Disable Codex approvals AND sandbox; bypass Claude permissions
  --json                Emit JSONL events; unavailable approvals are denied
  --no-pet              Reduce terminal animation updates
  --device              Use Codex's device-code login
  -h, --help            Show help
  -v, --version         Show version

Chat commands: /goal (saved goals), /goal <objective>, /goal status|pause|resume|clear, /delegate, /validate, /solo,
/new, /alias [name], /sessions, /export [FILE.zip], /share, /import [CODE], /skills [sync], /agents, /create-skill <requirements>, /create-agent <requirements>, /workflow, /memory [query], /learn, /skill_that [name], /providers [name], /models [name|default], /effort, /default, /usage, /settings, /help, /exit
/providers chooses a provider; missing API keys are prompted securely.
Choosing a provider opens its model-and-effort picker, including the current provider.
Model/provider changes retain this session's chat; the new backend receives prior messages.
/default saves a separate preset for normal chat, delegate, validate, besties or parallel.
Mode flags automatically use their saved defaults; --default also requires a saved preset.
/validate on an achieved goal starts its review immediately. Otherwise /delegate and /validate switch this paused chat to their saved combo; /solo (or /singular) restores its previous single agent.
Use /pause or /goal pause first. Switching preserves history and goals and never resumes work.
/models: ↑/↓ chooses a model; ←/→ sets supported effort; Enter confirms.
/effort: choose a supported reasoning effort for the current model.
/provider and /model are aliases. /quit also exits.
Delegation: choose a strong brain and a less expensive executor; describe one overall goal.
Example after --delegate setup: Solve this CTF using the supplied challenge files.
Use /goal <objective> for persistent work. Plain messages stay ordinary chat with the primary model.
The brain creates assignments and verifies results during /goal execution.
Later messages steer the saved goal; /goal resume continues it. Model choices survive reattachment.
No default overall deadline; individual assignments are bounded. Use --runtime/--token-budget for limits.
Worker tokens and supervisor review both count; delegation does not guarantee a lower bill.
Besties: choose two peers with independent provider, model and effort; the same provider may appear twice.
Use /goal <objective> to start one shared persistent goal. Peers exchange findings and inspect evidence.
Completion requires both peers' acceptance checks and supported cross-reviews; disagreements remain visible.
Use Tab / Shift+Tab to switch peer chats, or --view / --attach with the group session ID.
Besties SHARED ROOM (/room) shows actual messages and evidence reviews exchanged by the peers.
/validate immediately checks an achieved goal against its original objective and evidence; add a focus to review a reply.
/debate and --debate remain compatibility aliases; saved configurations are preserved.
Validate: independent analysis and permitted tests, then read-only evidence rounds.
Type / for command suggestions: ↑/↓ chooses, Tab completes, Enter confirms.
Terminal: Ctrl+G cycles views; /chat, /activity, /http opens a view.
Click views, agent tabs and picker options; wheel or drag the right scrollbar.
Copy: drag a phrase, then Ctrl+C; click [c] beside a response to copy its full text.
Ctrl+V pastes into the composer; over SSH it can use the last text copied in bzzy.
Native selection: Ctrl+S or /copy, then your terminal's Copy (Cmd+C on Mac); Esc returns.
Terminal Paste (Cmd+V or Ctrl+Shift+V) also works. Clipboard support varies over SSH.
Option+Delete / Ctrl+W deletes a word; Option+arrows moves by words.
PgUp/PgDn scroll; Ctrl+O toggles tools; Alt+Enter or Ctrl+J inserts a newline.
Your latest message stays pinned; model, time, tokens and session ID stay visible.
Header: Codex and Claude weekly remaining; DeepSeek account balance. /usage shows sources.
~ marks cached values; — means unavailable. Claude uses native reports or its usage cache.
Activity shows readable summaries/details; raw commands are available with Ctrl+O in Chat.
During execution: text steers Codex; /pause, /cancel, /detach.
Parallel chats: Tab / Shift+Tab, /tabs, /tab NUMBER or NAME.
Use the group session ID with --view or --attach to open all agent chats.
--atach is accepted as an alias for --attach. Session IDs also accept unique prefixes.

Integration: local authenticated /v1 API, durable SSE events with reconnect cursors,
goal.completed / goal.stalled, usage.updated, activity and network.* records.
Run bzzy integration for endpoints, examples, permissions and capture coverage.

Subscription sign-in is handled by the official, unmodified backend CLIs.
API providers must support the Responses protocol in this version.
`;

export function parseArgs(argv) {
  const options = { cwd: process.cwd(), pet: true, yolo: false, json: false, captureNetwork: true };
  const args = [];
  const values = { '--g': 'goalAction', '--custom-notification': 'customNotification', '--provider': 'provider', '--model': 'model', '--cwd': 'cwd', '--alias': 'alias', '--import': 'importFile', '--goal': 'goal', '--context-file': 'contextFile', '--preprompt': 'contextFile', '--background': 'backgroundScript', '--timeout': 'timeoutSeconds', '--workflow': 'workflow',
    '--token-budget': 'tokenBudget', '--max-turns': 'maxTurns', '--effort': 'effort',
    '--base-url': 'baseUrl', '--env-key': 'envKey', '--context-window': 'contextWindow',
    '--view': 'view', '--attach': 'attach', '--atach': 'attach', '--resume': 'resume', '--mode': 'mode', '--supervisor': 'supervisor', '--executor': 'executor',
    '--supervisor-model': 'supervisorModel', '--executor-model': 'executorModel', '--participant': 'participant', '--agents': 'agents',
    '--artifact': 'artifact', '--rounds': 'rounds', '--runtime': 'runtimeSeconds', '--max-retries': 'maxRetries', '--contract': 'contract',
    '--concurrency': 'concurrency', '--request-id': 'requestId' };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--') { if (options.backgroundScript) options.scriptArgs = argv.slice(i + 1); else args.push(...argv.slice(i + 1)); break; }
    const equal = raw.indexOf('=');
    const flag = equal > 0 ? raw.slice(0, equal) : raw;
    if (args[0] === 'extensions' && flag === '--revision') {
      const value = equal > 0 ? raw.slice(equal + 1) : argv[++i];
      if (value === undefined) throw new Error('--revision requires a value.'); args.push(flag, value); continue;
    }
    if (args[0] === 'workflows' && ['--global', '--revision', '--workflow-revision', '--session', '--name', '--description'].includes(flag)) {
      if (flag === '--global') {
        if (equal > 0) throw new Error('--global does not take a value.');
        args.push(flag);
      } else {
        const value = equal > 0 ? raw.slice(equal + 1) : argv[++i];
        if (value === undefined || equal < 0 && value.startsWith('--')) throw new Error(`${flag} requires a value.`);
        args.push(flag, value);
      }
      continue;
    }
    if (Object.hasOwn(values, flag)) {
      const value = equal > 0 ? raw.slice(equal + 1) : argv[++i];
      if (!value || (equal < 0 && value.startsWith('--'))) throw new Error(`${flag} requires a value.`);
      if (flag === '--participant') (options.participants ||= []).push(value);
      else {
        if (flag === '--g' && options.goalAction !== undefined) throw new Error('Supply --g once.');
        if (['--preprompt', '--context-file'].includes(flag) && options.contextFile !== undefined) throw new Error('Supply --preprompt or --context-file once.');
        options[values[flag]] = value;
      }
    } else if (['--codex', '--claude', '--deepseek'].includes(raw)) options.provider = raw.slice(2);
    else if (flag === '--parallel' || flag === '--paralel') {
      options.mode = 'parallel'; options.parallelSetup = true;
      const value = equal > 0 ? raw.slice(equal + 1) : /^[+-]?\d+(?:\.\d+)?$/.test(argv[i + 1] || '') ? argv[++i] : null;
      if (value != null && !/^[23]$/.test(value)) throw new Error('--parallel requires 2 or 3 agents.');
      if (value != null) options.parallelCount = Number(value);
    }
    else if (raw === '--validate' || raw === '--debate') { options.mode = 'debate'; options.debateSetup = true; }
    else if (raw === '--default') options.useDefault = true;
    else if (raw === '--whoami') options.whoami = true;
    else if (raw === '--update') options.update = true;
    else if (raw === '--delegate') { options.mode = 'delegate'; options.delegationSetup = true; }
    else if (raw === '--besties') { options.mode = 'besties'; options.bestiesSetup = true; }
    else if (raw === '--review-only') options.reviewOnly = true;
    else if (raw === '--minimal') options.minimal = true;
    else if (raw === '--canvas') throw new Error('The canvas interface was removed. Run bzzy for terminal chat.');
    else if (raw === '--settings') options.settingsRequested = true;
    else if (raw === '--yolo') options.yolo = true;
    else if (raw === '--json') options.json = true;
    else if (raw === '--live') options.live = true;
    else if (raw === '--no-pet') options.pet = false;
    else if (raw === '--device') options.device = true;
    else if (raw === '--detach') options.detach = true;
    else if (raw === '--notif') options.notify = true;
    else if (raw === '--full-debug-export') {
      if (args.length) throw new Error('Use bzzy --full-debug-export SESSION [FILE.zip] as its own command.');
      args.push('debug', 'full'); options.detach = true;
    }
    else if (raw === '--follow') options.follow = true;
    else if (raw === '--read-only') options.readOnly = true;
    else if (raw === '--capture-network') options.captureNetwork = true;
    else if (raw === '--no-capture-network') options.captureNetwork = false;
    else if (raw === '--detailed') options.detailed = true;
    else if (raw === '--bounded') options.debugBounded = true;
    else if (['--help', '-h'].includes(raw)) options.help = true;
    else if (['--version', '-v'].includes(raw)) options.version = true;
    else if (args[0] === 'subagents' && ['--global', '--revision'].includes(raw)) args.push(raw);
    else if (raw.startsWith('-')) throw new Error(`Unknown option ${raw}. Run bzzy --help.`);
    else args.push(raw);
  }
  for (const key of ['tokenBudget', 'maxTurns', 'contextWindow', 'runtimeSeconds', 'rounds', 'concurrency', 'maxRetries', 'timeoutSeconds']) {
    if (options[key] != null) {
      if (!(key === 'maxRetries' ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`${key} must be ${key === 'maxRetries' ? 'a nonnegative' : 'a positive'} integer.`);
      options[key] = Number(options[key]);
    }
  }
  if (options.goalAction !== undefined) {
    if (!options.attach || !['continue', 'pause', 'status'].includes(options.goalAction)) throw new Error('Use --attach SESSION --g continue|pause|status.');
    if (args.length || Object.keys(options).some(key => !['cwd', 'pet', 'yolo', 'json', 'captureNetwork', 'attach', 'goalAction', 'detach', 'requestId', 'tokenBudget'].includes(key))
        || options.yolo || !options.captureNetwork || options.tokenBudget !== undefined && options.goalAction !== 'continue')
      throw new Error('--g controls the saved goal. Do not combine it with a new objective, preprompt, workflow, model or execution options.');
  }
  if (options.customNotification !== undefined && (args.length || Object.keys(options).some(key =>
      !['cwd', 'pet', 'yolo', 'json', 'captureNetwork', 'customNotification', 'requestId'].includes(key))
      || !options.pet || options.yolo || !options.captureNetwork)) throw new Error('Use --custom-notification TEXT with only --json, --request-id and optional --cwd.');
  if ((options.notify || options.timeoutSeconds) && !options.backgroundScript) throw new Error('--notif and --timeout require --background SCRIPT.');
  if (options.timeoutSeconds > 604800) throw new Error('--timeout cannot exceed 604800 seconds.');
  if (options.backgroundScript && (args.length || ['goal', 'contextFile', 'workflow', 'provider', 'model', 'effort', 'mode', 'view', 'attach', 'resume', 'contract', 'readOnly', 'yolo', 'alias', 'importFile'].some(key => options[key])))
    throw new Error('--background is a script command. Place literal script arguments after -- and use AI options with a separate goal command.');
  if ([options.view, options.attach, options.resume].filter(Boolean).length > 1) throw new Error('Choose --view, --attach or --resume.');
  if (options.debugBounded && !(args[0] === 'full_debug_export' || args[0] === 'debug' && args[1] === 'full')) throw new Error('--bounded is only available for bzzy debug full or bzzy full_debug_export.');
  if (options.workflow !== undefined && (options.view || options.resume || args[0] === 'resume' || args[0] === 'goal' && args[1] === 'resume')) throw new Error('--workflow selects instructions for new goals. Use it with chat, --attach or a new goal; saved goal resumes keep their original workflow.');
  if (options.mode === 'validate') options.mode = 'debate';
  if (options.mode && !['solo', 'delegate', 'besties', 'debate', 'parallel'].includes(options.mode)) throw new Error('Invalid execution mode.');
  if (options.yolo && options.readOnly) throw new Error('--yolo conflicts with --read-only.');
  if (options.useDefault && (options.agents || options.participants)) throw new Error('Use either --default or explicit --agents/--participant selections.');
  if (options.rounds > 5 || options.concurrency > 8) throw new Error('Maximum 5 validation rounds and 8 concurrent workers.');
  if (options.effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)) throw new Error('Invalid reasoning effort.');
  if (options.alias != null) options.alias = normalizeSessionAlias(options.alias);
  options.cwd = path.resolve(options.cwd);
  return { options, args };
}

// Chat creation saves an idle terminal before prompting for the first input.
// Library selection must use that exact terminal, never the latest session in
// a directory or a worker tab, and never start an execution to obtain an ID.
export function ensureCurrentTerminalSession(ui) {
  const id = ui.activeTab || ui.sessionId;
  if (!id) throw new Error('Open a terminal chat before selecting a workflow.');
  return loadSession(workflowSelection(id).sessionId);
}

async function authenticate(provider, ui, options, { reuseExisting = false } = {}) {
  if (provider.auth === 'api-key') {
    if (reuseExisting) { await ensureApiKey(provider, ui); return 0; }
    if (process.env[provider.envKey]) { ui.event('info', { message: `${provider.envKey} is set; bzzy will use it without copying it to disk.` }); return 0; }
    const key = (await ui.secret(`${provider.name} API key (hidden): `))?.trim();
    if (!key) throw new Error('API key must not be empty.');
    saveKey(provider.id, key);
    ui.event('info', { message: 'API key saved locally with owner-only permissions.' });
    return 0;
  }
  if (reuseExisting && subscriptionStatus(provider).available) { ui.event('info', { message: `Using the existing ${provider.backend === 'codex' ? 'Codex / ChatGPT' : 'Claude Code'} subscription login.` }); return 0; }
  if (ui.tui) { ui.tui.close(); ui.tui = null; }
  return authenticateSubscription(provider, options);
}

export async function setup(ui, options, explicitProvider) {
  if (!ui.interactive && !explicitProvider) throw new Error('Choose --provider codex, claude, or deepseek; or run bzzy setup in a terminal.');
  const entries = Object.values(providers());
  let provider;
  if (explicitProvider) provider = getProvider(explicitProvider);
  else {
    ui.openTerminal?.();
    const checks = await checkConnections(ui);
    const ready = new Map(entries.map(entry => {
      if (entry.auth === 'subscription') return [entry.id, checks.find(check => check.provider === entry.id)?.ok || false];
      try { apiKey(entry); return [entry.id, true]; } catch { return [entry.id, false]; }
    }));
    const status = entry => entry.auth === 'subscription'
      ? ready.get(entry.id) ? 'Validated · subscription login and backend connection' : checks.find(check => check.provider === entry.id)?.authenticated ? 'Login detected · backend check failed' : 'Not signed in'
      : ready.get(entry.id) ? 'API key configured' : 'Optional API key';
    const name = entry => entry.id === 'codex' ? 'Codex / ChatGPT' : entry.id === 'claude' ? 'Claude' : entry.name;
    ui.event('info', { message: 'Your connections\n' + entries.map(entry => `${name(entry)} · ${status(entry)}`).join('\n') });
    const deepseek = entries.find(entry => entry.id === 'deepseek');
    if (deepseek && !ready.get(deepseek.id)) {
      ready.set(deepseek.id, Boolean(await ensureApiKey(deepseek, ui, { optional: true })));
    }
    const preferred = entries.find(entry => ready.get(entry.id))?.id || entries[0]?.id;
    provider = await chooseProvider(preferred, '', ui);
    if (!provider) throw new Error('Setup cancelled.');
  }
  const code = await authenticate(provider, ui, options, { reuseExisting: true });
  if (code !== 0) throw new Error(`Authentication exited (${code}); provider was not selected.`);
  if (ui.interactive) {
    ui.openTerminal?.();
    const selected = await chooseModel({ provider: provider.id, backend: provider.backend, cwd: options.cwd || process.cwd(),
      model: options.model || provider.model || null, selectedEffort: options.effort }, '', ui);
    if (!selected) throw new Error('Setup cancelled.');
    if (provider.auth === 'subscription') {
      const [check] = await checkConnections(ui, { providerId: provider.id, live: true, model: selected.model, effort: selected.effort });
      if (!check.ok) throw new Error(`Setup connection check failed for ${provider.id}: ${check.error}. Your previous default was kept.`);
    }
    const saved = saveDefaultSelection({ provider: provider.id, model: selected.model,
      selectedEffort: selected.effort, modelCapabilities: selected.capabilities });
    options.provider = provider.id; options.model = selected.model;
    options.effort = saved.effort === 'default' ? undefined : saved.effort;
    options.launchDefault = saved;
    ui.event('info', { message: 'Default saved. Use /providers to change provider, model and effort, and /default to save a new default.' });
  } else setDefault(provider.id);
  return provider;
}

function saveCurrentDefault(session, ui) {
  const selected = saveSessionDefaultSelection(session);
  ui.event('info', { message: savedDefaultMessage(selected) });
}

async function goalControl(action, id, options, ui) {
  const session = findSession(id, options.cwd);
  if (!session.goal) throw new Error('This session has no goal.');
  if (action === 'status') { ui.event('session', { session, message: JSON.stringify(session.goal, null, 2) }); return 0; }
  if (action === 'resume') return resume(session, options, ui, true);
  const result = await controlSavedGoal(session, action, options, ui);
  ui.event('info', { message: result.requested ? `Goal ${action} requested for ${session.id}.`
    : `Goal ${action === 'clear' ? 'cleared' : action === 'cancel' ? 'cancelled' : 'paused'}.` });
  return 0;
}

async function resume(session, options, ui, requireGoal = false) {
  const { recovery, goal } = prepareResume(session, options, requireGoal);
  options = { ...options, cwd: session.cwd };
  if (recovery.live) return ui.interactive ? attachSession(session, options, ui) : viewSession(session, options, ui);
  if (!goal) {
    if (ui.interactive) return chat(getProvider(session.provider), { ...options, cwd: session.cwd }, ui, session);
    ui.event('session', { session, message: `Session restored: ${session.id}. ${session.goal?.status === 'complete' ? 'Goal already complete.' : 'Open bzzy resume in a terminal to continue chatting.'}` });
    return 0;
  }
  return executeFromCommand(getProvider(session.provider), session, { ...options, cwd: session.cwd }, ui, 'Continue the current task from the saved state; inspect durable checkpoints and recovery evidence first.', { goal: Boolean(goal), resumeGoal: Boolean(goal) });
}

async function executeFromCommand(provider, session, options, ui, prompt, flags) {
  const code = await executeManaged(provider, session, options, ui, prompt, flags);
  if (ui.coreLifecycleInterrupted) return 0;
  if (ui.nextSession) { const selected = ui.nextSession; ui.nextSession = null; return await attachSession(selected, options, ui); }
  if (!options.inChat && flags.goal && [0, 2].includes(code) && ui.interactive && !options.detach && !ui.detached) {
    return chat(getProvider(session.provider), { ...options, requestId: undefined }, ui, session);
  }
  return code;
}

async function chat(provider, options, ui, existingSession) {
  if (!ui.interactive) throw new Error('Use bzzy run "task" or bzzy goal "objective" when stdin is not a terminal.');
  let session = existingSession || createChatSession(provider, options);
  ui.setSession(session.id);
  if (existingSession) await restoreConversation(session, ui);
  ui.updateSession?.(session);
  ui.event('info', { message: `${provider.name}\n/goal <objective> · /providers · /models · /validate [objective] · /help`, welcome: true });
  if (options.mode === 'parallel') ui.event('info', { message: 'Parallel mode · chat normally, or use /goal <objective> for independent work by ' + (session.parallelAgents?.map(agent => agent.provider + (agent.model ? ':' + agent.model : '')).join(', ') || options.agents || 'codex,claude,deepseek'), welcome: true });
  if (options.mode === 'debate') ui.event('info', { message: 'Validate mode · get a first response, select the agents, then investigate and validate for up to five rounds.', welcome: true });
  if (session.mode === 'delegate' && session.executor) ui.event('info', { message: describeDelegation(session) });
  if (session.mode === 'besties') ui.event('info', { message: describeBesties(session), welcome: true });
  const debateReply = focus => ui.onDebate(session.id, focus);
  while (true) {
    if (ui.nextSession) { const selected = ui.nextSession; ui.nextSession = null; return await attachSession(selected, options, ui); }
    const input = (await conversationInput(session, ui))?.trim();
    if (ui.nextSession) { const selected = ui.nextSession; ui.nextSession = null; return await attachSession(selected, options, ui); }
    Object.assign(session, loadSession(session.id)); provider = getProvider(session.provider);
    if (input == null || input === '/quit' || input === '/exit') return 0;
    if (!input) continue;
    if (await ui.settingsCommand(input)) continue;
    options = ui.executionOptions(options, session);
    try {
      if (await conversationModeCommand(input, session.id, ui)) {
        session = loadSession(session.id); provider = getProvider(session.provider);
        options = { ...options, mode: session.mode, provider: session.provider, model: session.model, effort: session.selectedEffort,
          executor: session.executor?.provider, executorModel: session.executor?.model, debateAgents: session.debateAgents };
        continue;
      }
      if (input === '/pause' || input === '/cancel') {
        await controlSession(session, input.slice(1));
        session = loadSession(session.id); ui.updateSession?.(session);
        ui.event('info', { message: input === '/pause' ? 'Chat paused. You can use /delegate, /validate or /solo; work stays paused until you continue.' : 'Chat cancelled.' });
        continue;
      }
      if (input === '/help') { ui.event('info', { message: chatHelp }); continue; }
      if (input === '/sessions') { const selected = await chooseSavedSession(ui); if (selected) return await attachSession(selected.session, options, ui); continue; }
      if (input === '/doctor') { await checkConnections(ui, { providerId: session.provider, live: true, model: session.model, effort: session.selectedEffort, session }); continue; }
      if (input === '/default') { saveCurrentDefault(session, ui); continue; }
      if (/^\/alias(?:\s|$)/.test(input)) { session = await promptSessionAlias(session.id, input.replace(/^\/alias\s*/, ''), ui); continue; }
      if (/^\/export(?:\s|$)/.test(input)) { await exportProject(session, input.replace(/^\/export\s*/, ''), ui); continue; }
      if (/^\/share(?:\s|$)/.test(input)) {
        if (input === '/share library') await shareLibrary(session.cwd, ui);
        else if (input === '/share') await shareTerminal(session, ui);
        else throw new Error('Use /share for a full session, or /share library for reusable Library entries.');
        continue;
      }
      if (/^\/import(?:\s|$)/.test(input)) { forgetPrivateImportInput(ui, input); await importRelayShare(input.replace(/^\/import\s*/, ''), session.cwd, ui, { chooseDestination: true }); continue; }
      if (/^\/skill_that(?:\s|$)/.test(input)) { await skillThat(session, input.replace(/^\/skill_that\s*/, ''), ui); continue; }
      if (/^\/(?:validate|debate)(?:\s|$)/.test(input)) { await debateReply(input.replace(/^\/(?:validate|debate)\s*/, '')); if (ui.detached) return 0; continue; }
      if (input === '/new') {
        session = newConversation(session, options);
        ui.setSession(session.id); ui.updateSession(session); continue;
      }
      if (/^\/providers?(?:\s|$)/.test(input)) {
        const selected = await ui.onProvider(session.id, input.replace(/^\/providers?\s*/, ''));
        if (selected) { session = selected; provider = getProvider(session.provider); ui.setSession(session.id); ui.updateSession(session); }
        continue;
      }
      if (/^\/models?(?:\s|$)/.test(input)) { Object.assign(session, await changeSessionModel(session.id, input.replace(/^\/models?\s*/, ''), ui)); continue; }
      if (/^\/effort(?:\s|$)/.test(input)) {
        if (input.trim() !== '/effort') throw new Error('Use /effort without arguments.');
        Object.assign(session, await changeSessionModel(session.id, '@effort', ui)); continue;
      }
      const goalCommand = await resolveInteractiveGoal(input, ui, { sessionId: session.id });
      if (goalCommand?.cancelled) continue;
      if (session.modelSelectionRequired) throw new Error(`Select a model with /models${ui.minimal ? '' : ' or the model dropdown'} before sending a message.`);
      if (goalCommand) {
        if (goalCommand.action) {
          if (!session.goal) throw new Error('No goal yet. Use /goal <objective>.');
          await goalControl(goalCommand.action, session.id, { ...options, provider: session.provider, inChat: true }, ui);
          session = findSession(session.id);
        } else {
          await submitManagedGoal(session, options, ui, goalCommand.objective);
        }
      } else if (input.startsWith('/')) throw new Error('Unknown command. Use /help.');
      else {
        const chatOptions = { ...options, mode: 'solo' };
        prepareConversationTurn(session, chatOptions, input);
        await executeManaged(provider, session, chatOptions, ui, input);
        if (ui.coreLifecycleInterrupted) return 0;
        if (options.mode === 'debate' && !ui.detached && !ui.nextSession) await debateReply(input);
      }
      if (ui.nextSession) { const selected = ui.nextSession; ui.nextSession = null; return await attachSession(selected, options, ui); }
      provider = getProvider(session.provider);
      if (ui.detached) return 0;
    } catch (error) { ui.event('error', { message: error.message }); }
  }
}

async function debateConversation(source, focus, options, ui) {
  if (!source) throw new Error('No conversation selected.');
  ui.event('info', { message: source.goal?.status === 'complete' ? 'Starting validation of the achieved goal…' : 'Preparing reply validation…' });
  const agents = source.goal?.status === 'complete'
    ? options.debateAgents || defaultChatDebateAgents(source)
    : (source.mode === 'debate' && source.debateAgents) || options.debateAgents || await chooseDebate({ ...options, provider: source.provider, model: source.model }, ui);
  if (!agents) return;
  const selected = agents.slice(1);
  const debate = prepareChatDebate(source, focus, selected, { ...options, debateAgents: agents });
  try { await executeManaged(getProvider(debate.session.provider), debate.session, debate.options, ui, debate.session.goal.objective, { goal: true }); }
  finally {
    finishChatDebate(source.id, debate.session.id);
    if (!ui.detached) await restoreConversation(loadSession(source.id), ui);
  }
}

// After a lifecycle action all old API readers have unwound. Settings stays
// local while Core is stopped; leaving it opens a fresh observer/attachment,
// never a paused execution or a queued prompt.
async function coreServiceSettings(ui, options) {
  const settingsOnly = ui.settingsOnly;
  const sessionId = ui.sessionId, readOnly = /VIEW/.test(ui.sessionMode || '');
  ui.settingsOnly = true; ui.tui.setPanel('settings');
  try {
    while (true) {
      const input = await ui.ask('bzzy settings › ');
      if (input == null || ['/exit', '/quit', '/detach'].includes(input.trim())) {
        const status = input == null ? await ui.settings.refreshHost().catch(() => null) : null;
        ui.coreLifecycleInterrupted = false;
        if (!settingsOnly && status?.running && !status.operatorStopped && sessionId) {
          ui.settingsOnly = false; ui.tui.setPanel('chat');
          const session = loadSession(sessionId);
          return readOnly ? await viewSession(session, options, ui) : await attachSession(session, options, ui);
        }
        return 0;
      }
      if (!await ui.settingsCommand(input.trim())) {
        ui.settings.message = 'Use Settings to control Core. Esc returns when Core is running, or closes when stopped.';
        ui.settings.changed();
      }
    }
  } finally { ui.settingsOnly = settingsOnly; }
}

export async function main(argv) {
  const guide = authoringHelp(argv);
  if (guide !== null) { process.stdout.write(guide); return 0; }
  const updateHandoff = readUpdateHandoff();
  if (updateHandoff) argv = updateHandoff.sessionId && !updateHandoff.settingsOnly && !updateHandoff.coreStopped
    ? [updateHandoff.mode === 'VIEW' ? '--view' : '--attach', updateHandoff.sessionId]
    : updateHandoff.settingsOnly || updateHandoff.coreStopped ? ['settings'] : [];
  if (['internal-mcp', 'internal-tools', 'internal-service', 'internal-execution', 'internal-assignment'].includes(argv[0])) return backendCommand(argv);
  const { options, args } = parseArgs(argv);
  if (options.settingsRequested) {
    if (args.length) throw new Error('Run bzzy --settings by itself.');
    args.push('settings');
  }
  if (updateHandoff) { options.restoreAfterUpdate = true; options.minimal = updateHandoff.minimal; }
  if (options.version) { process.stdout.write('bzzy 0.2.0\n'); return 0; }
  if (options.whoami) { process.stdout.write(whoami(options.cwd)); return 0; }
  if (options.help || args[0] === 'help') { process.stdout.write(HELP); return 0; }
  if (['telegram', 'internal-telegram'].includes(args[0])) throw new Error('The Telegram integration has been removed. Use the terminal or the scoped integration API.');
  if (options.update) {
    if (argv.length !== 1) throw new Error('Run bzzy --update by itself.');
    return updateCoreAndCLI();
  }
  if (options.customNotification !== undefined) return customNotificationCLI(options);
  if (options.goalAction !== undefined) return namedGoalCLI(options);
  try { if (!fs.statSync(options.cwd).isDirectory()) throw new Error('not a directory'); }
  catch { throw new Error(`--cwd must name an existing directory: ${options.cwd}`); }
  options.cwd = fs.realpathSync(options.cwd);
  if (options.backgroundScript || args[0] === 'background') {
    try { return await backgroundCLI(options.backgroundScript ? args : args.slice(1), options); }
    catch (error) {
      if (!options.json) throw error;
      const { diagnosticError } = await import('@bzzy/core/engine/diagnostic-error.js');
      process.stderr.write(JSON.stringify({ error: diagnosticError(error), code: error.code || 'BACKGROUND_COMMAND_FAILED' }) + '\n'); return 1;
    }
  }
  if (!['debug', 'full_debug_export'].includes(args[0])) await retireTelegram();
  const launchCommand = args[0];
  const staticCommands = new Set(['integration', 'export', 'debug', 'full_debug_export', 'project', 'memory', 'providers', 'provider', 'doctor', 'notifications', 'recover', 'setup', 'auth', 'skills', 'knowledge', 'session-memory', 'cost', 'subagents', 'workflows', 'library', 'extensions']);
  if (!updateHandoff?.coreStopped && !staticCommands.has(launchCommand) && !(launchCommand === 'service' && ['status', 'stop', 'restart'].includes(args[1]))) {
    await activateCLIHost();
  }
  const ui = new UI({ ...options, hostMetrics: true, updateHandoff });
  ui.accountStatusEnabled = ui.interactive;
  ui.onDebate = (id, focus) => debateConversation(loadSession(id), focus, ui.executionOptions(options, { id }), ui);
  ui.onProvider = (id, argument, connection) => changeConversationProvider(loadSession(id), argument, ui, connection);
  ui.onSessions = () => queueSessionBrowser(ui);
  ui.ensureWorkflowSession = () => ensureCurrentTerminalSession(ui);
  const launch = async () => {
    const [command, ...rest] = args;
    if (command === 'debug' || command === 'full_debug_export') {
      const parts = command === 'full_debug_export' ? ['full', ...rest] : rest;
      if (parts[0] === 'status') {
        if (parts.length !== 2) throw new Error('Use bzzy debug status JOB_ID.');
        const job = (await import('@bzzy/core/engine/debug-export-jobs.js')).debugExportJob(parts[1]);
        const detail = job.result ? `ZIP: ${job.result.outputPath}` : job.error ? `${job.error.message} [${job.error.code}]` : `Phase: ${job.progress?.phase || 'starting'}`;
        ui.event('debug.export.status', { ...job, message: `Full debug export ${job.id} · ${job.state}\n${detail}` }); return 0;
      }
      if (!['export', 'full'].includes(parts[0]) || !parts[1] || parts.length > 3) throw new Error('Use bzzy debug export SESSION [FILE.md] or bzzy debug full SESSION [FILE.zip] [--bounded].');
      const full = parts[0] === 'full';
      if (options.detach) {
        if (!full) throw new Error('Detached export requires bzzy debug full SESSION --detach.');
        const { startDebugExportJob } = await import('@bzzy/core/engine/debug-export-jobs.js');
        const job = await startDebugExportJob(parts[1], { cwd: options.cwd, output: parts[2], captureMode: options.debugBounded ? 'bounded' : 'complete' });
        ui.event('debug.export.started', { ...job, message: `Full debug export ${job.existing ? 'already running' : 'detached'} · ${job.id}\nYou can close this terminal. Check: bzzy debug status ${job.id}\nCompletion/errors enter the iPhone push queue; delivery needs Core running and phone alerts enabled.` });
        return 0;
      }
      const exportDebug = full ? (await import('@bzzy/core/engine/session-full-debug.js')).exportFullSessionDebugInWorker : (await import('@bzzy/core/engine/session-debug.js')).exportSessionDebug;
      const captureMode = options.debugBounded ? 'bounded' : 'complete';
      const id = findSession(parts[1]).id, progress = full ? createDebugExportProgressReporter({ captureMode }) : null;
      let result;
      try { result = await exportDebug(id, { cwd: options.cwd, output: parts[2], ...(full ? { onProgress: progress.update, captureMode } : {}) }); }
      finally { progress?.close(); }
      const contextNotice = debugExportContextNotice(result), summary = debugExportSummary(result);
      ui.event('debug.exported', { ...result, message: `Debug exported: ${result.outputPath}${summary ? '\n' + summary : ''}${contextNotice ? '\n' + contextNotice : ''}\nIncludes session history and skill/agent definitions. Review this private task content before sharing.` });
      return 0;
    }
    if (command === 'knowledge') return knowledgeCLI(rest, options, ui);
    if (command === 'session-memory') return sessionMemoryCLI(rest, options, ui);
    if (command === 'cost') return sessionCostCLI(rest, options, ui);
    if (command === 'extensions') return extensionsCLI(rest, options, ui);
    if (command === 'subagents') return subagentsCLI(rest, options, ui);
    if (command === 'workflows') return workflowsCLI(rest, options, ui);
    if (command === 'library') { await libraryCommand(rest.join(' '), options.cwd, ui); return 0; }
    if (command === 'skills') {
      if (rest[0] === 'aliases') return skillsAliasesCLI(rest.slice(1), options, ui);
      if (rest.length !== 1 || rest[0] !== 'sync') throw new Error('Use bzzy skills sync, skills aliases set|show|clear, or open Skills in the terminal.');
      if (ui.interactive) { await terminalSkillsCommand('/skills sync', ui); return 0; }
      const result = syncCodexSkills({ cwd: options.cwd });
      ui.event('info', { ...skillSyncReport(result), message: skillSyncSummary(result) }); return 0;
    }
    if (command === 'settings') {
      if (!ui.interactive) throw new Error('Run bzzy settings in a private interactive terminal.');
      ui.settingsOnly = true; ui.openSettings();
      while (!ui.coreLifecycleInterrupted) {
        const input = await ui.ask('bzzy settings › ');
        if (input == null || ['/exit', '/quit'].includes(input.trim())) return 0;
        if (input.trim() === '/sessions') {
          const selected = await chooseSavedSession(ui);
          if (selected) { ui.settingsOnly = false; return await attachSession(selected.session, options, ui); }
          ui.openSettings(); continue;
        }
        await ui.settingsCommand(input.trim());
      }
      return 0;
    }
    if (options.importFile) {
      if (relayImportArgument(options.importFile)) await importRelayShare(options.importFile, options.cwd, ui, { chooseDestination: true });
      else await importProject(options.importFile, options.cwd, ui);
      return 0;
    }
    if (command === 'export') { await exportProject(options.cwd, rest[0], ui); return 0; }
    if (command === 'integration') {
      const file = path.join(root, 'docs', 'INTEGRATION.md');
      ui.event('info', { message: fs.readFileSync(file, 'utf8') }); return 0;
    }
    if (options.view || options.attach) {
      const opened = options.view || options.restoreAfterUpdate ? { session: findSession(options.view || options.attach), created: false } : await openOrCreateChatSession(options.attach, options);
      let session = opened.session;
      if (options.alias != null) session = setSessionAlias(session.id, options.alias);
      if (opened.created) ui.event('info', { message: `Created session ${session.alias}. No work has started.` });
      return options.view ? await viewSession(session, options, ui) : await attachSession(session, options, ui);
    }
    if (options.resume) return await resume(findSession(options.resume), options, ui);
    if (command === 'activity' || command === 'traffic') {
      const { watchRegistry } = await import('./runtime-client.js');
      return await watchRegistry(findSession(rest[0], options.cwd), options, ui, command === 'traffic' ? 'network.' : 'activity');
    }
    if (command === 'service') {
      if (rest[0] === 'stop') { const status = await stopCoreHost(); ui.event('info', { ...status, message: 'Core stopped. Work is paused; history and accounts are preserved.' }); }
      else if (rest[0] === 'status') { const status = await coreHostStatus(); ui.event('info', { ...status, message: status.running ? 'Core running.' : 'Core stopped.' }); }
      else if (rest[0] === 'restart') { await restartCoreHost(); await ensureRuntime(); ui.event('info', { message: 'Core restarted. Active work continues; paused work remains paused.' }); }
      else if (rest[0] === 'web') { const info = await ensureRuntime(); const sessionId = rest[1] ? findSession(rest[1]).id : null;
        const credential = sessionId ? await runtimeRequest(info, 'POST', '/tokens', { sessionId }) : null;
        ui.event('info', { message: `${info.url}/#token=${credential?.token || info.token}${sessionId ? `&session=${sessionId}` : ''}` }); }
      else if (rest[0] === 'token' && rest[1]) { const info = await ensureRuntime(), result = await runtimeRequest(info, 'POST', '/tokens', { sessionId: findSession(rest[1]).id }); ui.event('token', { ...result, message: `Observer token (session only, expires in 24h): ${result.token}` }); }
      else if (rest[0] === 'grant' && rest[1] && rest[2] && rest[3]) {
        const result = await runtimeRequest(await ensureRuntime(), 'POST', '/tokens', { sessionId: findSession(rest[1]).id, recipient: rest[2], permissions: rest[3].split(','), expiresInSeconds: rest[4] === undefined ? 86400 : Number(rest[4]) });
        ui.event('token', { ...result, message: `Session token for ${result.recipient} (${result.permissions.join(', ')}): ${result.token}\nGrant ID: ${result.id}` });
      }
      else if (rest[0] === 'grants') { const result = await runtimeRequest(await ensureRuntime(), 'GET', '/tokens'); ui.event('grants', { ...result, message: result.items.map(grant => `${grant.id} · ${grant.sessionId} · ${grant.permissions.join(', ')} · ${grant.revokedAt ? 'revoked' : grant.expiresAt <= Date.now() ? 'expired' : 'active'}`).join('\n') || 'No session grants.' }); }
      else if (rest[0] === 'revoke' && rest[1]) { const grant = await runtimeRequest(await ensureRuntime(), 'DELETE', `/tokens/${rest[1]}`); ui.event('grant.revoked', { ...grant, message: `Session grant revoked: ${grant.id}` }); }
      else if (!rest[0] || rest[0] === 'start') { const info = await ensureRuntime(); ui.event('info', { message: `Runtime ready at ${info.url}` }); }
      else throw new Error('Use bzzy service start|status|stop|web|token|grant|grants|revoke.');
      return 0;
    }
    if (command === 'recover') { const result = reconcileSession(findSession(rest[0], options.cwd).id); ui.event('recovery', { ...result, message: JSON.stringify(result, null, 2) }); return 0; }
    if (command === 'project') { ui.event('project', { message: JSON.stringify(projectContext(options.cwd), null, 2) }); return 0; }
    if (command === 'memory') {
      if (rest[0] === 'invalidate') invalidateMemory(rest[1], rest.slice(2).join(' '));
      else if (rest[0] === 'add') { if (!rest[1]) throw new Error('Use bzzy memory add FILE.json.'); ui.event('memory', { memory: recordProjectMemory(selectedProvider(options), options, rest[1]), message: 'Project memory recorded.' }); }
      else { const entries = recall(options.cwd, rest[0] === 'search' ? rest.slice(1).join(' ') : '', 50); ui.event('memory', { entries, message: JSON.stringify(entries, null, 2) }); }
      return 0;
    }
    if (command === 'setup') { await setup(ui, options, options.provider); return 0; }
    if (command === 'auth') return await authenticate(getProvider(rest[0] || options.provider || config().defaultProvider || 'codex'), ui, options);
    if (command === 'providers') {
      ui.event('providers', { providers: Object.values(providers()), message: Object.values(providers()).map(p => `${p.id === config().defaultProvider ? '*' : ' '} ${p.id} · ${p.name}`).join('\n') });
      return 0;
    }
    if (command === 'provider') {
      if (rest[0] === 'use' && rest[1]) setDefault(rest[1]);
      else if (rest[0] === 'add' && rest[1] && options.baseUrl) addProvider(rest[1], options);
      else throw new Error('Use bzzy provider use NAME, or bzzy provider add NAME --base-url URL --model MODEL --env-key KEY_NAME.');
      ui.event('info', { message: `Provider ${rest[1]} ${rest[0] === 'use' ? 'selected' : 'registered'}.` });
      return 0;
    }
    if (command === 'notifications') {
      if (rest[0] === 'status') { const status = (await import('@bzzy/core/engine/push-status.js')).notificationDeliveryStatus(); ui.event('info', { ...status, message: status.message + '\n' + JSON.stringify(status, null, 2) }); return 0; }
      const hub = new NotificationHub({ ui });
      if (rest[0] === 'retry') await hub.retry();
      else if (!rest[0] || rest[0] === 'list') for (const { event, deliveries } of hub.records()) ui.event('notification', { event, deliveries, message: `${event.type} · ${event.sessionId?.slice(0, 8) || 'host'} · ${JSON.stringify(deliveries)}` });
      else throw new Error('Use bzzy notifications status|list|retry.');
      return 0;
    }
    if (command === 'doctor') {
      const checks = await checkConnections(ui, { providerId: options.provider, live: options.live, model: options.model, effort: options.effort });
      ui.event('info', { message: `Node ${process.version} · ${process.platform}/${process.arch}\nEnforced permissions: ${sandboxSupport() ? (process.platform === 'darwin' ? 'macOS sandbox-exec available' : 'Linux bubblewrap available') : 'unavailable (strict tasks fail closed)'}\nConfiguration: ${home()}\nDefault provider: ${config().defaultProvider || 'not selected (first-run setup)'}` });
      return checks.every(check => check.ok) ? 0 : 1;
    }
    if (command === 'sessions') {
      if (ui.interactive) {
        while (true) {
          const selected = await chooseSavedSession(ui);
          if (!selected) return 0;
          try { return await attachSession(selected.session, options, ui); }
          catch (error) { ui.event('error', { message: error.message }); }
        }
      }
      for (const session of namedTerminalSessions()) ui.event('session', { session, message: sessionLabel(session) });
      return 0;
    }
    if (command === 'resume') return await resume(findSession(rest[0], options.cwd), options, ui);
    if (command === 'goal' && ['status', 'pause', 'cancel', 'clear', 'resume'].includes(rest[0])) return await goalControl(rest[0], rest[1], options, ui);
    const executionCommands = ['run', 'goal', 'chat', 'delegate', 'besties', 'validate', 'debate', 'parallel', 'paralel'];
    const positionalContext = options.goal
      ? (executionCommands.includes(command) ? rest : args).join(' ').trim()
      : '';
    if (options.contextFile && positionalContext) throw new Error('Choose --context-file or positional initialization context, not both.');
    const initialContext = positionalContext;
    if (command && !executionCommands.includes(command) && !positionalContext) throw new Error(`Unknown command ${command}. Use bzzy --help.`);
    if (options.contextFile && !(options.goal || ['goal', 'delegate', 'besties', 'validate', 'debate', 'parallel', 'paralel'].includes(command))) throw new Error('--context-file requires --goal or a goal execution command.');
    const contextFileText = options.contextFile ? readContextFile(options.contextFile, options.cwd) : undefined;
    if (['delegate', 'besties', 'validate', 'debate', 'parallel', 'paralel'].includes(command)) options.mode = command === 'paralel' ? 'parallel' : command === 'validate' ? 'debate' : command;
    if (!options.mode || options.mode === 'solo') applyLaunchDefault(options);
    if (['parallel', 'besties', 'debate', 'delegate'].includes(options.mode)
      && !options.agents && !options.participants && !options.supervisor && !options.executor) {
      const saved = modeDefault(options.mode);
      if (saved && (options.parallelCount == null || options.parallelCount === saved.length)) options.useDefault = true;
    }
    if (options.useDefault && (!options.mode || options.mode === 'solo') && !config().defaultProvider) throw new Error('No normal chat default saved. Choose a provider and run /default first.');
    if (options.mode === 'delegate' && (options.delegationSetup && ui.interactive || options.useDefault)) {
      ui.openTerminal();
      const saved = await chooseSavedCombo('delegate', options, ui);
      const selection = saved === false ? await chooseDelegation(options, ui) : saved && { supervisor: saved[0], executor: saved[1] };
      if (!selection) return 0;
      options.delegationSelection = selection;
      options.supervisor = selection.supervisor.provider; options.supervisorModel = selection.supervisor.model;
      options.provider = selection.supervisor.provider; options.model = selection.supervisor.model;
      options.executor = selection.executor.provider; options.executorModel = selection.executor.model;
    }
    if (options.supervisor) { const brain = agentChoice(options.supervisor, options.supervisorModel); options.provider = brain.provider; options.model = brain.model || options.model; }
    if (options.mode === 'besties') {
      if ((options.bestiesSetup && ui.interactive || options.useDefault) && !options.agents) {
        ui.openTerminal(); options.bestiesSelection = await chooseBestiesWithDefault(options, ui);
        if (!options.bestiesSelection) return 0;
      } else options.bestiesSelection = configuredBesties(options);
      options.besties = options.bestiesSelection;
      options.provider = options.besties[0].provider; options.model = options.besties[0].model;
    }
    if (options.mode === 'parallel') {
      if ((options.parallelSetup && ui.interactive || options.useDefault) && !options.agents) {
        ui.openTerminal(); options.parallelAgents = await chooseParallelWithDefault(options, ui);
        if (!options.parallelAgents) return 0;
      } else options.parallelAgents = configuredParallel(options);
      options.provider = options.parallelAgents[0].provider; options.model = options.parallelAgents[0].model;
      if ((options.parallelSetup || options.useDefault) && ui.interactive && !options.goal && (!command || command === 'chat')) {
        const objective = await chooseParallelGoal(options.parallelAgents, ui);
        if (!objective) return 0;
        options.goal = objective;
      }
    }
    if (options.mode === 'debate') {
      if ((options.debateSetup && ui.interactive || options.useDefault) && !options.participants) {
        ui.openTerminal(); options.debateAgents = await chooseDebate(options, ui);
        if (!options.debateAgents) return 0;
      } else options.debateAgents = configuredDebate(options);
      options.provider = options.debateAgents[0].provider; options.model = options.debateAgents[0].model;
    }
    if (['besties', 'debate', 'delegate'].includes(options.mode) && ui.interactive && !options.goal && (!command || command === 'chat')) {
      const selections = options.mode === 'besties' ? options.besties : options.mode === 'debate' ? options.debateAgents
        : options.delegationSelection && [options.delegationSelection.supervisor, options.delegationSelection.executor];
      if (selections) {
        const objective = await chooseParallelGoal(selections, ui, { name: options.mode[0].toUpperCase() + options.mode.slice(1),
          description: options.mode === 'besties' ? 'The agents collaborate and review one another’s evidence.' : options.mode === 'debate' ? 'Independent checks are followed by a fresh evidence review when every agent supports the goal.' : 'The brain assigns work and reviews the executor’s evidence.' });
        if (!objective) return 0;
        options.goal = objective;
      }
    }
    let provider;
    if (!config().defaultProvider && !options.provider && !options.model && ui.interactive && !options.goal && (!command || command === 'chat') && !options.mode) {
      options.modelSelectionRequired = true;
      provider = selectedProvider(options);
    }
    else provider = selectedProvider(options);
    if (provider.auth === 'api-key' && !options.modelSelectionRequired) await ensureApiKey(provider, ui);
    if (options.goal || ['goal', 'run', 'delegate', 'besties', 'validate', 'debate', 'parallel', 'paralel'].includes(command)) {
      const prompt = options.goal || rest.join(' ');
      if (!prompt.trim()) throw new Error(`Supply a ${command === 'run' ? 'task' : 'goal objective'}.`);
      const goal = Boolean(options.goal || command !== 'run' || ['parallel', 'besties', 'debate'].includes(options.mode));
      const created = createTaskSession(provider, options, prompt, { goal, initialContext, contextFileText });
      const session = created.session;
      if (created.existingExecution) {
        if (options.detach) { ui.event('session', { sessionId: session.id, existing: true, message: `Session ${session.id} · existing execution retained` }); return 0; }
        return await viewSession(session, options, ui);
      }
      ui.event('session', { sessionId: session.id, message: `Session ${session.id}` });
      if (initialContext) {
        const contextOptions = { ...options, detach: false, ...(options.requestId ? { requestId: `${options.requestId}:context` } : {}) };
        const contextCode = await executeManaged(provider, session, contextOptions, ui, initialContext, { goal: false, returnAfterExecution: true });
        if (ui.coreLifecycleInterrupted) return 0;
        if (contextCode !== 0) return contextCode;
        activateTaskGoal(session, options);
      }
      const executionOptions = initialContext && options.requestId ? { ...options, requestId: `${options.requestId}:goal` } : options;
      return await executeFromCommand(provider, session, executionOptions, ui, prompt, { goal });
    }
    return await chat(provider, options, ui);
  };
  try {
    let result;
    try { result = await launch(); }
    catch (error) { if (!ui.coreLifecycleInterrupted) throw error; }
    while (ui.coreLifecycleInterrupted && !ui.updateRestart) {
      try { result = await coreServiceSettings(ui, options); }
      catch (error) { if (!ui.coreLifecycleInterrupted) throw error; }
    }
    return result ?? 0;
  } finally {
    await ui.settings?.close(); ui.close({ preserveScreen: Boolean(ui.updateRestart) });
    if (ui.updateRestart) {
      try { execUpdatedCLI(ui.updateRestart); }
      catch (error) { ui.output.write('\x1b[0m\x1b[?25h\x1b[?1049l'); throw error; }
    }
  }
}
