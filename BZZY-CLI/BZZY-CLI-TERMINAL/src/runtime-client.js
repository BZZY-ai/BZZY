import { chooseEffort } from './model-controls.js';
import { saveSessionDefaultSelection, savedDefaultMessage } from './session-defaults.js';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runtimeRequest, requireOwner } from './runtime.js';
import { delay } from './delegation.js';
import { loadSession } from './store.js';
import { chooseModel, assertModelIdle } from './models.js';
import { chatHelp } from './terminal-commands.js';
import { chooseSavedSession, promptSessionAlias } from './session-browser.js';
import { exportProject } from './project-bundle.js';
import { shareTerminal, importTerminal, forgetPrivateImportInput } from './share-ui.js';
import { skillThat } from './skill-that.js';
import { checkConnections } from './connection-check.js';
import { enqueueGoalTurn, updateIdleGoal, setSessionModel, setSessionProvider, executionRecord } from '@bzzy/core/engine/session-operations.js';

const groupMode = session => ['parallel', 'besties'].includes(session.mode);
const executionActive = execution => execution && ['queued', 'launching', 'running'].includes(execution.state);

function saveSessionDefault(sessionId, ui) {
  const selected = saveSessionDefaultSelection(loadSession(sessionId));
  ui.event('info', { message: savedDefaultMessage(selected) });
  return selected;
}

