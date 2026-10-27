import { chooseEffort } from './model-controls.js';
import { saveSessionDefaultSelection, savedDefaultMessage } from './session-defaults.js';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runtimeRequest, requireOwner, operatorStopRequested } from './runtime.js';
import { delay } from './delegation.js';
import { loadSession } from './store.js';
import { chooseModel, assertModelIdle } from './models.js';
import { chatHelp } from './terminal-commands.js';
import { chooseSavedSession, promptSessionAlias, forgetDeletedConversation } from './session-browser.js';
import { exportProject } from './project-bundle.js';
import { shareTerminal, forgetPrivateImportInput } from './share-ui.js';
import { shareLibrary, importRelayShare } from './library-ui.js';
import { skillThat } from './skill-that.js';
import { checkConnections } from './connection-check.js';
import { enqueueGoalTurn, updateIdleGoal, setSessionModel, setSessionProvider, setSessionMode, assertSessionModeSwitch, executionRecord } from '@bzzy/core/engine/session-operations.js';
import { modeDefault, getProvider, ensureApiKey } from './providers.js';
import { chooseSavedCombo } from './mode-presets.js';
import { chooseDelegation } from './delegation-setup.js';
import { chooseDebate } from './debate-setup.js';
import { initializeLaunchYolo } from './permission-controls.js';
import { confirmGoalReplacement, resolveInteractiveGoal } from './goal-controls.js';

