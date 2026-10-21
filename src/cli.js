import { saveSessionDefaultSelection, savedDefaultMessage } from './session-defaults.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, providers, getProvider, setDefault, addProvider, apiKey, saveKey, ensureApiKey, defaultSelection } from './providers.js';
import { home, readJson, createSession, saveSession, findSession, sessions, lockSession, loadSession } from './store.js';
import { inherited, version, root } from './process.js';
import { UI } from './ui.js';
import { Pet } from './mascot.js';
import { newGoal } from './goals.js';
import { runSession } from './controller.js';
import { CodexEngine } from './engines/codex.js';
import { claudeEnvironment } from './engines/claude.js';
import { NotificationHub } from './notifications.js';
import { configureTelegram, autoAttachTelegram } from './telegram.js';
import { serveGoalTools } from './mcp.js';
import { serveTaskBridge } from './tools.js';
import { executeManaged, viewSession, attachSession, controlSession, changeSessionModel } from './runtime-client.js';
import { serveRuntime, executeJob, ensureRuntime, runtimeInfo, runtimeRequest } from './runtime.js';
import { runAssignment, agentChoice } from './delegation.js';
import { prepareTask, readContextFile } from './task.js';
import { reconcileSession, identityAlive } from './recovery.js';
import { getRecord, putRecord, listRecords, digest, appendEvent, reserveRequest } from './database.js';
import { recall, remember, invalidateMemory } from './memory.js';
import { sandboxSupport } from './policy.js';
import { projectContext, initializeProject } from './project.js';
import { subscriptionStatus, subscriptionEnvironment } from './auth.js';
import { prepareChatDebate, finishChatDebate } from './chat-debate.js';
import { restoreConversation, conversationInput } from './runtime-client.js';
import { changeConversationProvider } from './conversation-settings.js';
import { serveTelegramBridge, ensureTelegramBridge, stopTelegramBridge } from './telegram-bridge.js';
import { chooseDelegation, applyDelegationSelection, describeDelegation } from './delegation-setup.js';
import { chooseBestiesWithDefault, configuredBesties, applyBestiesSelection, describeBesties } from './besties-setup.js';
import { chooseParallelWithDefault, chooseParallelGoal, configuredParallel, applyParallelSelection } from './parallel-setup.js';

import { chooseDebate, configuredDebate, applyDebateSelection } from './debate-setup.js';
import { chooseSavedCombo } from './mode-presets.js';
import { chatHelp } from './terminal-commands.js';
import { whoami } from './whoami.js';
import { updateInstallation } from './update.js';