function client(info, sessionId, owner) {
  return (method, action = '', body, requestId) => runtimeRequest(info, method, `/sessions/${sessionId}${action ? '/' + action : ''}`, body ? { ...body, owner } : body, requestId);
}
async function replay(api, sessionId, ui, selected = () => true) {
  let cursor = ui.cursors?.get(sessionId) || 0;
  while (true) {
    const batch = await api('GET', `events?after=${cursor}&limit=200`);
    if (!selected()) return;
    for (const event of batch.events) {
      ui.event(event.type, { ...event.data, seq: event.seq, occurredAt: event.createdAt });
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
async function editConversation(sessionId, ui, connection, choose, apply) {
  const info = connection?.info || await ensureRuntime(), owner = connection?.owner || randomUUID(), api = client(info, sessionId, owner);
  if (!connection) await api('POST', 'claim', { takeover: true });
  const heartbeat = !connection ? setInterval(() => api('POST', 'claim', {}).catch(() => ui.reader?.close()), 10000) : null;
  try {
    const current = (await api('GET')).session; assertModelIdle(current);
    const selected = await choose(current);
    if (!selected) return current;
    const session = apply(sessionId, owner, selected, { authorize: () => connection?.authorize?.() });
    ui.updateSession?.(await api('GET'));
    ui.event('info', { message: `${session.provider} · ${session.model || 'provider default'}${session.selectedEffort ? ' · effort ' + session.selectedEffort : ''} · conversation retained · applies to the next message.` });
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
export async function executeManaged(provider, session, options, ui, prompt, flags = {}) {
  ui.setSession?.(session.id);
  const { returnAfterExecution = false, ...executionFlags } = flags;
  if (process.env.BZZY_DIRECT === '1') { const { runSession } = await import('./controller.js'); return runSession(provider, session, options, ui, prompt, executionFlags); }
  const info = await ensureRuntime(), owner = randomUUID(), api = client(info, session.id, owner);
  await api('POST', 'claim', { takeover: true });
  try {
    const result = await api('POST', 'execute', { prompt, options, ...executionFlags }, options.requestId || randomUUID());
    if (options.detach) { ui.event('info', { message: `Running independently.\nView: bzzy --view ${session.id}\nAttach: bzzy --attach ${session.id}` }); return 0; }
    return await watch(info, session.id, owner, ui, groupMode(session) && ui.interactive && !returnAfterExecution ? { activeControl: true, follow: true } : { executionId: result.executionId, activeControl: true });
  } finally { await api('POST', 'release', {}).catch(() => {}); Object.assign(session, loadSession(session.id)); }
}
async function watch(info, sessionId, owner, ui, options = {}) {
  const api = client(info, sessionId, owner); let detached = false, paused = false, ownershipLost = false, renewing = false, inputStopped = false, modalTask = false, processingInput = false;
  const initial = await api('GET'); let children = initial.capabilities.chatTabs ? initial.children : [];
  const roomSessionId = initial.session.bestiesSessionId || (initial.session.mode === 'besties' ? sessionId : null);
  const roomApi = roomSessionId ? client(info, roomSessionId, owner) : null;
  let tabs = [{ id: sessionId, agent: 'Overview' }, ...children], activeId = ui.activeTab && tabs.some(t => t.id === ui.activeTab) ? ui.activeTab
    : ui.interactive && initial.session.mode === 'parallel' && children.length ? children[0].id : sessionId;
  const seenQuestions = new Set();
  if (options.restoreInitial) {
    const selected = activeId === sessionId ? initial : await client(info, activeId, owner)('GET');
    ui.openTerminal?.();
    if (children.length && ui.setTabs) ui.setTabs(sessionId, children, activeId);
    else { ui.tui?.selectTab(ui.activeTab || ui.sessionId, sessionId); ui.setSession?.(sessionId); }
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
    if (!options.activeControl || paused) { detached = true; ui.reader?.close(); return; }
    paused = true; api('POST', 'control', { action: 'pause' }, randomUUID()).catch(error => ui.event('error', { message: error.message }));
  };
  process.on('SIGINT', interrupt);
  const inputLoop = ui.interactive ? (async () => {
    while (!inputStopped && !detached && !ui.nextSession && !ui.coreLifecycleInterrupted) {
      const input = await ui.ask(`bzzy ${children.length ? '(' + (tabs.find(t => t.id === activeId)?.agent || 'Overview') + ')' : '(running)'} › `);
      if (inputStopped) { if (input != null) (ui.pendingChatInputs ||= []).push(input); break; }
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
        if (text === '/update' || /^\/(?:settings|skills|session-action)(?:\s|$)/.test(text)) {
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
          if (!options.activeControl || ownershipLost) throw new Error('Attach with control before sharing or importing from this terminal.');
          modalTask = true;
          try {
            if (/^\/share(?:\s|$)/.test(text)) {
              if (text !== '/share') throw new Error('Use /share without arguments.');
              await shareTerminal(loadSession(sessionId), ui);
            } else await importTerminal(text.replace(/^\/import\s*/, ''), loadSession(sessionId).cwd, ui);
          } finally { modalTask = false; }
          continue;
        }
        if (text.startsWith('/tab ')) { selectTab(text.slice(5).trim()); continue; }
        if (!options.activeControl || ownershipLost) { ui.event('info', { message: 'This is a read-only view. Use --attach to send agent input.' }); continue; }
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
        if (/^\/models?(?:\s|$)/.test(text)) {
          if (children.length && activeId === sessionId) throw new Error('Select an agent chat tab before changing its model.');
          modalTask = true;
          try { await changeSessionModel(activeId, text.replace(/^\/models?\s*/, ''), ui, { info, owner }); }
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
        if (text === '/debate' || text.startsWith('/debate ')) {
          if (!ui.onDebate) throw new Error('Use /debate from an attached interactive chat.');
          if (children.length && activeId === sessionId) throw new Error('Select an agent chat tab before choosing its reply to debate.');
          modalTask = true;
          try {
            const current = await selectedApi('GET');
            if (['queued', 'launching', 'running'].includes(current.execution?.state)) throw new Error('Wait for the current reply to finish, or use /pause, before debating it.');
            await ui.onDebate(activeId, text.slice(7).trim());
            if (ui.detached) { detached = true; break; }
          } finally {
            modalTask = false;
            if (!detached) { ui.setSession(sessionId, ownershipLost ? 'VIEW' : 'CONTROL'); ui.clearHistory(); ui.cursors?.set(activeId, 0); if (children.length) ui.setTabs(sessionId, children, activeId); }
          }
          continue;
        }
        const goalCommand = /^\/goal(?:\s+(.*))?$/s.exec(text);
        if (goalCommand) {
          const action = (goalCommand[1] || 'status').trim(), selected = await selectedApi('GET');
          if (action === 'status') {
            if (!selected.session.goal) throw new Error('This session has no goal.');
            ui.event('info', { message: `Goal ${selected.session.goal.status}\n${selected.session.goal.objective}\n${selected.session.goal.tokensUsed || 0} tokens used.` });
            continue;
          }
          if (['pause', 'cancel', 'clear'].includes(action)) {
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
          if (action !== 'resume' && (executionActive(selected.execution) || targetId === sessionId && children.length)) ui.event('info', { message: 'Replacing the current goal. Stopping its run before starting the new objective…' });
          const execution = await enqueueGoalTurn(targetId, owner, options, action === 'resume' ? { resume: true, info } : { objective: action, info });
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
          const execution = await selectedApi('POST', 'execute', { prompt: text, options: {}, goal: false }, randomUUID());
          if (!children.length) options.executionId = execution.executionId;
        }
      } catch (error) { ui.event('error', { message: error.message }); }
      finally { processingInput = false; }
    }
  })() : null;
  const heartbeat = options.activeControl ? setInterval(async () => {
    if (renewing || ownershipLost || ui.coreLifecycleInterrupted) return; renewing = true;
    try { await api('POST', 'claim', {}); }
    catch (error) { if (!ui.coreLifecycleInterrupted) { ownershipLost = true; ui.event('info', { message: 'Input ownership transferred to another client. This terminal is now a viewer.' }); ui.setSession?.(sessionId, 'VIEW'); } }
    finally { renewing = false; }
  }, 10000) : null;
  try {
    while (!detached && !ui.nextSession && !ui.coreLifecycleInterrupted) {
      if (modalTask) { await delay(100); continue; }
      const renderingId = activeId, selectedApi = client(info, renderingId, owner);
      await replay(selectedApi, renderingId, ui, () => activeId === renderingId && !modalTask);
      if (roomApi && renderingId !== roomSessionId) await replayRoom(roomApi, roomSessionId, ui, () => activeId === renderingId && !modalTask);
      const snapshot = await api('GET'), selected = renderingId === sessionId ? snapshot : await selectedApi('GET');
      if (renderingId !== activeId) continue;
      if (modalTask) continue;
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
      if (options.activeControl && !ownershipLost && snapshot.inputOwner?.owner !== owner) { ownershipLost = true; ui.event('info', { message: 'Input ownership transferred to another client. This terminal is now a viewer.' }); ui.setSession?.(sessionId, 'VIEW'); }
      if (options.activeControl && !ownershipLost) for (const question of selected.questions) {
        if (seenQuestions.has(question.id)) continue; seenQuestions.add(question.id);
        if (inputLoop) { ui.event('info', { message: `${question.sessionId !== sessionId ? `[${question.sessionId.slice(0, 8)}] ` : ''}${question.question}` }); continue; }
        const answer = ui.interactive ? await ui.ask(`${question.question} `) : '';
        if (!detached && !ownershipLost && answer != null) await api('POST', 'answer', { questionId: question.id, answer }, randomUUID()).catch(error => ui.event('error', { message: error.message }));
      }
      const execution = options.executionId ? snapshot.execution?.id === options.executionId ? snapshot.execution : executionRecord(options.executionId) : snapshot.execution;
      const active = execution && ['queued', 'launching', 'running'].includes(execution.state);
      if (options.executionId && execution && !active && !processingInput) { await replay(api, sessionId, ui); return execution.exitCode ?? 1; }
      if (ownershipLost && options.executionId && !active) return 0;
      if (!options.executionId && !active && !options.follow) return 0;
      if (!ui.interactive && !options.follow && !options.executionId) return 0;
      await delay(100);
    }
    if (detached) ui.detached = true;
    return 0;
  } finally { inputStopped = true; if (inputLoop) ui.reader?.close(); await inputLoop; clearInterval(heartbeat); process.removeListener('SIGINT', interrupt); ui.input?.removeListener('keypress', keypress); ui.onSelectTab = previousSelectTab; }
}
export async function viewSession(session, options, ui) {
  options = { ...options, cwd: session.cwd };
  const info = await ensureRuntime(); ui.setSession?.(session.id, 'VIEW');
  ui.event('info', { message: `Read-only session view. Attach to chat: bzzy --attach ${session.id}` });
  const result = await watch(info, session.id, randomUUID(), ui, { follow: options.follow || ui.interactive, activeControl: false });
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
      await replay(api, session.id, ui, () => waiting);
      const snapshot = await api('GET');
      if (!waiting) break;
      ui.updateSession?.(snapshot);
      if (snapshot.execution && ['queued', 'launching', 'running'].includes(snapshot.execution.state)) {
        active = snapshot.execution; ui.reader?.close(); break;
      }
      await delay(100);
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
    let claimed = false, controlling = Boolean(connection);
    if (!connection) {
      try { await api('POST', 'claim', {}); claimed = true; controlling = true; }
      catch { ui.event('info', { message: 'Another terminal owns input. Watching the current reply; use --attach to take control.' }); }
    }
    try { await watch(info, session.id, owner, ui, { executionId: active.id, activeControl: controlling }); }
    finally { if (claimed) await api('POST', 'release', {}).catch(() => {}); }
    if (ui.nextSession) return '';
  }
  return null;
}
export async function attachSession(session, options, ui) {
  options = { ...options, cwd: session.cwd, mode: session.mode || 'solo', provider: session.provider, model: session.model, effort: session.selectedEffort };
  const info = await ensureRuntime(), owner = randomUUID(), api = client(info, session.id, owner);
  try { await api('POST', 'claim', { takeover: !options.restoreAfterUpdate }); }
  catch (error) {
    if (!options.restoreAfterUpdate || error.status !== 409 && error.code !== 'CONFLICT') throw error;
    ui.event('info', { message: 'Updated. Another client owns input; this terminal reopened as a viewer.' });
    return viewSession(session, { ...options, follow: true }, ui);
  }
  let renewing = false, lost = false, redirect;
  const heartbeat = setInterval(async () => {
    if (renewing || lost || ui.coreLifecycleInterrupted) return; renewing = true;
    try { await api('POST', 'claim', {}); } catch { lost = true; ui.reader?.close(); } finally { renewing = false; }
  }, 10000);
  try {
    if (groupMode(session)) {
      await watch(info, session.id, owner, ui, { activeControl: true, follow: ui.interactive || options.follow, restoreInitial: true });
      if (!ui.nextSession) return 0;
      redirect = ui.nextSession; ui.nextSession = null;
    } else await restoreConversation(session, ui, info);
    while (!lost && !redirect && !ui.coreLifecycleInterrupted) {
      await replay(api, session.id, ui);
      const snapshot = await api('GET');
      ui.updateSession?.(snapshot);
      if (snapshot.execution && ['queued', 'launching', 'running'].includes(snapshot.execution.state)) await watch(info, session.id, owner, ui, { executionId: snapshot.execution.id, activeControl: true });
      if (ui.nextSession) { redirect = ui.nextSession; ui.nextSession = null; break; }
      if ((await api('GET')).inputOwner?.owner !== owner) return 0;
      if (!ui.interactive || lost || ui.detached) return 0;
      const input = (await conversationInput(session, ui, { info, owner }))?.trim();
      Object.assign(session, loadSession(session.id));
      if (ui.nextSession) { redirect = ui.nextSession; ui.nextSession = null; break; }
      if (input == null || ['/quit', '/exit', '/detach'].includes(input)) return 0;
      if (!input) continue;
      if (await ui.settingsCommand?.(input)) continue;
      if (input === '/help') { ui.event('info', { message: chatHelp }); continue; }
      if (input === '/sessions') {
        try { const selected = await chooseSavedSession(ui); if (selected) { redirect = selected.session; break; } }
        catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (input === '/doctor') { await checkConnections(ui, { providerId: session.provider, live: true, model: session.model, effort: session.selectedEffort, session }); continue; }
      if ((await api('GET')).inputOwner?.owner !== owner) return 0;
      if (input === '/default') { saveSessionDefault(session.id, ui); continue; }
      if (/^\/skill_that(?:\s|$)/.test(input)) {
        try { await skillThat(session, input.replace(/^\/skill_that\s*/, ''), ui); }
        catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (/^\/export(?:\s|$)/.test(input)) {
        try { await exportProject(session, input.replace(/^\/export\s*/, ''), ui); }
        catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (/^\/(?:share|import)(?:\s|$)/.test(input)) {
        forgetPrivateImportInput(ui, input);
        try {
          if (/^\/share(?:\s|$)/.test(input)) {
            if (input !== '/share') throw new Error('Use /share without arguments.');
            await shareTerminal(session, ui);
          } else await importTerminal(input.replace(/^\/import\s*/, ''), session.cwd, ui);
        } catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (/^\/alias(?:\s|$)/.test(input)) {
        try { Object.assign(session, await promptSessionAlias(session.id, input.replace(/^\/alias\s*/, ''), ui, () => requireOwner(session.id, owner))); }
        catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (/^\/models?(?:\s|$)/.test(input)) {
        try { Object.assign(session, await changeSessionModel(session.id, input.replace(/^\/models?\s*/, ''), ui, { info, owner })); }
        catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (/^\/providers?(?:\s|$)/.test(input)) {
        try {
          const next = await ui.onProvider(session.id, input.replace(/^\/providers?\s*/, ''), { info, owner });
          if (next?.id === session.id) Object.assign(session, next);
          else if (next) { redirect = next; break; }
        } catch (error) { ui.event('error', { message: error.message }); }
        continue;
      }
      if (input === '/debate' || input.startsWith('/debate ')) {
        if (!ui.onDebate) throw new Error('Debate is unavailable in this client.');
        try { await ui.onDebate(session.id, input.slice(7).trim()); }
        catch (error) { ui.event('error', { message: error.message }); }
        if (ui.detached) return 0;
        continue;
      }
      const goalCommand = /^\/goal(?:\s+(.*))?$/s.exec(input), action = goalCommand && (goalCommand[1] || 'status').trim();
      let result;
      try {
        if (goalCommand && ['status', 'pause', 'cancel', 'clear'].includes(action)) {
          if (!session.goal) throw new Error('This session has no goal.');
          if (action === 'status') { ui.event('info', { message: `Goal ${session.goal.status}\n${session.goal.objective}\n${session.goal.tokensUsed || 0} tokens used.` }); continue; }
          const changed = updateIdleGoal(session.id, owner, action);
          ui.updateSession?.(changed); ui.event('info', { message: `Goal ${action === 'clear' ? 'cleared' : action === 'cancel' ? 'cancelled' : 'paused'}.` }); continue;
        }
        const resumeGoal = goalCommand && action === 'resume', newTask = goalCommand && !resumeGoal;
        if (resumeGoal || newTask) {
          result = await enqueueGoalTurn(session.id, owner, options, resumeGoal ? { resume: true, info } : { objective: action, info });
        } else if (input.startsWith('/')) { ui.event('info', { message: 'Attached chat: send text, /alias, /export, /share, /import, /skill_that, /providers, /models, /default, /goal <objective>, /goal status|pause|resume|clear, /debate or /detach.' }); continue; }
        else result = await api('POST', 'execute', { prompt: input, options, goal: false }, randomUUID());
      } catch (error) { ui.event('error', { message: error.message }); continue; }
      await watch(info, session.id, owner, ui, { executionId: result.executionId, activeControl: true });
    }
  } finally { clearInterval(heartbeat); await api('POST', 'release', {}).catch(() => {}); }
  return redirect ? attachSession(redirect, options, ui) : 0;
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
  } finally { stopped = true; ui.reader?.close(); await inputLoop; process.removeListener('SIGINT', stop); }
  return selected ? attachSession(selected, options, ui) : 0;
}