const groupMode = session => ['parallel', 'besties'].includes(session.mode);
const executionActive = execution => execution && ['queued', 'launching', 'running'].includes(execution.state);
const reconnectable = error => !operatorStopRequested() && (error instanceof TypeError && /fetch|network/i.test(error.message) || ['CORE_MAINTENANCE', 'ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'TimeoutError', 'AbortError'].includes(error.code || error.name));

function saveSessionDefault(sessionId, ui) {
  const selected = saveSessionDefaultSelection(loadSession(sessionId));
  ui.event('info', { message: savedDefaultMessage(selected) });
  return selected;
}

function client(info, sessionId, owner) {
  return (method, action = '', body, requestId) => {
    if (method === 'POST' && ['execute', 'answer', 'control'].includes(action)) {
      return runtimeRequest(info, method, `/sessions/${sessionId}/input`, { ...body, owner, operation: action,
        ...(action === 'execute' && body?.goal ? { preparedGoalId: loadSession(sessionId).goal?.id } : {}) }, requestId || randomUUID());
    }
    return runtimeRequest(info, method, `/sessions/${sessionId}${action ? '/' + action : ''}`, body ? { ...body, owner } : body, requestId);
  };
}
async function replay(api, sessionId, ui, selected = () => true) {
  let cursor = ui.cursors?.get(sessionId) || 0;
  while (true) {
    const batch = await api('GET', `events?after=${cursor}&limit=200`);
    if (!selected()) return;
    for (const event of batch.events) {
      ui.event(event.type, { ...event.data, seq: event.seq, occurredAt: event.createdAt, eventSessionId: event.sessionId || sessionId });
      cursor = event.seq;
    }
    ui.cursors?.set(sessionId, cursor);
    if (!batch.hasMore) { if (batch.events.length) ui.redrawPrompt?.(); return; }
  }
}
async function replayRoom(api, roomSessionId, ui, selected = () => true) {
  const key = `${roomSessionId}:shared-room`; let cursor = ui.cursors?.get(key) || 0;
  while (true) {
    const batch = await api('GET', `events?after=${cursor}&limit=200`);
    if (!selected()) return;
    for (const event of batch.events) {
      if (['peer.message', 'peer.review'].includes(event.type)) ui.event(event.type, { ...event.data, seq: event.seq, occurredAt: event.createdAt });
      cursor = event.seq;
    }
    ui.cursors?.set(key, cursor);
    if (!batch.hasMore) { if (batch.events.length) ui.redrawPrompt?.(); return; }
  }
}
async function editConversation(sessionId, ui, connection, choose, apply, { assert = assertModelIdle, message } = {}) {
  const info = connection?.info || await ensureRuntime(), owner = connection?.owner || randomUUID(), api = client(info, sessionId, owner);
  if (connection?.acquire) await connection.acquire({ localMutation: true });
  else if (!connection) await api('POST', 'claim', { takeover: true });
  const heartbeat = !connection ? setInterval(() => api('POST', 'claim', {}).catch(() => ui.reader?.close()), 10000) : null;
  try {
    const current = (await api('GET')).session; assert(current);
    const selected = await choose(current);
    if (!selected) return current;
    const session = apply(sessionId, owner, selected, { authorize: () => connection?.authorize?.() });
    ui.updateSession?.(await api('GET'));
    ui.event('info', { message: message ? message(session) : `${session.provider} · ${session.model || 'provider default'}${session.selectedEffort ? ' · effort ' + session.selectedEffort : ''} · conversation retained · applies to the next message.` });
    return session;
  } finally { clearInterval(heartbeat); if (!connection) await api('POST', 'release', {}).catch(() => {}); }
}
export async function changeSessionModel(sessionId, argument, ui, connection) {
  return editConversation(sessionId, ui, connection, current => argument === '@effort' ? chooseEffort(current, ui) : chooseModel(current, argument, ui), setSessionModel);
}
export async function changeSessionSelection(sessionId, selected, ui, connection) {
  return editConversation(sessionId, ui, connection, () => selected, setSessionModel);
}
export async function changeSessionProvider(source, provider, selected, ui, connection) {
  return editConversation(source.id, ui, connection, () => selected,
    (sessionId, owner, selection, authorization) => setSessionProvider(sessionId, owner, source.provider, provider.id, selection, authorization));
}

export async function changeSessionMode(sessionId, mode, ui, connection) {
  if (ui.sessionMode === 'VIEW' && !connection) throw new Error('This is a read-only view. Attach to change the chat mode.');
  return editConversation(sessionId, ui, connection, async current => {
    let selection;
    if (mode === 'delegate') {
      const saved = await chooseSavedCombo('delegate', { useDefault: Boolean(modeDefault('delegate')) }, ui);
      selection = saved === false ? await chooseDelegation({ cwd: current.cwd, provider: current.provider, model: current.model,
        effort: current.selectedEffort, executor: current.executor?.provider, executorModel: current.executor?.model }, ui)
        : saved && { supervisor: saved[0], executor: saved[1] };
      if (!selection) return null;
    } else if (mode === 'debate') {
      const agents = await chooseDebate({ cwd: current.cwd, provider: current.provider, model: current.model,
        effort: current.selectedEffort, useDefault: Boolean(modeDefault('debate')) }, ui);
      if (!agents) return null;
      selection = { agents };
    }
    if (selection) {
      for (const agent of selection.agents || [selection.supervisor, selection.executor]) {
        const provider = getProvider(agent.provider);
        if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
      }
    }
    return { mode, selection, expectedUpdatedAt: current.updatedAt };
  }, (id, owner, selected, authorization) => setSessionMode(id, owner, selected, authorization), {
    assert: assertSessionModeSwitch,
    message: session => `${session.mode === 'delegate' ? `Delegate · brain: ${session.provider} · ${session.model || 'provider default'} · executor: ${session.executor.provider} · ${session.executor.model || 'provider default'}`
      : session.mode === 'debate' ? `Validate · ${session.debateAgents.map(agent => `${agent.provider} · ${agent.model || 'provider default'}`).join(' / ')}`
      : `Solo · ${session.provider} · ${session.model || 'provider default'}`} · same chat retained · still paused. Send a message or use /goal resume when ready.`,
  });
}

export async function conversationModeCommand(input, sessionId, ui, connection) {
  const command = /^\/(delegate|validate|debate|solo|singular)(?:\s|$)/.exec(input);
  if (!command) return false;
  const review = ['validate', 'debate'].includes(command[1]);
  if (review && loadSession(sessionId)?.goal?.status === 'complete') return false; // Review the original achieved goal immediately.
  if (review && input.trim() !== '/' + command[1]) return false;
  if (input.trim() !== '/' + command[1]) throw new Error('Use /delegate, /validate or /solo without arguments after pausing the chat.');
  await changeSessionMode(sessionId, command[1] === 'singular' ? 'solo' : review ? 'debate' : command[1], ui, connection);
  return true;
}
export async function executeManaged(provider, session, options, ui, prompt, flags = {}) {
  options = ui.executionOptions?.(options, session) || options;
  ui.setSession?.(session.id);
  const { returnAfterExecution = false, ...executionFlags } = flags;
  if (process.env.BZZY_DIRECT === '1') { const { runSession } = await import('./controller.js'); return runSession(provider, session, options, ui, prompt, executionFlags); }
  const info = await ensureRuntime(), owner = randomUUID(), api = client(info, session.id, owner);
  if (ui.launchYolo === true || options.yolo) await api('POST', 'claim', { takeover: true });
  try {
    initializeLaunchYolo(ui, session.id, owner);
    const result = await api('POST', 'execute', { prompt, options, ...executionFlags }, options.requestId || randomUUID());
    if (options.detach) { ui.event('info', { message: `Running independently.\nView: bzzy --view ${session.id}\nAttach: bzzy --attach ${session.id}` }); return 0; }
    return await watch(info, session.id, owner, ui, groupMode(session) && ui.interactive && !returnAfterExecution ? { activeControl: true, follow: true, allowControlOnInput: true } : { executionId: result.executionId, activeControl: true, allowControlOnInput: ui.interactive });
  } finally { await api('POST', 'release', {}).catch(() => {}); Object.assign(session, loadSession(session.id)); }
}

export async function submitManagedGoal(session, options, ui, objective) {
  const replacement = await confirmGoalReplacement(ui, loadSession(session.id).goal);
  if (!replacement.confirmed) return 0;
  const info = await ensureRuntime(), owner = randomUUID();
  const result = await runtimeRequest(info, 'POST', `/sessions/${session.id}/input`, {
    operation: 'goal', owner, objective, options: ui.executionOptions?.(options, session) || options,
    replaceGoalId: replacement.replaceGoalId,
  }, options.requestId || randomUUID());
  return watch(info, session.id, owner, ui, { executionId: result.executionId, activeControl: true, allowControlOnInput: ui.interactive });
}
async function watch(info, sessionId, owner, ui, options = {}) {
  const previousPermissions = ui.permissionConnection, previousApproval = ui.onAnswerApproval;
  const api = client(info, sessionId, owner); let detached = false, paused = false, ownershipLost = false, inputStopped = false, modalTask = false, processingInput = false, refreshInput = false;
  let pendingInput = null;
  const closeWatchInput = () => {
    if (!pendingInput || processingInput || modalTask) return false;
    const reader = pendingInput.reader || (ui.reader !== pendingInput.previousReader ? ui.reader : null);
    if (!reader || ui.reader !== reader) return false;
    reader.close(); return true;
  };
  const loseControl = () => {
    if (ownershipLost) return;
    ownershipLost = true;
    ui.setSession?.(sessionId, 'VIEW');
    ui.event('info', { message: 'Another client controls input. This terminal remains live; send a message or answer a pending request to continue here.' });
    if (ui.interactive && options.allowControlOnInput) { options.follow = true; options.executionId = undefined; }
  };
  const acquireControl = async ({ localMutation = false } = {}) => {
    if (!options.allowControlOnInput && (!options.activeControl || ownershipLost)) throw new Error('This session was opened read-only. Attach with control to send input.');
    if (localMutation) await api('POST', 'claim', { takeover: true });
    options.activeControl = true; ownershipLost = false;
    ui.setSession?.(sessionId, 'CONTROL');
  };
  if (options.activeControl || options.allowControlOnInput) ui.permissionConnection = { info, owner, sessionId, acquire: acquireControl };
  const initial = await api('GET'); let children = initial.capabilities.chatTabs ? initial.children : [];
  let roomSessionId = initial.session.bestiesSessionId || (initial.session.mode === 'besties' ? sessionId : null);
  let roomApi = roomSessionId ? client(info, roomSessionId, owner) : null;
  let tabs = [{ id: sessionId, agent: 'Overview' }, ...children], activeId = ui.activeTab && tabs.some(t => t.id === ui.activeTab) ? ui.activeTab
    : ui.interactive && initial.session.mode === 'parallel' && children.length ? children[0].id : sessionId;
  const seenQuestions = new Set();
  ui.onAnswerApproval = async (question, answer) => {
    if (detached) throw new Error('This terminal is detached.');
    await acquireControl();
    await api('POST', 'answer', { questionId: question.id, answer }, randomUUID());
  };
  if (options.restoreInitial) {
    const selected = activeId === sessionId ? initial : await client(info, activeId, owner)('GET');
    ui.openTerminal?.();
    if (children.length && ui.setTabs) ui.setTabs(sessionId, children, activeId);
    else { ui.tui?.selectTab(ui.activeTab || ui.sessionId, sessionId); ui.setSession?.(sessionId, options.activeControl ? 'CONTROL' : 'VIEW'); }
    ui.sessionMode = options.activeControl ? 'CONTROL' : 'VIEW';
    ui.clearHistory?.(); ui.cursors?.set(activeId, 0);
    if (roomSessionId) ui.cursors?.set(`${roomSessionId}:shared-room`, 0);
    ui.updateSession?.(selected);
    await replay(client(info, activeId, owner), activeId, ui);
    if (roomApi && activeId !== roomSessionId) await replayRoom(roomApi, roomSessionId, ui);
  } else if (children.length) ui.setTabs?.(sessionId, children, activeId);
  const showTabs = () => ui.event('info', { message: tabs.map((t, i) => `${i}. ${t.agent} · ${t.id}`).join('\n') + '\nUse /tab NUMBER or /tab NAME. Tab / Shift+Tab also switches chats.' });
  const selectTab = value => {
    const selected = /^\d+$/.test(value) ? tabs[Number(value)] : tabs.find(t => t.agent === value || t.agent.startsWith(value + '-') || t.id.startsWith(value));
    if (!selected) throw new Error('Unknown chat tab. Use /tabs to list chats.');
    activeId = selected.id; seenQuestions.clear(); ui.cursors?.set(activeId, 0); if (roomSessionId) ui.cursors?.set(`${roomSessionId}:shared-room`, 0); ui.clearHistory?.(); ui.setTabs?.(sessionId, children, activeId);
    ui.reader?.setPrompt(`bzzy (${selected.agent}) › `); ui.reader?.prompt(true);
  };
  if (children.length && !ui.tui) showTabs();
  const previousSelectTab = ui.onSelectTab;
  ui.onSelectTab = id => { if (!modalTask) selectTab(id); };
  const keypress = (_text, key) => { if (!modalTask && !key?.bzzyHandled && !ui.tui?.selection && children.length && key?.name === 'tab') { const index = tabs.findIndex(t => t.id === activeId); selectTab(String((index + (key.shift ? tabs.length - 1 : 1)) % tabs.length)); } };
  if (ui.interactive) ui.input?.on('keypress', keypress);
  const interrupt = () => {
    if (modalTask) return;
    if (!options.activeControl || ownershipLost || paused) { detached = true; closeWatchInput(); return; }
    paused = true; api('POST', 'control', { action: 'pause' }, randomUUID()).catch(error => ui.event('error', { message: error.message }));
  };
  process.on('SIGINT', interrupt);
  const inputLoop = ui.interactive ? (async () => {
    while (!inputStopped && !detached && !ui.nextSession && !ui.coreLifecycleInterrupted) {
      const reading = { previousReader: ui.reader, reader: null }; pendingInput = reading;
      let input;
      try {
        const answer = ui.ask(`bzzy ${children.length ? '(' + (tabs.find(t => t.id === activeId)?.agent || 'Overview') + ')' : '(running)'} › `);
        // UI.ask queues its reader creation. Capture this prompt's reader after
        // that microtask, rather than closing a later command's nested reader.
        await Promise.resolve();
        if (ui.reader !== reading.previousReader) reading.reader = ui.reader;
        input = await answer;
      } finally { if (pendingInput === reading) pendingInput = null; }
      if (inputStopped) { if (input != null) (ui.pendingChatInputs ||= []).push(input); break; }
      if (input == null && refreshInput) { refreshInput = false; continue; }
      if (input == null) { if (!paused) detached = true; break; }
      const text = input.trim(); if (!text) continue;
      processingInput = true;
      try {
        if (['/detach', '/quit', '/exit'].includes(text)) { detached = true; ui.detached = true; break; }
        if (text === '/tabs') { showTabs(); continue; }
        if (text === '/help') { ui.event('info', { message: chatHelp }); continue; }
        if (text.startsWith('/open-session ')) {
          const chosen = (await import('./session-browser.js')).namedTerminalSessions().find(item => item.id === text.slice(14).trim());
          if (chosen) ui.nextSession = chosen;
          continue;
        }
        if (text === '/sessions') {
          modalTask = true;
          try { const selected = await chooseSavedSession(ui); if (selected) ui.nextSession = selected.session; }
          catch (error) { ui.event('error', { message: error.message }); }
          finally { modalTask = false; }
          continue;
        }
        if (text === '/update' || text === '/yolo' || /^\/(?:settings|skills|agents|subagents|workflow|saved-goals|metrics|debug|full_debug_export|session-action|library|create-skill|create-agent)(?:\s|$)/.test(text)) {
          modalTask = true;
          try { await ui.settingsCommand(text); } finally { modalTask = false; }
          continue;
        }
        if (text === '/doctor') {
          modalTask = true;
          try { const selected = loadSession(activeId); await checkConnections(ui, { providerId: selected.provider, live: true, model: selected.model, effort: selected.selectedEffort, session: selected }); }
          finally { modalTask = false; }
          continue;
        }
        if (/^\/export(?:\s|$)/.test(text)) {
          modalTask = true;
          try { await exportProject(loadSession(sessionId), text.replace(/^\/export\s*/, ''), ui); }
          finally { modalTask = false; }
          continue;
        }
        if (/^\/(?:share|import)(?:\s|$)/.test(text)) {
          forgetPrivateImportInput(ui, text);
          await acquireControl();
          modalTask = true;
          try {
            if (/^\/share(?:\s|$)/.test(text)) {
              if (text === '/share library') await shareLibrary(loadSession(sessionId).cwd, ui);
              else if (text === '/share') await shareTerminal(loadSession(sessionId), ui);
              else throw new Error('Use /share for a full session, or /share library for reusable Library entries.');
            } else await importRelayShare(text.replace(/^\/import\s*/, ''), loadSession(sessionId).cwd, ui, { chooseDestination: true });
          } finally { modalTask = false; }
          continue;
        }
        if (text.startsWith('/tab ')) { selectTab(text.slice(5).trim()); continue; }
        const isGoalCommand = /^\/goal(?:\s|$)/.test(text);
        if (!isGoalCommand) {
          if (!options.allowControlOnInput && (!options.activeControl || ownershipLost)) { ui.event('info', { message: 'This is a read-only view. Use --attach to send agent input.' }); continue; }
          await acquireControl({ localMutation: text.startsWith('/') });
        }
        if (text === '/default') { saveSessionDefault(activeId, ui); continue; }
        if (/^\/skill_that(?:\s|$)/.test(text)) {
          modalTask = true;
          try { await skillThat(loadSession(sessionId), text.replace(/^\/skill_that\s*/, ''), ui); }
          finally { modalTask = false; }
          continue;
        }
        if (/^\/alias(?:\s|$)/.test(text)) {
          modalTask = true;
          try { await promptSessionAlias(sessionId, text.replace(/^\/alias\s*/, ''), ui, () => requireOwner(sessionId, owner)); }
          finally { modalTask = false; }
          continue;
        }
        const selectedApi = client(info, activeId, owner);
        if (/^\/(?:delegate|solo|singular)(?:\s|$)/.test(text) || /^\/(?:validate|debate)$/.test(text) && loadSession(activeId)?.goal?.status !== 'complete') {
          modalTask = true;
          try {
            await conversationModeCommand(text, activeId, ui, { info, owner, authorize: () => requireOwner(activeId, owner) });
            const fresh = loadSession(activeId);
            options.executionOptions = { ...options.executionOptions, mode: fresh.mode, provider: fresh.provider, model: fresh.model,
              effort: fresh.selectedEffort, executor: fresh.executor?.provider, executorModel: fresh.executor?.model, debateAgents: fresh.debateAgents };
          }
          finally { modalTask = false; }
          continue;
        }
        if (/^\/models?(?:\s|$)/.test(text)) {
          if (children.length && activeId === sessionId) throw new Error('Select an agent chat tab before changing its model.');
          modalTask = true;
          try { await changeSessionModel(activeId, text.replace(/^\/models?\s*/, ''), ui, { info, owner }); }
          finally { modalTask = false; }
          continue;
        }
        if (/^\/effort(?:\s|$)/.test(text)) {
          if (text !== '/effort') throw new Error('Use /effort without arguments.');
          if (children.length && activeId === sessionId) throw new Error('Select an agent chat tab before changing its effort.');
          modalTask = true;
          try { await changeSessionModel(activeId, '@effort', ui, { info, owner }); }
          finally { modalTask = false; }
          continue;
        }
        if (/^\/providers?(?:\s|$)/.test(text)) {
          if (!ui.onProvider) throw new Error('Provider selection is unavailable in this client.');
          if (children.length && activeId === sessionId) throw new Error('Select an agent chat tab before changing its provider.');
          modalTask = true;
          try {
            const selected = await ui.onProvider(activeId, text.replace(/^\/providers?\s*/, ''), { info, owner });
            if (selected && selected.id !== activeId) ui.nextSession = selected;
          } finally { modalTask = false; }
          continue;
        }
        if (text === '/pause' || text === '/cancel') { await selectedApi('POST', 'control', { action: text.slice(1) }, randomUUID()); ui.event('info', { message: 'Stopping the current response…' }); continue; }
        if (text === '/pause all' || text === '/cancel all') { await api('POST', 'control', { action: text.startsWith('/pause') ? 'pause' : 'cancel' }, randomUUID()); continue; }
        if (/^\/(?:validate|debate)(?:\s|$)/.test(text)) {
          if (!ui.onDebate) throw new Error('Use /validate from an attached interactive chat.');
          if (children.length && activeId === sessionId) throw new Error('Select an agent chat tab before validating its result.');
          modalTask = true;
          try {
            const current = await selectedApi('GET');
            if (['queued', 'launching', 'running'].includes(current.execution?.state)) throw new Error('Wait for the current reply to finish, or use /pause, before validating it.');
            await ui.onDebate(activeId, text.replace(/^\/(?:validate|debate)\s*/, ''));
            if (ui.detached) { detached = true; break; }
          } finally {
            modalTask = false;
            if (!detached) {
              // onDebate restores the selected source conversation itself. A
              // preflight failure never left it; replaying its whole history
              // here would bury the error that the outer handler displays.
              if (children.length) { ui.setTabs(sessionId, children, activeId); ui.sessionMode = ownershipLost ? 'VIEW' : 'CONTROL'; }
              else ui.setSession(sessionId, ownershipLost ? 'VIEW' : 'CONTROL');
            }
          }
          continue;
        }
        if (/^\/goal(?:\s|$)/.test(text)) {
          // Keep the watcher from retiring a finished run's input reader while
          // its saved-goal picker owns that reader.
          modalTask = true;
          let command;
          try { command = await resolveInteractiveGoal(text, ui, { sessionId: groupMode(initial.session) ? sessionId : activeId }); }
          finally { modalTask = false; }
          if (command.cancelled) continue;
          const action = command.action, selected = await selectedApi('GET');
          if (action === 'status') {
            if (!selected.session.goal) throw new Error('This session has no goal.');
            ui.event('info', { message: `Goal ${selected.session.goal.status}\n${selected.session.goal.objective}\n${selected.session.goal.tokensUsed || 0} tokens used.` });
            continue;
          }
          if (['pause', 'cancel', 'clear'].includes(action)) {
            await acquireControl({ localMutation: !executionActive(selected.execution) });
            if (executionActive(selected.execution)) {
              if (action === 'clear') throw new Error('Pause or cancel the running goal before clearing it.');
              await selectedApi('POST', 'control', { action }, randomUUID());
            } else {
              const changed = updateIdleGoal(activeId, owner, action); ui.updateSession?.(changed);
              ui.event('info', { message: `Goal ${action === 'clear' ? 'cleared' : action === 'cancel' ? 'cancelled' : 'paused'}.` });
            }
            continue;
          }
          if (action === 'resume' && executionActive(selected.execution)) throw new Error('This goal is already running.');
          const targetId = action !== 'resume' && groupMode(initial.session) ? sessionId : activeId;
          let replacement = {};
          if (action !== 'resume') {
            modalTask = true;
            try { replacement = await confirmGoalReplacement(ui, loadSession(targetId).goal); }
            finally { modalTask = false; }
            if (!replacement.confirmed) continue;
          }
          await acquireControl();
          if (action !== 'resume' && (executionActive(selected.execution) || targetId === sessionId && children.length)) ui.event('info', { message: 'Replacing the current goal. Stopping its run before starting the new objective…' });
          const execution = await runtimeRequest(info, 'POST', `/sessions/${targetId}/input`, { owner, operation: 'goal', options: ui.executionOptions?.(options.executionOptions || {}, { id: targetId }) || options.executionOptions || {}, ...(action === 'resume' ? { resumeGoal: true } : { objective: command.objective, replaceGoalId: replacement.replaceGoalId }) }, randomUUID());
          if (!groupMode(initial.session)) options.executionId = execution.executionId;
          continue;
        }
        const snapshot = await selectedApi('GET'), question = snapshot.questions[0];
        if (text.startsWith('/')) { ui.event('info', { message: 'Unknown command. Use /help.' }); continue; }
        if (question) await selectedApi('POST', 'answer', { questionId: question.id, answer: text }, randomUUID());
        else if (children.length && activeId === sessionId) ui.event('info', { message: 'Choose an agent with /tab before sending a chat message.' });
        else if (snapshot.execution && ['queued', 'launching', 'running'].includes(snapshot.execution.state)) {
          if (snapshot.capabilities.activeSteering) await selectedApi('POST', 'control', { action: 'steer', text }, randomUUID());
          else ui.event('info', { message: 'This backend cannot accept text mid-turn. Use /pause, then send the next message.' });
        } else {
          const execution = await selectedApi('POST', 'execute', { prompt: text, options: ui.executionOptions?.({}, { id: activeId }) || {}, goal: false }, randomUUID());
          if (!children.length) options.executionId = execution.executionId;
        }
      } catch (error) { ui.event('error', { message: error.message }); }
      finally { processingInput = false; }
    }
  })() : null;
  try {
    while (!detached && !ui.nextSession && !ui.coreLifecycleInterrupted) {
      try {
      if (modalTask) { await delay(100); continue; }
      const renderingId = activeId, selectedApi = client(info, renderingId, owner);
      await replay(selectedApi, renderingId, ui, () => activeId === renderingId && !modalTask);
      if (roomApi && renderingId !== roomSessionId) await replayRoom(roomApi, roomSessionId, ui, () => activeId === renderingId && !modalTask);
      const snapshot = await api('GET'), selected = renderingId === sessionId ? snapshot : await selectedApi('GET');
      if (renderingId !== activeId) continue;
      if (modalTask) continue;
      if ((initial.session.mode || 'solo') !== (snapshot.session.mode || 'solo')) {
        Object.assign(initial.session, snapshot.session);
        roomSessionId = snapshot.session.bestiesSessionId || (snapshot.session.mode === 'besties' ? sessionId : null);
        roomApi = roomSessionId ? client(info, roomSessionId, owner) : null;
        if (activeId !== sessionId) { selectTab(sessionId); continue; }
      }
      if (!snapshot.capabilities.chatTabs && children.length) {
        children = []; tabs = [{ id: sessionId, agent: 'Overview' }]; ui.setTabs?.(sessionId, children, sessionId);
        if (activeId !== sessionId) { selectTab(sessionId); continue; }
      }
      ui.updateSession?.(selected);
      if (snapshot.capabilities.chatTabs) {
        if (children.map(child => child.id).join() !== snapshot.children.map(child => child.id).join()) {
          const firstAgents = !children.length && snapshot.children.length;
          children = snapshot.children; tabs = [{ id: sessionId, agent: 'Overview' }, ...children];
          ui.setTabs?.(sessionId, children, activeId); if (!ui.tui) showTabs();
          if (!tabs.some(tab => tab.id === activeId)) { selectTab(children[0]?.id || sessionId); continue; }
          if (firstAgents && ui.interactive && snapshot.session.mode === 'parallel' && activeId === sessionId) { selectTab(children[0].id); continue; }
        }
      }
      // An expired/released lease is unclaimed input, not a takeover. The next
      // explicit message or approval is admitted by Core; polling never claims it.
      if (options.activeControl && !ownershipLost && snapshot.inputOwner && snapshot.inputOwner.owner !== owner) loseControl();
      if (options.allowControlOnInput && (!options.activeControl || ownershipLost) && snapshot.inputOwner?.owner === owner) {
        ownershipLost = false; options.activeControl = true; ui.setSession?.(sessionId, 'CONTROL');
      }
      if (options.activeControl && !ownershipLost) for (const question of selected.questions) {
        if (seenQuestions.has(question.id)) continue; seenQuestions.add(question.id);
        if (inputLoop) { if (question.kind !== 'approval') ui.event('info', { message: `${question.sessionId !== sessionId ? `[${question.sessionId.slice(0, 8)}] ` : ''}${question.question}` }); continue; }
        const answer = ui.interactive ? await ui.ask(`${question.question} `) : '';
        if (!detached && !ownershipLost && answer != null) await api('POST', 'answer', { questionId: question.id, answer }, randomUUID()).catch(error => ui.event('error', { message: error.message }));
      }
      const execution = options.executionId ? snapshot.execution?.id === options.executionId ? snapshot.execution : executionRecord(options.executionId) : snapshot.execution;
      const active = execution && ['queued', 'launching', 'running'].includes(execution.state);
      if (options.executionId && execution && !active && !processingInput) {
        const completedExecutionId = options.executionId;
        await replay(api, sessionId, ui, () => !processingInput && !modalTask && !detached && !ui.nextSession && options.executionId === completedExecutionId);
        // Input may start a nested review or another execution while the final
        // event page is in flight. The older observer must keep it alive.
        if (processingInput || modalTask || detached || ui.nextSession || options.executionId !== completedExecutionId) continue;
        if (!options.follow) return execution.exitCode ?? 1;
        options.executionId = undefined;
        refreshInput = true;
        if (!closeWatchInput()) refreshInput = false;
      }
      if (ownershipLost && options.executionId && !active) return 0;
      if (!options.executionId && !active && !options.follow) return 0;
      if (!ui.interactive && !options.follow && !options.executionId) return 0;
      await delay(100);
      } catch (error) {
        if (error.code === 'SESSION_DELETED') {
          if (modalTask) { await delay(50); continue; }
          if (options.allowControlOnInput) forgetDeletedConversation(ui, initial.session, [sessionId, ...children.map(child => child.id)]);
          else { detached = true; ui.clearHistory?.(); ui.event('info', { message: 'This chat was deleted.' }); }
          break;
        }
        if (!reconnectable(error)) throw error;
        ui.executionConnection?.(false);
        ui.tui?.notice('Reconnecting to Core… Checking execution status.');
        await delay(500);
      }
    }
    if (detached) ui.detached = true;
    return 0;
  } finally { inputStopped = true; if (inputLoop) closeWatchInput(); await inputLoop; process.removeListener('SIGINT', interrupt); ui.input?.removeListener('keypress', keypress); ui.onSelectTab = previousSelectTab; ui.permissionConnection = previousPermissions; ui.onAnswerApproval = previousApproval; }
}
export async function viewSession(session, options, ui) {
  options = { ...options, cwd: session.cwd };
  const info = await ensureRuntime(); ui.setSession?.(session.id, 'VIEW');
  ui.event('info', { message: `Read-only session view. Attach to chat: bzzy --attach ${session.id}` });
  let result;
  try { result = await watch(info, session.id, randomUUID(), ui, { follow: options.follow || ui.interactive, activeControl: false }); }
  catch (error) {
    if (error.code !== 'SESSION_DELETED') throw error;
    ui.clearHistory?.(); ui.event('info', { message: 'This chat was deleted.' }); return 0;
  }
  if (!ui.nextSession) return result;
  const selected = ui.nextSession; ui.nextSession = null;
  return attachSession(selected, options, ui);
}
export async function restoreConversation(session, ui, connectionInfo) {
  const info = connectionInfo || await ensureRuntime(), api = client(info, session.id, randomUUID());
  const snapshot = await api('GET');
  ui.tui?.selectTab(ui.activeTab || ui.sessionId, session.id);
  ui.setSession?.(session.id); ui.clearHistory?.(); ui.cursors?.set(session.id, 0);
  ui.updateSession?.(snapshot); await replay(api, session.id, ui);
}
export async function conversationInput(session, ui, connection) {
  let info = connection?.info;
  const owner = connection?.owner || randomUUID();
  while (!ui.detached) {
    if (ui.coreLifecycleInterrupted) return null;
    if (ui.pendingChatInputs?.length) return ui.pendingChatInputs.shift();
    let waiting = true, active;
    const input = ui.ask('bzzy › ').then(answer => { waiting = false; return answer; });
    // Listen immediately, including during a cold start of the local runtime.
    try { info ||= await ensureRuntime(); }
    catch (error) { ui.reader?.close(); await input; throw error; }
    const api = client(info, session.id, owner);
    while (waiting) {
      try {
      await replay(api, session.id, ui, () => waiting);
      const snapshot = await api('GET');
      if (!waiting) break;
      ui.updateSession?.(snapshot);
      if (snapshot.execution && ['queued', 'launching', 'running'].includes(snapshot.execution.state)) {
        active = snapshot.execution; ui.reader?.close(); break;
      }
      await delay(100);
      } catch (error) {
        if (error.code === 'SESSION_DELETED') {
          ui.reader?.close(); await input;
          forgetDeletedConversation(ui, session);
          return '';
        }
        if (!reconnectable(error)) { ui.reader?.close(); await input; throw error; }
        ui.tui?.notice('Reconnecting to Core…');
        await delay(500);
      }
    }
    const answer = await input;
    if (!active) {
      if (/^\/open-session /.test(answer || '')) {
        const id = answer.slice(14).trim();
        const chosen = (await import('./session-browser.js')).namedTerminalSessions().find(item => item.id === id);
        if (chosen) { ui.nextSession = chosen; return ''; }
        ui.event('error', { message: 'This named session is no longer available.' }); continue;
      }
      return answer;
    }
    const controlling = Boolean(connection) && (await api('GET')).inputOwner?.owner === owner;
    await watch(info, session.id, owner, ui, { executionId: active.id, activeControl: controlling, allowControlOnInput: ui.interactive });
    if (ui.nextSession) return '';
  }
  return null;
}
export async function attachSession(session, options, ui) {
  options = { ...options, cwd: session.cwd, mode: session.mode || 'solo', provider: session.provider, model: session.model, effort: session.selectedEffort };
  const info = await ensureRuntime(), owner = randomUUID(), api = client(info, session.id, owner);
  let result, next;
  try {
    if (!options.restoreAfterUpdate && ui.launchYolo === true) { await api('POST', 'claim', { takeover: true }); initializeLaunchYolo(ui, session.id, owner, { attached: true }); }
    result = await watch(info, session.id, owner, ui, {
      activeControl: false, allowControlOnInput: true,
      follow: ui.interactive || options.follow, restoreInitial: true, executionOptions: options,
    });
    next = ui.nextSession; ui.nextSession = null;
  } catch (error) {
    if (error.code !== 'SESSION_DELETED') throw error;
    forgetDeletedConversation(ui, session);
    next = ui.nextSession; ui.nextSession = null;
  } finally { await api('POST', 'release', {}).catch(() => {}); }
  return next ? attachSession(next, options, ui) : result;
}

export async function controlSession(session, action, options = {}) {
  const info = await ensureRuntime(), owner = randomUUID(), api = client(info, session.id, owner);
  await api('POST', 'claim', { takeover: true });
  try { return await api('POST', 'control', { action }, options.requestId || randomUUID()); }
  finally { await api('POST', 'release', {}).catch(() => {}); }
}
export async function watchRegistry(session, options, ui, kind) {
  const info = await ensureRuntime(), api = client(info, session.id, randomUUID()); let after = 0, stopped = false, modalTask = false, selected;
  ui.setSession(session.id, kind === 'activity' ? 'ACTIVITY VIEW' : 'TRAFFIC VIEW');
  if (ui.tui) ui.tui.panel = kind === 'activity' ? 'activity' : 'http';
  const stop = () => { stopped = true; }; process.on('SIGINT', stop);
  const inputLoop = ui.interactive ? (async () => {
    while (!stopped && !ui.coreLifecycleInterrupted) {
      const input = await ui.ask('bzzy (view) › ');
      if (stopped) break;
      if (input == null || ['/exit', '/quit', '/detach'].includes(input.trim())) { stopped = true; break; }
      if (input.trim() === '/sessions') {
        modalTask = true;
        try { const choice = await chooseSavedSession(ui); if (choice) { selected = choice.session; stopped = true; } }
        catch (error) { ui.event('error', { message: error.message }); }
        finally { modalTask = false; }
      } else {
        modalTask = true;
        try { await ui.settingsCommand?.(input.trim()); } finally { modalTask = false; }
      }
    }
  })().catch(error => { ui.event('error', { message: error.message }); stopped = true; }) : null;
  try {
    do {
      if (ui.coreLifecycleInterrupted) break;
      if (modalTask) { await delay(100); continue; }
      const batch = await api('GET', `events?after=${after}&limit=500`);
      for (const event of batch.events) {
        after = event.seq;
        if (!event.type.startsWith(kind)) continue;
        if (kind === 'activity') ui.event('activity', { ...event.data, message: options.detailed ? `${event.data.summary}\n${event.data.details}\nObservation: ${event.data.observation}\nInference: ${event.data.inference}\nNext check: ${event.data.nextCheck}` : event.data.summary });
        else ui.event(event.type, { ...event.data, message: `${event.data.method || ''} ${event.data.url || ''} ${event.data.status || ''} ${event.data.durationMs != null ? `${event.data.durationMs}ms` : ''}` });
      }
      if (batch.hasMore) continue;
      if (!options.follow && !ui.interactive) break;
      await delay(150);
    } while (!stopped);
  } catch (error) {
    if (error.code !== 'SESSION_DELETED') throw error;
    ui.clearHistory?.(); ui.event('info', { message: 'This chat was deleted.' });
  } finally { stopped = true; ui.reader?.close(); await inputLoop; process.removeListener('SIGINT', stop); }
  return selected ? attachSession(selected, options, ui) : 0;
}
