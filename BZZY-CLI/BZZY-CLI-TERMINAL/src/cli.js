import { saveSessionDefaultSelection, savedDefaultMessage } from './session-defaults.js';
import fs from 'node:fs';
import path from 'node:path';
import { config, providers, getProvider, setDefault, addProvider, apiKey, saveKey, ensureApiKey, chooseProvider, saveDefaultSelection } from './providers.js';
import { chooseModel } from './models.js';
import { home, findSession, sessions, loadSession, normalizeSessionAlias, setSessionAlias } from './store.js';
import { chooseSavedSession, namedTerminalSessions, promptSessionAlias, queueSessionBrowser, sessionLabel } from './session-browser.js';
import { exportProject, importProject } from './project-bundle.js';
import { shareTerminal, importTerminal, relayImportArgument, forgetPrivateImportInput } from './share-ui.js';
import { skillThat } from './skill-that.js';
import { root } from './process.js';
import { checkConnections } from './connection-check.js';
import { UI } from './ui.js';
import { Pet } from './mascot.js';
import { NotificationHub } from './notifications.js';
import { executeManaged, viewSession, attachSession, changeSessionModel } from './runtime-client.js';
import { ensureRuntime, runtimeInfo, runtimeRequest } from './runtime.js';
import { agentChoice } from './delegation.js';
import { readContextFile } from './task.js';
import { reconcileSession, identityAlive } from './recovery.js';
import { recall, invalidateMemory } from './memory.js';
import { sandboxSupport } from './policy.js';
import { projectContext } from './project.js';
import { subscriptionStatus } from './auth.js';
import { prepareChatDebate, finishChatDebate } from './chat-debate.js';
import { restoreConversation, conversationInput } from './runtime-client.js';
import { changeConversationProvider } from './conversation-settings.js';
import { chooseDelegation, describeDelegation } from './delegation-setup.js';
import { chooseBestiesWithDefault, configuredBesties, describeBesties } from './besties-setup.js';
import { chooseParallelWithDefault, chooseParallelGoal, configuredParallel } from './parallel-setup.js';

import { chooseDebate, configuredDebate } from './debate-setup.js';
import { chooseSavedCombo } from './mode-presets.js';
import { chatHelp } from './terminal-commands.js';
import { whoami } from './whoami.js';
import { updateCoreAndCLI } from './update.js';
import { readUpdateHandoff, execUpdatedCLI } from './update-handoff.js';
import { retireTelegram } from './migrations.js';
import { backendCommand } from '@bzzy/core/engine/entry.js';
import { activateCLIHost, coreHostStatus, stopCoreHost } from '@bzzy/core/engine/host-service.js';
import { selectedProvider, authenticateSubscription, applyLaunchDefault, createChatSession, newConversation, startConversationGoal,
  prepareConversationTurn, controlSavedGoal, prepareResume, recordProjectMemory, createTaskSession, activateTaskGoal } from '@bzzy/core/engine/host-commands.js';

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
  bzzy export [FILE.zip]                Export this directory and all saved project context
  bzzy --import FILE.zip|CODE          Restore a project ZIP or Relay terminal copy here
  bzzy setup                            Choose a backend and authenticate
  bzzy settings                         API key, default folder, Pair iPhone and Core controls
  bzzy auth [codex|claude|deepseek|name]  Log in or save an API key
  bzzy providers                        List providers
  bzzy provider use NAME                 Set the default provider
  bzzy provider add NAME --base-url URL --model MODEL --env-key KEY_NAME
  bzzy notifications [list|retry]        Inspect the delivery outbox
  bzzy doctor [--live]                   Verify CLI, subscription login and connection; --live tests replies