const HELP = `bzzy 0.2.0 · a persistent coding agent

Usage:
  bzzy [options]                         Open the terminal chat
  bzzy "initial context" --goal "task"  Send context first, then start a durable goal
  bzzy --context-file FILE --goal "task" Load saved instructions and start the goal directly
  bzzy --codex|--claude|--deepseek        Open chat directly with that provider
  bzzy --delegate                       Choose brain and hands; chat normally or start /goal
  bzzy --besties                        Choose two peers; chat normally or start a shared /goal
  bzzy --parallel [2|3]                 Select agents, enter a goal, then open their chat tabs
  bzzy --debate                         Analyze, test, then debate the next reply
  bzzy run "task" [options]              Run one task
  bzzy goal "objective" [options]        Work until the goal completes or stalls
  bzzy goal status|pause|resume|clear [session]
  bzzy resume [session]                  Resume the latest session in this directory
  bzzy --view SESSION                   Replay history and watch without taking input
  bzzy --attach SESSION                 Restore chat and transfer input ownership
  bzzy --resume SESSION                 Resume a saved chat or unfinished goal
  bzzy delegate "objective" --supervisor codex --executor deepseek
  bzzy debate "question" --artifact FILE --participant claude --participant deepseek
  bzzy parallel "objective" --agents codex,claude,deepseek
  bzzy besties "objective" --agents codex:MODEL,claude:MODEL
  bzzy service start|status|stop|web     Manage the local background runtime
  bzzy recover [session]                Reconcile interrupted work without replaying it
  bzzy memory list|search TEXT|add FILE|invalidate ID REASON
  bzzy project                          Inspect this directory's .bzzy context
  bzzy activity [session] [--detailed]   Watch simple/detailed activity entries
  bzzy traffic [session]                Watch recorded outbound HTTP requests
  bzzy integration                      Explain API, live events and client integration
  bzzy service token SESSION            Create a session-scoped observer token
  bzzy sessions                         List saved sessions
  bzzy setup                            Choose a backend and authenticate
  bzzy auth [codex|claude|deepseek|name]  Log in or save an API key
  bzzy providers                        List providers
  bzzy provider use NAME                 Set the default provider
  bzzy provider add NAME --base-url URL --model MODEL --env-key KEY_NAME
  bzzy telegram setup|status|off|on|test  Pair a bot and control goal notifications
  bzzy telegram attach SESSION|detach   Mirror new messages through Telegram
  bzzy notifications [list|retry]        Inspect the delivery outbox
  bzzy doctor                           Check installed engines and configuration

Options:
  --provider NAME       Select a provider for a new session
  --model MODEL         Select a model (provider default otherwise)
  --cwd DIRECTORY       Working directory
  --goal OBJECTIVE      Start a persistent goal; quoted positional text is sent first as context
  --context-file FILE   UTF-8 task instructions (up to 1 MiB), relative to --cwd; no initialization chat
  --token-budget N      Optional goal token budget
  --max-turns N         Optional goal turn limit; pauses rather than completes
  --runtime N           Total active runtime limit in seconds
  --max-retries N       Bounded acceptance follow-ups (default 2)
  --contract FILE       Task JSON: constraints, criteria, artifacts, checks and limits
  --read-only           Enforce read-only tools (requires Linux bubblewrap)
  --detach              Leave execution running after this terminal exits
  --follow              Keep a noninteractive view connected
  --mode MODE           solo, delegate, besties, debate or parallel
  --delegate            Choose supervisor/executor models; the brain plans, delegates and verifies
  --besties             2–3 agents work together on one goal and review each other’s evidence
  --debate              2–3 agents investigate and debate one goal
  --parallel [2|3]      Choose 2 or 3 agents, continue to goal setup, then open agent chat tabs
  --supervisor NAME     Supervisor provider, optionally provider:model
  --executor NAME       Delegation executor provider, optionally provider:model
  --supervisor-model M  Independently select the supervisor model
  --executor-model M    Independently select the executor model
  --participant NAME    Debate participant; repeat to select more agents
  --agents A,B[,C]      Parallel or besties agents; optionally provider:model
  --default             Reuse this mode’s saved preset without questions or selectors
  --whoami              Print the detailed architecture, storage and integration reference
  --update              Pull the latest source and reinstall bzzy
  --artifact FILE       Material to snapshot and debate
  --rounds N            Debate round limit (default 5, maximum 5)
  --review-only         Skip independent investigation; debate a fixed snapshot
  --concurrency N       Maximum active workers
  --request-id ID       Idempotency key for a retried request
  --capture-network     Record proxy-aware agent HTTP/HTTPS traffic locally
  --detailed            Include detailed activity entries
  --effort LEVEL        Model reasoning effort
  --yolo                Disable Codex approvals AND sandbox; bypass Claude permissions
  --json                Emit JSONL events; unavailable approvals are denied
  --no-pet              Hide the bug-eyed terminal mascot
  --device              Use Codex's device-code login
  -h, --help            Show help
  -v, --version         Show version

Chat commands: /goal <objective>, /goal status|pause|resume|clear,
/new, /providers [name], /models [name|default], /default, /usage, /help, /exit
/providers chooses Codex, Claude or DeepSeek; missing API keys are prompted securely.
Choosing a provider opens its model-and-effort picker, including the current provider.
Model/provider changes retain this session's chat; the new backend receives prior messages.
/default saves a separate preset for normal chat, delegate, debate, besties or parallel.
--default skips selectors and the saved-combo question for the selected mode.
/models: ↑/↓ chooses a model; ←/→ sets supported effort; Enter confirms.
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
/telegram opens the Telegram tab, with separate goal-alert and chat-attachment checkboxes.
/telegram setup or pair asks for a hidden bot token, then detects the chat ID from BZZY CODE.
/telegram attach|detach mirrors only new messages; chat from either terminal or Telegram.
/telegram on|off toggles goal alerts independently. /telegram manual accepts a known chat ID.
/telegram status shows settings. Goals notify on achievement or stall.
Telegram bot menu: /providers and /models show buttons; model selection includes effort.
/debate [objective] opens a participant checklist for the latest reply.
Debate: independent analysis and permitted tests, then read-only evidence rounds.
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
  const options = { cwd: process.cwd(), pet: true, yolo: false, json: false };
  const args = [];
  const values = { '--provider': 'provider', '--model': 'model', '--cwd': 'cwd', '--goal': 'goal', '--context-file': 'contextFile',
    '--token-budget': 'tokenBudget', '--max-turns': 'maxTurns', '--effort': 'effort',
    '--base-url': 'baseUrl', '--env-key': 'envKey', '--context-window': 'contextWindow',
    '--view': 'view', '--attach': 'attach', '--atach': 'attach', '--resume': 'resume', '--mode': 'mode', '--supervisor': 'supervisor', '--executor': 'executor',
    '--supervisor-model': 'supervisorModel', '--executor-model': 'executorModel', '--participant': 'participant', '--agents': 'agents',
    '--artifact': 'artifact', '--rounds': 'rounds', '--runtime': 'runtimeSeconds', '--max-retries': 'maxRetries', '--contract': 'contract',
    '--concurrency': 'concurrency', '--request-id': 'requestId' };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--') { args.push(...argv.slice(i + 1)); break; }
    const equal = raw.indexOf('=');
    const flag = equal > 0 ? raw.slice(0, equal) : raw;
    if (Object.hasOwn(values, flag)) {
      const value = equal > 0 ? raw.slice(equal + 1) : argv[++i];
      if (!value || (equal < 0 && value.startsWith('--'))) throw new Error(`${flag} requires a value.`);
      if (flag === '--participant') (options.participants ||= []).push(value);
      else options[values[flag]] = value;
    } else if (['--codex', '--claude', '--deepseek'].includes(raw)) options.provider = raw.slice(2);
    else if (flag === '--parallel' || flag === '--paralel') {
      options.mode = 'parallel'; options.parallelSetup = true;
      const value = equal > 0 ? raw.slice(equal + 1) : /^[+-]?\d+(?:\.\d+)?$/.test(argv[i + 1] || '') ? argv[++i] : null;
      if (value != null && !/^[23]$/.test(value)) throw new Error('--parallel requires 2 or 3 agents.');
      if (value != null) options.parallelCount = Number(value);
    }
    else if (raw === '--debate') { options.mode = 'debate'; options.debateSetup = true; }
    else if (raw === '--default') options.useDefault = true;
    else if (raw === '--whoami') options.whoami = true;
    else if (raw === '--update') options.update = true;
    else if (raw === '--delegate') { options.mode = 'delegate'; options.delegationSetup = true; }
    else if (raw === '--besties') { options.mode = 'besties'; options.bestiesSetup = true; }
    else if (raw === '--review-only') options.reviewOnly = true;
    else if (raw === '--yolo') options.yolo = true;
    else if (raw === '--json') options.json = true;
    else if (raw === '--no-pet') options.pet = false;
    else if (raw === '--device') options.device = true;
    else if (raw === '--detach') options.detach = true;
    else if (raw === '--follow') options.follow = true;
    else if (raw === '--read-only') options.readOnly = true;
    else if (raw === '--capture-network') options.captureNetwork = true;
    else if (raw === '--detailed') options.detailed = true;
    else if (['--help', '-h'].includes(raw)) options.help = true;
    else if (['--version', '-v'].includes(raw)) options.version = true;
    else if (raw.startsWith('-')) throw new Error(`Unknown option ${raw}. Run bzzy --help.`);
    else args.push(raw);
  }
  for (const key of ['tokenBudget', 'maxTurns', 'contextWindow', 'runtimeSeconds', 'rounds', 'concurrency', 'maxRetries']) {
    if (options[key] != null) {
      if (!(key === 'maxRetries' ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(options[key]) || !Number.isSafeInteger(Number(options[key]))) throw new Error(`${key} must be ${key === 'maxRetries' ? 'a nonnegative' : 'a positive'} integer.`);
      options[key] = Number(options[key]);
    }
  }
  if ([options.view, options.attach, options.resume].filter(Boolean).length > 1) throw new Error('Choose --view, --attach or --resume.');
  if (options.mode && !['solo', 'delegate', 'besties', 'debate', 'parallel'].includes(options.mode)) throw new Error('Invalid execution mode.');
  if (options.yolo && options.readOnly) throw new Error('--yolo conflicts with --read-only.');
  if (options.useDefault && (options.agents || options.participants)) throw new Error('Use either --default or explicit --agents/--participant selections.');
  if (options.rounds > 5 || options.concurrency > 8) throw new Error('Maximum 5 debate rounds and 8 concurrent workers.');
  if (options.effort && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)) throw new Error('Invalid reasoning effort.');
  options.cwd = path.resolve(options.cwd);
  return { options, args };
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
  if (provider.backend === 'claude') return inherited('claude', ['auth', 'login'], claudeEnvironment());
  return inherited('codex', ['login', ...(options.device ? ['--device-auth'] : [])], subscriptionEnvironment('codex'));
}

export async function setup(ui, options, explicitProvider) {
  if (!ui.interactive && !explicitProvider) throw new Error('Choose --provider codex, claude, or deepseek; or run bzzy setup in a terminal.');
  const entries = Object.values(providers());
  let provider;
  if (explicitProvider) provider = getProvider(explicitProvider);
  else {
    ui.openTerminal?.();
    const ready = new Map(entries.map(entry => {
      if (entry.auth === 'subscription') return [entry.id, subscriptionStatus(entry).available];
      try { apiKey(entry); return [entry.id, true]; } catch { return [entry.id, false]; }
    }));
    const status = entry => entry.auth === 'subscription'
      ? ready.get(entry.id) ? 'Validated · existing subscription login' : 'Not signed in'
      : ready.get(entry.id) ? 'API key configured' : 'Optional API key';
    const name = entry => entry.id === 'codex' ? 'Codex / ChatGPT' : entry.id === 'claude' ? 'Claude' : entry.name;
    ui.event('info', { message: 'Your connections\n' + entries.map(entry => `${name(entry)} · ${status(entry)}`).join('\n') });
    const deepseek = entries.find(entry => entry.id === 'deepseek');
    if (deepseek && !ready.get(deepseek.id)) {
      ready.set(deepseek.id, Boolean(await ensureApiKey(deepseek, ui, { optional: true })));
    }
    const preferred = entries.find(entry => ready.get(entry.id))?.id || entries[0]?.id;
    const answer = await ui.chooseOne('Choose your default provider', entries.map(entry => ({
      value: entry.id, label: `${name(entry)} · ${status(entry)}`, selected: entry.id === preferred,
      description: ready.get(entry.id) ? 'Ready to use. You can change providers later with /providers.' : 'Sign in when selected. You can configure this provider later.',
    })));
    if (answer == null) throw new Error('Setup cancelled.');
    provider = getProvider(answer);
  }
  const code = await authenticate(provider, ui, options, { reuseExisting: true });
  if (code !== 0) throw new Error(`Authentication exited (${code}); provider was not selected.`);
  setDefault(provider.id);
  return provider;
}

function selectedProvider(options) { return getProvider(options.provider || config().defaultProvider || 'codex'); }

function applyLaunchDefault(options) {
  const saved = defaultSelection(options.provider);
  if (!saved) return;
  if (!options.provider) options.provider = saved.provider;
  const sameModel = options.model == null;
  if (sameModel) options.model = saved.model;
  if (options.effort == null && sameModel && saved.effort !== 'default') options.effort = saved.effort;
  options.launchDefault = { ...saved, capabilities: sameModel ? saved.capabilities : null, effort: sameModel ? options.effort || saved.effort : options.effort || 'default' };
}

function applyLaunchSelection(session, options) {
  const saved = options.launchDefault;
  if (session.selectedEffort == null) session.selectedEffort = options.effort || (saved && saved.provider === session.provider && saved.model === session.model ? saved.effort : undefined);
  if (!session.modelCapabilities && saved?.provider === session.provider && saved.model === session.model) session.modelCapabilities = saved.capabilities;
  return session;
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
  const run = getRecord('run', session.id);
  if (run && identityAlive(run.runner) && ['running', 'waiting_for_input', 'verifying'].includes(session.executionState)) {
    if (action === 'clear') throw new Error('Pause or cancel the running goal before clearing it.');
    await controlSession(session, action === 'cancel' ? 'cancel' : 'pause', options);
    ui.event('info', { message: `Goal ${action} requested for ${session.id}.` }); return 0;
  }
  const unlock = lockSession(session);
  try {
    if (session.backend === 'codex' && session.engineThreadId) {
      const engine = new CodexEngine(getProvider(session.provider), session, options, ui);
      try { await engine.setGoalStatus(action === 'clear' ? 'clear' : 'paused'); }
      finally { await engine.close(); }
    }
    if (action === 'clear') { putRecord('goal-history', session.goal.id, { sessionId: session.id, ...session.goal, clearedAt: new Date().toISOString() }); session.goal = null; }
    else session.goal.status = action === 'cancel' ? 'cancelled' : 'paused';
    saveSession(session);
    ui.event('info', { message: `Goal ${action === 'clear' ? 'cleared' : 'paused'}.` });
  } finally { unlock(); }
  return 0;
}

async function resume(session, options, ui, requireGoal = false) {
  if (options.provider && options.provider !== session.provider) throw new Error('A session keeps its provider. Start a new session to switch backends.');
  if (requireGoal && !session.goal) throw new Error('This session has no goal.');
  if (requireGoal && session.goal.status === 'complete') throw new Error('This goal is already complete. Start a new goal to request more work.');
  const recovered = reconcileSession(session.id); Object.assign(session, loadSession(session.id));
  if (recovered.live) return ui.interactive ? attachSession(session, options, ui) : viewSession(session, options, ui);
  if (recovered.state === 'cleanup_required') throw new Error(recovered.reason);
  if (options.model) session.model = options.model;
  const goal = session.goal && session.goal.status !== 'complete';
  if (goal) {
    session.goal.notificationEpoch = (session.goal.notificationEpoch || 0) + 1;
    session.goal.noActivityTurns = 0;
    session.goal.blockerStreak = 0;
    session.goal.lastBlocker = null;
    delete session.goal.reason;
    if (options.tokenBudget) session.goal.tokenBudget = options.tokenBudget;
    if (session.goal.tokenBudget != null && session.goal.tokensUsed >= session.goal.tokenBudget) throw new Error('Goal budget is exhausted. Resume with a larger total --token-budget.');
  }
  if (!goal) {
    if (ui.interactive) return chat(getProvider(session.provider), { ...options, cwd: session.cwd }, ui, session);
    ui.event('session', { session, message: `Session restored: ${session.id}. ${session.goal?.status === 'complete' ? 'Goal already complete.' : 'Open bzzy resume in a terminal to continue chatting.'}` });
    return 0;
  }
  return executeFromCommand(getProvider(session.provider), session, { ...options, cwd: session.cwd }, ui, 'Continue the current task from the saved state; inspect durable checkpoints and recovery evidence first.', { goal: Boolean(goal), resumeGoal: Boolean(goal) });
}

async function executeFromCommand(provider, session, options, ui, prompt, flags) {
  const code = await executeManaged(provider, session, options, ui, prompt, flags);
  if (flags.goal && [0, 2].includes(code) && ui.interactive && !options.detach && !ui.detached) {
    return chat(getProvider(session.provider), { ...options, requestId: undefined }, ui, session);
  }
  return code;
}

async function chat(provider, options, ui, existingSession) {
  if (!ui.interactive) throw new Error('Use bzzy run "task" or bzzy goal "objective" when stdin is not a terminal.');
  const pet = new Pet(ui, options.pet);
  let session = existingSession || createSession(provider, options.cwd, options.model);
  if (!existingSession && options.delegationSelection) { applyDelegationSelection(session, options.delegationSelection); saveSession(session); }
  if (!existingSession && options.bestiesSelection) { applyBestiesSelection(session, options.bestiesSelection); saveSession(session); }
  if (!existingSession && options.parallelAgents) { applyParallelSelection(session, options.parallelAgents); saveSession(session); }
  if (!existingSession && options.debateAgents) { applyDebateSelection(session, options.debateAgents); saveSession(session); }
  if (!existingSession) { applyLaunchSelection(session, options); saveSession(session); }
  ui.setSession(session.id);
  if (existingSession) await restoreConversation(session, ui);
  ui.updateSession?.(session); pet.greet();
  await autoAttachTelegram(session);
  ui.event('info', { message: `${provider.name}\n/goal <objective> · /providers · /models · /debate [objective] · /help`, welcome: true });
  if (options.mode === 'parallel') ui.event('info', { message: 'Parallel mode · chat normally, or use /goal <objective> for independent work by ' + (session.parallelAgents?.map(agent => agent.provider + (agent.model ? ':' + agent.model : '')).join(', ') || options.agents || 'codex,claude,deepseek'), welcome: true });
  if (options.mode === 'debate') ui.event('info', { message: 'Debate mode · get a first response, select the agents, then investigate and debate for up to five rounds.', welcome: true });
  if (session.mode === 'delegate' && session.executor) ui.event('info', { message: describeDelegation(session) });
  if (session.mode === 'besties') ui.event('info', { message: describeBesties(session), welcome: true });
  const debateReply = focus => ui.onDebate(session.id, focus);
  while (true) {
    const input = (await conversationInput(session, ui))?.trim();
    Object.assign(session, loadSession(session.id)); provider = getProvider(session.provider);
    if (input == null || input === '/quit' || input === '/exit') return 0;
    if (!input) continue;
    try {
      if (input === '/help') { ui.event('info', { message: chatHelp }); continue; }
      if (input === '/default') { saveCurrentDefault(session, ui); continue; }
      if (/^\/telegram(?:\s|$)/.test(input)) { await configureTelegram(input.replace(/^\/telegram\s*/, '') || 'panel', ui, { sessionId: session.id }); ui.refreshTelegramState?.(); continue; }
      if (input === '/debate' || input.startsWith('/debate ')) { await debateReply(input.slice(7).trim()); if (ui.detached) return 0; continue; }
      if (input === '/new') {
        const previous = session; session = createSession(provider, options.cwd, previous.model);
        Object.assign(session, { selectedEffort: previous.selectedEffort, modelCapabilities: previous.modelCapabilities, mode: previous.mode, executor: previous.executor, besties: previous.besties, parallelAgents: previous.parallelAgents, debateAgents: previous.debateAgents });
        saveSession(session); ui.setSession(session.id); ui.updateSession(session); await autoAttachTelegram(session); continue;
      }
      if (/^\/providers?(?:\s|$)/.test(input)) {
        const selected = await ui.onProvider(session.id, input.replace(/^\/providers?\s*/, ''));
        if (selected) { session = selected; provider = getProvider(session.provider); ui.setSession(session.id); ui.updateSession(session); }
        continue;
      }
      if (/^\/models?(?:\s|$)/.test(input)) { Object.assign(session, await changeSessionModel(session.id, input.replace(/^\/models?\s*/, ''), ui)); continue; }
      if (input === '/goal' || input.startsWith('/goal ')) {
        const objective = input.slice(5).trim();
        if (!objective || ['status', 'pause', 'cancel', 'clear', 'resume'].includes(objective)) {
          if (!session.goal) throw new Error('No goal yet. Use /goal <objective>.');
          await goalControl(objective || 'status', session.id, { ...options, provider: session.provider }, ui);
          session = findSession(session.id);
        } else {
          const previousGoal = session.goal;
          prepareTask(session, options, objective); session.goal = newGoal(session.contract.objective, options.tokenBudget); saveSession(session);
          session.acceptance = null; session.summary = null; session.failure = null; session.stopReason = null;
          if (previousGoal) putRecord('goal-history', previousGoal.id, { sessionId: session.id, ...previousGoal,
            supersededAt: new Date().toISOString(), supersededBy: session.goal.id });
          saveSession(session);
          await executeManaged(provider, session, options, ui, session.goal.objective, { goal: true });
        }
      } else if (input.startsWith('/')) throw new Error('Unknown command. Use /help.');
      else {
        const chatOptions = { ...options, mode: 'solo' };
        if (!session.contract) prepareTask(session, { ...chatOptions, mode: session.mode || options.mode || 'solo' }, input);
        await executeManaged(provider, session, chatOptions, ui, input);
        if (options.mode === 'debate' && !ui.detached && !ui.nextSession) await debateReply(input);
      }
      if (ui.nextSession) { session = ui.nextSession; ui.nextSession = null; provider = getProvider(session.provider); ui.setSession(session.id); ui.updateSession(session); }
      provider = getProvider(session.provider);
      if (ui.detached) return 0;
    } catch (error) { ui.event('error', { message: error.message }); }
  }
}

async function debateConversation(source, focus, options, ui) {
  if (!source) throw new Error('No conversation selected.');
  const agents = options.debateAgents || await chooseDebate({ ...options, provider: source.provider, model: source.model }, ui);
  if (!agents) return;
  const selected = agents.slice(1);
  const debate = prepareChatDebate(source, focus, selected, { ...options, debateAgents: agents });
  try { await executeManaged(getProvider(debate.session.provider), debate.session, debate.options, ui, debate.session.goal.objective, { goal: true }); }
  finally {
    finishChatDebate(source.id, debate.session.id);
    if (!ui.detached) await restoreConversation(loadSession(source.id), ui);
  }
}

export async function main(argv) {
  if (argv[0] === 'internal-mcp') { await serveGoalTools(argv[1], argv[2]); return 0; }
  if (argv[0] === 'internal-tools') { await serveTaskBridge(argv[1], argv[2]); return 0; }
  if (argv[0] === 'internal-service') return serveRuntime();
  if (argv[0] === 'internal-telegram') return serveTelegramBridge();
  if (argv[0] === 'internal-execution') return executeJob(argv[1]);
  if (argv[0] === 'internal-assignment') return runAssignment(argv[1], Number(argv[2]));
  const { options, args } = parseArgs(argv);
  if (options.version) { process.stdout.write('bzzy 0.2.0\n'); return 0; }
  if (options.whoami) { process.stdout.write(whoami(options.cwd)); return 0; }
  if (options.help || args[0] === 'help') { process.stdout.write(HELP); return 0; }
  if (options.update) {
    if (argv.length !== 1) throw new Error('Run bzzy --update by itself.');
    return updateInstallation();
  }
  if (!fs.statSync(options.cwd).isDirectory()) throw new Error('--cwd must name a directory.');
  options.cwd = fs.realpathSync(options.cwd);
  const ui = new UI(options);
  ui.accountStatusEnabled = ui.interactive;
  ui.telegramSupportEnabled = ui.interactive;
  ui.onDebate = (id, focus) => debateConversation(loadSession(id), focus, options, ui);
  ui.onProvider = (id, argument, connection) => changeConversationProvider(loadSession(id), argument, ui, connection);
  try {
    const [command, ...rest] = args;
    if (command === 'integration') {
      const file = path.join(root, 'docs', 'INTEGRATION.md');
      ui.event('info', { message: fs.readFileSync(file, 'utf8') }); return 0;
    }
    if (options.view) return await viewSession(findSession(options.view), options, ui);
    if (options.attach) return await attachSession(findSession(options.attach), options, ui);
    if (options.resume) return await resume(findSession(options.resume), options, ui);
    if (command === 'activity' || command === 'traffic') {
      const { watchRegistry } = await import('./runtime-client.js');
      return await watchRegistry(findSession(rest[0], options.cwd), options, ui, command === 'traffic' ? 'network.' : 'activity');
    }
    if (command === 'service') {
      if (rest[0] === 'stop') { await stopTelegramBridge(); const info = runtimeInfo(); if (info && identityAlive(info.identity)) await runtimeRequest(info, 'POST', '/shutdown', {}); ui.event('info', { message: 'Runtime stopped. Existing execution runners retain their records and continue independently.' }); }
      else if (rest[0] === 'status') { const info = runtimeInfo(); ui.event('info', { message: info && identityAlive(info.identity) ? `Runtime running at ${info.url}` : 'Runtime stopped.' }); }
      else if (rest[0] === 'web') { const info = await ensureRuntime(); ui.event('info', { message: `${info.url}/#token=${info.token}${rest[1] ? `&session=${findSession(rest[1]).id}` : ''}` }); }
      else if (rest[0] === 'token' && rest[1]) { const info = await ensureRuntime(), result = await runtimeRequest(info, 'POST', '/tokens', { sessionId: findSession(rest[1]).id }); ui.event('token', { ...result, message: `Observer token (session only, expires in 24h): ${result.token}` }); }
      else if (!rest[0] || rest[0] === 'start') { const info = await ensureRuntime(); await ensureTelegramBridge(); ui.event('info', { message: `Runtime ready at ${info.url}` }); }
      else throw new Error('Use bzzy service start|status|stop|web.');
      return 0;
    }
    if (command === 'recover') { const result = reconcileSession(findSession(rest[0], options.cwd).id); ui.event('recovery', { ...result, message: JSON.stringify(result, null, 2) }); return 0; }
    if (command === 'project') { ui.event('project', { message: JSON.stringify(projectContext(options.cwd), null, 2) }); return 0; }
    if (command === 'memory') {
      if (rest[0] === 'invalidate') invalidateMemory(rest[1], rest.slice(2).join(' '));
      else if (rest[0] === 'add') { const session = createSession(selectedProvider(options), options.cwd, options.model); prepareTask(session, options, 'Record project knowledge'); initializeProject(session); ui.event('memory', { memory: remember(session, readJson(path.resolve(rest[1]))), message: 'Project memory recorded.' }); }
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
    if (command === 'telegram') { await configureTelegram(rest[0] || 'status', ui, { sessionId: rest[1] ? findSession(rest[1]).id : undefined }); return 0; }
    if (command === 'notifications') {
      const hub = new NotificationHub({ ui });
      if (rest[0] === 'retry') await hub.retry();
      else if (!rest[0] || rest[0] === 'list') for (const { event, deliveries } of hub.records()) ui.event('notification', { event, deliveries, message: `${event.type} · ${event.sessionId.slice(0, 8)} · ${JSON.stringify(deliveries)}` });
      else throw new Error('Use bzzy notifications list|retry.');
      return 0;
    }
    if (command === 'doctor') {
      let failed = false;
      for (const name of ['codex', 'claude']) {
        try { ui.event('info', { message: `${name}: ${version(name)}` }); }
        catch (error) { failed = true; ui.event('error', { message: error.message }); }
      }
      ui.event('info', { message: `Node ${process.version}\nEnforced permissions: ${sandboxSupport() ? 'Linux bubblewrap available' : 'unavailable (strict tasks fail closed)'}\nConfiguration: ${home()}\nDefault provider: ${config().defaultProvider || 'not selected (first-run setup)'}` });
      return failed ? 1 : 0;
    }
    if (command === 'sessions') {
      for (const session of sessions()) ui.event('session', { session, message: `${session.id.slice(0, 8)} · ${session.provider} · ${session.goal?.status || 'chat'} · ${session.cwd}` });
      return 0;
    }
    if (command === 'resume') return await resume(findSession(rest[0], options.cwd), options, ui);
    if (command === 'goal' && ['status', 'pause', 'cancel', 'clear', 'resume'].includes(rest[0])) return await goalControl(rest[0], rest[1], options, ui);
    const executionCommands = ['run', 'goal', 'chat', 'delegate', 'besties', 'debate', 'parallel', 'paralel'];
    const positionalContext = options.goal
      ? (executionCommands.includes(command) ? rest : args).join(' ').trim()
      : '';
    if (options.contextFile && positionalContext) throw new Error('Choose --context-file or positional initialization context, not both.');
    const initialContext = positionalContext;
    if (command && !executionCommands.includes(command) && !positionalContext) throw new Error(`Unknown command ${command}. Use bzzy --help.`);
    if (options.contextFile && !(options.goal || ['goal', 'delegate', 'besties', 'debate', 'parallel', 'paralel'].includes(command))) throw new Error('--context-file requires --goal or a goal execution command.');
    const contextFileText = options.contextFile ? readContextFile(options.contextFile, options.cwd) : undefined;
    applyLaunchDefault(options);
    if (['delegate', 'besties', 'debate', 'parallel', 'paralel'].includes(command)) options.mode = command === 'paralel' ? 'parallel' : command;
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
          description: options.mode === 'besties' ? 'The agents collaborate and review one another’s evidence.' : options.mode === 'debate' ? 'The main agent answers independent challenges.' : 'The brain assigns work and reviews the executor’s evidence.' });
        if (!objective) return 0;
        options.goal = objective;
      }
    }
    let provider;
    if (!config().defaultProvider && !options.provider && ui.interactive) provider = await setup(ui, options);
    else provider = selectedProvider(options);
    if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
    if (options.goal || ['goal', 'run', 'delegate', 'besties', 'debate', 'parallel', 'paralel'].includes(command)) {
      const prompt = options.goal || rest.join(' ');
      if (!prompt.trim()) throw new Error(`Supply a ${command === 'run' ? 'task' : 'goal objective'}.`);
      // Snapshot file contents only into the contract, not queued execution options.
      // Long instructions must not overflow the runtime API or require the source on resume.
      const taskOptions = { ...options, initialContext: positionalContext, contextFileText };
      let session;
      const goal = Boolean(options.goal || command !== 'run' || ['parallel', 'besties', 'debate'].includes(options.mode));
      const creationInput = { provider: provider.id, model: options.model || null, cwd: options.cwd, prompt, initialContext: positionalContext || null,
        ...(contextFileText == null ? {} : { contextFileDigest: digest(contextFileText) }), goal, mode: options.mode || 'solo',
        contractDigest: options.contract ? digest(fs.readFileSync(path.resolve(options.contract))) : null,
        authorization: { yolo: options.yolo, readOnly: options.readOnly || false, tokenBudget: options.tokenBudget || null, runtime: options.runtimeSeconds || null, executor: options.delegationSelection?.executor || options.executor || null,
          supervisorEffort: options.delegationSelection?.supervisor.effort || options.effort || null, executorModel: options.executorModel || null, agents: options.agents || null, parallelAgents: options.parallelAgents || null, debateAgents: options.debateAgents || null, besties: options.besties || null, participants: options.participants || null } };
      if (options.requestId) {
        const reserved = reserveRequest('cli-create', options.requestId, creationInput, db => {
          const initial = { version: 1, id: randomUUID(), provider: provider.id, backend: provider.backend, cwd: options.cwd, model: options.model || provider.model || null,
            engineThreadId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), turns: 0, goal: null, executionState: 'idle' };
          applyDelegationSelection(initial, options.delegationSelection); applyBestiesSelection(initial, options.bestiesSelection); applyParallelSelection(initial, options.parallelAgents); applyDebateSelection(initial, options.debateAgents); applyLaunchSelection(initial, options); prepareTask(initial, taskOptions, prompt, { persist: false });
          if (goal && !initialContext) initial.goal = newGoal(initial.contract.objective, options.tokenBudget || initial.contract.limits.tokenBudget);
          putRecord('session', initial.id, initial, db); appendEvent(initial.id, 'session.created', { sessionId: initial.id }, db); return { sessionId: initial.id };
        });
        session = loadSession(reserved.sessionId);
        if (!initialContext && listRecords('execution').some(j => j.sessionId === session.id)) return await viewSession(session, options, ui);
      } else {
        session = createSession(provider, options.cwd, options.model); applyDelegationSelection(session, options.delegationSelection); applyBestiesSelection(session, options.bestiesSelection); applyParallelSelection(session, options.parallelAgents); applyDebateSelection(session, options.debateAgents); applyLaunchSelection(session, options); prepareTask(session, taskOptions, prompt);
        if (goal && !initialContext) session.goal = newGoal(session.contract.objective, options.tokenBudget || session.contract.limits.tokenBudget);
      }
      saveSession(session);
      ui.event('session', { sessionId: session.id, message: `Session ${session.id}` });
      if (initialContext) {
        const contextOptions = { ...options, detach: false, ...(options.requestId ? { requestId: `${options.requestId}:context` } : {}) };
        const contextCode = await executeManaged(provider, session, contextOptions, ui, initialContext, { goal: false, returnAfterExecution: true });
        if (contextCode !== 0) return contextCode;
        Object.assign(session, loadSession(session.id));
        if (!session.goal) session.goal = newGoal(session.contract.objective, options.tokenBudget || session.contract.limits.tokenBudget);
        else if (session.goal.objective !== session.contract.objective.trim()) throw new Error('The saved goal does not match --goal. Use a new --request-id.');
        saveSession(session);
      }
      const executionOptions = initialContext && options.requestId ? { ...options, requestId: `${options.requestId}:goal` } : options;
      return await executeFromCommand(provider, session, executionOptions, ui, prompt, { goal });
    }
    return await chat(provider, options, ui);
  } finally { ui.close(); }
}