Options:
  --provider NAME       Select a provider for a new session
  --model MODEL         Select a model (provider default otherwise)
  --cwd DIRECTORY       Working directory
  --alias NAME          Name a session; restore it later with --attach NAME or --resume NAME
  --import FILE.zip|CODE Restore a project ZIP or expiring Relay terminal copy into --cwd; never starts work
  --goal OBJECTIVE      Start a persistent goal; quoted positional text is sent first as context
  --context-file FILE   UTF-8 task instructions (up to 1 MiB), relative to --cwd; no initialization chat
  --token-budget N      Optional goal token budget
  --max-turns N         Optional goal turn limit; pauses rather than completes
  --runtime N           Total active runtime limit in seconds
  --max-retries N       Bounded acceptance follow-ups (default 2)
  --contract FILE       Task JSON: constraints, criteria, artifacts, checks and limits
  --read-only           Enforce read-only tools (requires a working OS sandbox)
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
/new, /alias [name], /sessions, /export [FILE.zip], /share, /import [CODE], /skill_that [name], /providers [name], /models [name|default], /default, /usage, /settings, /help, /exit
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
  const values = { '--provider': 'provider', '--model': 'model', '--cwd': 'cwd', '--alias': 'alias', '--import': 'importFile', '--goal': 'goal', '--context-file': 'contextFile',
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
    else if (raw === '--live') options.live = true;
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
  if (options.alias != null) options.alias = normalizeSessionAlias(options.alias);
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
  const pet = new Pet(ui, options.pet);
  let session = existingSession || createChatSession(provider, options);
  ui.setSession(session.id);
  if (existingSession) await restoreConversation(session, ui);
  ui.updateSession?.(session); pet.greet();
  ui.event('info', { message: `${provider.name}\n/goal <objective> · /providers · /models · /debate [objective] · /help`, welcome: true });
  if (options.mode === 'parallel') ui.event('info', { message: 'Parallel mode · chat normally, or use /goal <objective> for independent work by ' + (session.parallelAgents?.map(agent => agent.provider + (agent.model ? ':' + agent.model : '')).join(', ') || options.agents || 'codex,claude,deepseek'), welcome: true });
  if (options.mode === 'debate') ui.event('info', { message: 'Debate mode · get a first response, select the agents, then investigate and debate for up to five rounds.', welcome: true });
  if (session.mode === 'delegate' && session.executor) ui.event('info', { message: describeDelegation(session) });
  if (session.mode === 'besties') ui.event('info', { message: describeBesties(session), welcome: true });
  const debateReply = focus => ui.onDebate(session.id, focus);
  while (true) {
    const input = (await conversationInput(session, ui))?.trim();
    if (ui.nextSession) { const selected = ui.nextSession; ui.nextSession = null; return await attachSession(selected, options, ui); }
    Object.assign(session, loadSession(session.id)); provider = getProvider(session.provider);
    if (input == null || input === '/quit' || input === '/exit') return 0;
    if (!input) continue;
    if (await ui.settingsCommand(input)) continue;
    try {
      if (input === '/help') { ui.event('info', { message: chatHelp }); continue; }
      if (input === '/sessions') { const selected = await chooseSavedSession(ui); if (selected) return await attachSession(selected.session, options, ui); continue; }
      if (input === '/doctor') { await checkConnections(ui, { providerId: session.provider, live: true, model: session.model, effort: session.selectedEffort, session }); continue; }
      if (input === '/default') { saveCurrentDefault(session, ui); continue; }
      if (/^\/alias(?:\s|$)/.test(input)) { session = await promptSessionAlias(session.id, input.replace(/^\/alias\s*/, ''), ui); continue; }
      if (/^\/export(?:\s|$)/.test(input)) { await exportProject(session, input.replace(/^\/export\s*/, ''), ui); continue; }
      if (/^\/share(?:\s|$)/.test(input)) {
        if (input !== '/share') throw new Error('Use /share without arguments.');
        await shareTerminal(session, ui); continue;
      }
      if (/^\/import(?:\s|$)/.test(input)) { forgetPrivateImportInput(ui, input); await importTerminal(input.replace(/^\/import\s*/, ''), session.cwd, ui); continue; }
      if (/^\/skill_that(?:\s|$)/.test(input)) { await skillThat(session, input.replace(/^\/skill_that\s*/, ''), ui); continue; }
      if (input === '/debate' || input.startsWith('/debate ')) { await debateReply(input.slice(7).trim()); if (ui.detached) return 0; continue; }
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
      if (session.modelSelectionRequired) throw new Error('Select a model using the model dropdown before sending a message.');
      if (input === '/goal' || input.startsWith('/goal ')) {
        const objective = input.slice(5).trim();
        if (!objective || ['status', 'pause', 'cancel', 'clear', 'resume'].includes(objective)) {
          if (!session.goal) throw new Error('No goal yet. Use /goal <objective>.');
          await goalControl(objective || 'status', session.id, { ...options, provider: session.provider, inChat: true }, ui);
          session = findSession(session.id);
        } else {
          startConversationGoal(session, options, objective);
          await executeManaged(provider, session, options, ui, session.goal.objective, { goal: true });
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
  const updateHandoff = readUpdateHandoff();
  if (updateHandoff) argv = updateHandoff.sessionId && !updateHandoff.settingsOnly && !updateHandoff.coreStopped
    ? [updateHandoff.mode === 'VIEW' ? '--view' : '--attach', updateHandoff.sessionId]
    : updateHandoff.settingsOnly || updateHandoff.coreStopped ? ['settings'] : [];
  if (['internal-mcp', 'internal-tools', 'internal-service', 'internal-execution', 'internal-assignment'].includes(argv[0])) return backendCommand(argv);
  const { options, args } = parseArgs(argv);
  if (updateHandoff) options.restoreAfterUpdate = true;
  if (options.version) { process.stdout.write('bzzy 0.2.0\n'); return 0; }
  if (options.whoami) { process.stdout.write(whoami(options.cwd)); return 0; }
  if (options.help || args[0] === 'help') { process.stdout.write(HELP); return 0; }
  if (['telegram', 'internal-telegram'].includes(args[0])) throw new Error('The Telegram integration has been removed. Use the terminal or the scoped integration API.');
  if (options.update) {
    if (argv.length !== 1) throw new Error('Run bzzy --update by itself.');
    return updateCoreAndCLI();
  }
  try { if (!fs.statSync(options.cwd).isDirectory()) throw new Error('not a directory'); }
  catch { throw new Error(`--cwd must name an existing directory: ${options.cwd}`); }
  options.cwd = fs.realpathSync(options.cwd);
  await retireTelegram();
  const launchCommand = args[0];
  const staticCommands = new Set(['integration', 'export', 'project', 'memory', 'providers', 'provider', 'doctor', 'notifications', 'recover', 'setup', 'auth']);
  if (!updateHandoff?.coreStopped && !staticCommands.has(launchCommand) && !(launchCommand === 'service' && ['status', 'stop', 'restart'].includes(args[1]))) {
    await activateCLIHost();
  }
  const ui = new UI({ ...options, hostMetrics: true, updateHandoff });
  ui.accountStatusEnabled = ui.interactive;
  ui.onDebate = (id, focus) => debateConversation(loadSession(id), focus, options, ui);
  ui.onProvider = (id, argument, connection) => changeConversationProvider(loadSession(id), argument, ui, connection);
  ui.onSessions = () => queueSessionBrowser(ui);
  const launch = async () => {
    const [command, ...rest] = args;
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
      if (relayImportArgument(options.importFile)) await importTerminal(options.importFile, options.cwd, ui);
      else await importProject(options.importFile, options.cwd, ui);
      return 0;
    }
    if (command === 'export') { await exportProject(options.cwd, rest[0], ui); return 0; }
    if (command === 'integration') {
      const file = path.join(root, 'docs', 'INTEGRATION.md');
      ui.event('info', { message: fs.readFileSync(file, 'utf8') }); return 0;
    }
    if (options.view || options.attach) {
      let session = findSession(options.view || options.attach);
      if (options.alias != null) session = setSessionAlias(session.id, options.alias);
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
      else if (rest[0] === 'restart') { await stopCoreHost(); await activateCLIHost(); await ensureRuntime(); ui.event('info', { message: 'Core restarted. Paused work remains paused.' }); }
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
      else if (!rest[0] || rest[0] === 'list') for (const { event, deliveries } of hub.records()) ui.event('notification', { event, deliveries, message: `${event.type} · ${event.sessionId.slice(0, 8)} · ${JSON.stringify(deliveries)}` });
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
    if (!config().defaultProvider && !options.provider && !options.model && ui.interactive && !options.goal && (!command || command === 'chat') && !options.mode) {
      options.modelSelectionRequired = true;
      provider = selectedProvider(options);
    }
    else provider = selectedProvider(options);
    if (provider.auth === 'api-key' && !options.modelSelectionRequired) await ensureApiKey(provider, ui);
    if (options.goal || ['goal', 'run', 'delegate', 'besties', 'debate', 'parallel', 'paralel'].includes(command)) {
      const prompt = options.goal || rest.join(' ');
      if (!prompt.trim()) throw new Error(`Supply a ${command === 'run' ? 'task' : 'goal objective'}.`);
      const goal = Boolean(options.goal || command !== 'run' || ['parallel', 'besties', 'debate'].includes(options.mode));
      const created = createTaskSession(provider, options, prompt, { goal, initialContext, contextFileText });
      const session = created.session;
      if (created.existingExecution) return await viewSession(session, options, ui);
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
