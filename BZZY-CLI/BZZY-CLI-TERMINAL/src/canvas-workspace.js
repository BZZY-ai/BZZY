import { randomUUID } from 'node:crypto';
import { openCanvas, insertCanvasModel, linkCanvasModels, unlinkCanvasModels, changeCanvasModel, moveCanvasModel, removeCanvasModel, canvasBindings, canvasEventActors,
  prepareCanvasReview, finishCanvasReviews } from '@bzzy/core/engine/canvas.js';
import { createChatSession, selectedProvider } from '@bzzy/core/engine/host-commands.js';
import { loadSession, setSessionAlias } from './store.js';
import { getProvider, ensureApiKey } from './providers.js';
import { ensureRuntime, runtimeRequest } from './runtime.js';
import { chooseUnifiedModel, chooseEffort } from './model-controls.js';
import { chooseSavedSession } from './session-browser.js';
import { confirmGoalReplacement } from './goal-controls.js';
import { saveSessionDefaultSelection, savedDefaultMessage } from './session-defaults.js';
import { chatHelp } from './terminal-commands.js';
import { clean } from './terminal-format.js';
import { shareTerminal, importTerminal, forgetPrivateImportInput } from './share-ui.js';
import { exportProject } from './project-bundle.js';
import { skillThat } from './skill-that.js';
import { checkConnections } from './connection-check.js';
import { isStalledGoal } from '@bzzy/core/engine/goal-state.js';

const active = snapshot => ['queued', 'launching', 'running'].includes(snapshot?.execution?.state);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = () => randomUUID();

// A frontend observer and input adapter. Every action that can execute a model,
// answer a question or change permissions goes through Core's canonical input
// admission. Closing this view neither stops nor replays background work.
export async function canvasWorkspace(options, ui, initial, launch, { connect = ensureRuntime, request = runtimeRequest } = {}) {
  const info = await connect(), owner = id();
  const view = { canvas: null, focus: null, alias: '', bindings: new Map(), snapshots: new Map(), bubbles: new Map(), exchanges: new Map(), drawer: false, offline: false };
  const cursors = new Map(), seenQuestions = new Set(); let stopped = false, polling = false, currentChat = null, generation = 0, historyTask = null;
  const previousApproval = ui.onAnswerApproval, previousPermissions = ui.permissionConnection;
  ui.canvasView = view; ui.openTerminal(); const tui = ui.tui;
  tui.cwd = initial?.cwd || options.cwd;
  const api = (sessionId, method = 'GET', action = '', body, requestId) => request(info, method, `/sessions/${sessionId}${action ? '/' + action : ''}`, body, requestId);
  async function input(sessionId, body, requestId = id()) {
    if (view.offline) throw new Error('Core is offline. Wait for an authorized Core response before changing this chat.');
    try { return await api(sessionId, 'POST', 'input', { ...body, owner }, requestId); }
    finally { await api(sessionId, 'POST', 'release', { owner }).catch(() => {}); }
  }
  async function owned(sessionId, operation) {
    await api(sessionId, 'POST', 'claim', { owner, takeover: true });
    try { return operation(); }
    finally { await api(sessionId, 'POST', 'release', { owner }).catch(() => {}); }
  }
  const focused = () => view.canvas?.nodes.find(node => node.id === view.focus);
  const binding = () => view.bindings.get(view.focus);
  const group = () => view.canvas?.groups.find(item => item.members.includes(view.focus));
  function replaceCanvas(canvas) { view.canvas = canvas; view.bindings = canvasBindings(canvas); view.alias = loadSession(canvas.id).alias || ''; }
  async function open(session) {
    generation++; view.drawer = false; view.historyThread = null; view.linkFrom = null; view.moveNode = null; view.goalClick = null; view.bubbles.clear(); view.exchanges.clear(); view.snapshots.clear();
    replaceCanvas(openCanvas(session.id)); view.focus = view.canvas.nodes[0]?.id || null;
    ui.canvasRootId = view.canvas.id;
    tui.selectTab(ui.activeTab || ui.sessionId, session.id); ui.setSession(session.id); ui.updateSession(session); tui.panel = 'chat'; currentChat = null;
    await poll(); tui.schedule();
  }
  async function create() {
    const session = createChatSession(selectedProvider(options), { cwd: options.cwd, modelSelectionRequired: true });
    await open(session);
  }
  async function history(sessionId) {
    if (historyTask) await historyTask;
    if (!sessionId) { ui.clearHistory(); currentChat = null; return; }
    if (currentChat === sessionId) return;
    const token = generation;
    const task = (async () => {
    const draftId = ui.activeTab || ui.sessionId;
    tui.selectTab(draftId, sessionId); ui.setSession(sessionId); ui.clearHistory();
    currentChat = sessionId;
    let after = 0, more = true;
    while (more && !stopped && currentChat === sessionId) {
      const batch = await api(sessionId, 'GET', `events?after=${after}&limit=200`);
      if (generation !== token || stopped || currentChat !== sessionId) return;
      for (const event of batch.events) { ui.event(event.type, { ...event.data, seq: event.seq, occurredAt: event.createdAt }); after = event.seq; }
      more = batch.hasMore;
    }
    ui.cursors.set(sessionId, after);
    })();
    historyTask = task;
    try { await task; }
    catch (error) { if (currentChat === sessionId) currentChat = null; throw error; }
    finally { if (historyTask === task) historyTask = null; }
  }
  async function observeEvents(sessionId, token) {
    const previous = cursors.get(sessionId), batch = await api(sessionId, 'GET', `events?after=${previous || 0}&limit=200`);
    if (generation !== token || stopped) return;
    let after = previous || 0;
    for (const event of batch.events) {
      after = event.seq;
      // Historical replay fills the transcript only. It cannot trigger bubbles,
      // sound, packets, celebrations, inference or goal resumption.
      if (previous !== undefined && Date.now() - Date.parse(event.createdAt) < 8000) {
        const nodes = canvasEventActors(view.canvas, sessionId, event, view.bindings);
        const text = event.type === 'text' ? event.data.text : ['peer.message', 'debate.message', 'assignment.created', 'assignment.finished', 'assignment.reviewed'].includes(event.type)
          ? event.data.message || event.data.text || event.data.contract?.objective || event.data.objective || event.data.report?.summary || event.data.summary : null;
        if (typeof text === 'string' && text.trim()) for (const [nodeId, value] of nodes) {
          view.bubbles.set(nodeId, { text: clean(text).slice(0, 160), at: Date.now() });
          if (value.groupId && event.type !== 'text') view.exchanges.set(value.groupId, { at: Date.now(), reverse: /finished|reviewed/.test(event.type) });
        }
        if (/^(assignment\.|peer\.|debate\.message)/.test(event.type)) for (const [nodeId, value] of view.bindings) if (value.controlId === sessionId && value.groupId) {
          view.exchanges.set(value.groupId, { at: Date.now(), reverse: /finished|reviewed/.test(event.type) });
        }
      }
    }
    cursors.set(sessionId, after);
    // Drain at most one bounded batch per tick; loading history cannot monopolize
    // input or animate old events after an offline interval.
  }
  async function poll() {
    if (polling || stopped || !view.canvas || ui.coreLifecycleInterrupted) return;
    polling = true; const token = generation;
    try {
      replaceCanvas(openCanvas(view.canvas.id));
      const ids = new Set([...view.bindings.values()].flatMap(value => [value.sessionId, value.controlId]).filter(Boolean));
      if (!ids.size) ids.add(view.canvas.id);
      for (const sessionId of ids) {
        const snapshot = await api(sessionId);
        if (stopped || generation !== token) return;
        view.snapshots.set(sessionId, snapshot); await observeEvents(sessionId, token);
      }
      view.offline = false;
      finishCanvasReviews(view.canvas.id);
      const selected = binding(), snapshot = view.historyThread ? await api(view.historyThread) : view.snapshots.get(selected?.sessionId || selected?.controlId || view.canvas.id);
      if (snapshot) {
        if (!view.drawer && ui.sessionId !== snapshot.session.id) {
          tui.selectTab(ui.activeTab || ui.sessionId, snapshot.session.id); ui.setSession(snapshot.session.id); currentChat = null;
        }
        if (view.drawer) {
          await history(view.historyThread || selected?.sessionId || selected?.controlId);
          // Follow only new events after the complete drawer replay.
          const sessionId = currentChat, after = ui.cursors.get(sessionId) || 0;
          if (sessionId) {
            const batch = await api(sessionId, 'GET', `events?after=${after}&limit=200`);
            if (generation !== token || stopped) return;
            for (const event of batch.events) ui.event(event.type, { ...event.data, seq: event.seq, occurredAt: event.createdAt });
            ui.cursors.set(sessionId, batch.events.at(-1)?.seq || after);
          }
          for (const question of snapshot.questions || []) if (!seenQuestions.has(question.id)) {
            seenQuestions.add(question.id); ui.event('question', question);
            if (question.kind !== 'approval') ui.event('info', { message: question.question });
          }
        }
        ui.updateSession(snapshot);
      }
      tui.schedule();
    } catch (error) {
      if (generation === token && !stopped) { view.offline = true; tui.notice(error.code === 'SESSION_DELETED' ? 'This chat was deleted. Open another chat.' : 'Core offline · reconnecting. Saved work is retained.', true); tui.schedule(); }
    } finally { polling = false; }
  }
  async function pauseNodes(nodeIds) {
    const canvas = view.canvas, ids = new Set();
    for (const nodeId of nodeIds) {
      const node = canvas.nodes.find(node => node.id === nodeId), bound = view.bindings.get(nodeId);
      if (node?.sessionId) ids.add(node.sessionId);
      if (bound?.controlId) ids.add(bound.controlId);
    }
    for (const sessionId of ids) await input(sessionId, { operation: 'control', action: 'pause' });
    // A pause request is not evidence that child processes have stopped.
    for (let tries = 0; tries < 100; tries++) {
      const snapshots = await Promise.all([...ids].map(sessionId => api(sessionId)));
      if (snapshots.every(snapshot => !active(snapshot) && snapshot.session.executionState === 'paused')) return;
      // A reply can complete while its stop request is being admitted. Once its
      // runner is inactive, finish this same explicit pause intent durably;
      // a final completion save must not strand the mode switch in "stopping".
      for (const snapshot of snapshots) if (!active(snapshot) && snapshot.session.executionState !== 'paused') {
        await input(snapshot.session.id, { operation: 'control', action: 'pause' });
      }
      await sleep(100);
    }
    throw new Error('Work is still stopping. Keep it paused and try again after the workers stop.');
  }
  async function model(insert = false, effortOnly = false) {
    const node = focused(), current = node?.sessionId ? loadSession(node.sessionId) : { ...node?.selection, cwd: view.canvas?.cwd || options.cwd };
    if (!insert && group()) throw new Error('Pause and unlink this group before changing its models.');
    const picker = { anchor: insert ? undefined : view.anchor, scope: 'canvas' };
    const selection = effortOnly ? { provider: current.provider, ...await chooseEffort(current, ui, picker) }
      : await chooseUnifiedModel(current || { cwd: options.cwd }, ui, { ...picker, title: insert ? 'Insert BZZY · model and effort' : 'Character · model and effort' });
    if (effortOnly && !selection.effort) return;
    if (!selection) return;
    const provider = getProvider(selection.provider);
    if (provider.auth === 'api-key') await ensureApiKey(provider, ui);
    if (!view.canvas) await create();
    if (insert) { replaceCanvas(insertCanvasModel(view.canvas.id, view.canvas.revision, selection, id())); view.focus = view.canvas.nodes.at(-1).id; }
    else {
      await pauseNodes([node.id]);
      replaceCanvas(await owned(node.sessionId, () => changeCanvasModel(view.canvas.id, view.canvas.revision, node.id, selection, owner, id())));
    }
  }
  async function menu(nodeId, titleOnly = false) {
    if (nodeId) view.focus = nodeId;
    const node = focused(), choices = node && !titleOnly ? [
      ['chat', 'Open chat / evidence'], ['history', 'Work history…'], ['goal', 'Set goal…'], ['pause', 'Pause work'], ['resume', 'Resume paused goal'],
      ['model', 'Change model and effort…'], ['link', 'Link to another BZZY…'], ...(group() ? [['unlink', 'Pause and unlink group']] : []),
      ...(group()?.mode === 'debate' ? [['review', 'Review achieved goal + evidence']] : []), ['default', 'Save this configuration as default'],
      ['insert', 'Insert another BZZY…'], ['place', 'Move character…'], ['remove', 'Pause and remove character · keep history'], ['home', 'Workspace menu…'],
    ] : [...(view.canvas ? [['insert', 'Insert BZZY…'], ['rename', 'Rename chat…']] : []), ['new', 'New chat'], ['open', 'Open chat…'], ['settings', 'Settings'], ['quit', 'Close CLI · keep work running']];
    const choice = await ui.chooseOne(node && !titleOnly ? (node.selection.model || 'BZZY') + ' · ' + (node.selection.effort || 'default') : view.alias || 'Workspace',
      choices.map(([value, label]) => ({ value, label })), { presentation: 'context', anchor: view.anchor });
    if (choice) await action(choice);
  }
  async function action(command, argument = '') {
    if (command === 'quit') { stopped = true; return; }
    if (command === 'home') { await menu(null, true); return; }
    if (command === 'new') { await create(); return; }
    if (command === 'open') { const saved = await chooseSavedSession(ui, { excludeId: view.canvas?.id }); if (saved) await open(saved.session); return; }
    if (command === 'settings') { ui.openSettings(); return; }
    if (view.offline && !['chat', 'back'].includes(command)) throw new Error('Core is offline. Controls will unlock after Core confirms reconnection.');
    if (command === 'insert') { await model(true); return; }
    if (!view.canvas) return;
    if (command === 'rename') {
      const alias = (await ui.ask('Chat name · Esc cancels'))?.trim();
      if (alias) { setSessionAlias(view.canvas.id, alias); view.alias = alias; } return;
    }
    if (command === 'back') { view.drawer = false; view.historyThread = null; view.linkFrom = null; view.moveNode = null; ui.sessionMode = 'CONTROL'; tui.panel = 'chat'; return; }
    if (command === 'menu') { await menu(argument || null); return; }
    if (['model', 'effort', 'edit-goal'].includes(command) && argument && view.canvas.nodes.some(node => node.id === argument)) view.focus = argument;
    const node = focused(); if (!node) return;
    const bound = binding(), target = bound?.controlId || node.sessionId;
    if (bound?.stale && !['unlink', 'chat'].includes(command)) throw new Error('The mode changed outside this canvas. Pause and unlink this group before configuring it again.');
    if (command === 'chat') { view.drawer = true; view.historyThread = null; ui.sessionMode = 'CONTROL'; await history(bound?.sessionId || target); tui.notice('Esc returns to the canvas. Work continues in Core.'); return; }
    if (command === 'history') {
      const sessions = [...new Set([node.sessionId, ...(node.threads || []), ...(view.snapshots.get(target)?.children?.map(child => child.id) || [])].filter(Boolean))];
      const chosen = await ui.chooseOne('Recorded work · opening never resumes it', sessions.map(sessionId => { const session = loadSession(sessionId); return { value: sessionId, label: `${session.model || 'default'} · ${session.goal?.status || session.executionState} · ${sessionId.slice(0, 8)}` }; }));
      if (chosen) { view.drawer = true; await history(chosen); view.historyThread = chosen; ui.sessionMode = 'VIEW'; } return;
    }
    if (command === 'pause') { await pauseNodes(group()?.members || [node.id]); return; }
    if (command === 'remove') {
      if (group()) throw new Error('Pause and unlink this group before removing a character.');
      await pauseNodes([node.id]);
      replaceCanvas(removeCanvasModel(view.canvas.id, view.canvas.revision, node.id, id())); view.focus = view.canvas.nodes[0]?.id || null; return;
    }
    if (command === 'resume') {
      const snapshot = await api(target), goal = snapshot.session.goal;
      if (!goal || goal.status === 'complete') throw new Error('Set a new goal, or choose Debate to review an achieved goal.');
      await input(target, { operation: 'goal', resumeGoal: true, ...(goal.status === 'paused' || isStalledGoal(goal) ? { resumeGoalId: goal.id } : {}), ...(goal.status === 'paused' ? { resumeGoalStatus: 'paused' } : {}), options: ui.executionOptions(options, snapshot.session) }); return;
    }
    if (command === 'goal' || command === 'edit-goal') {
      if (group()?.mode === 'debate' && loadSession(target).goal?.status === 'complete') {
        if (command === 'edit-goal') throw new Error('This Debate reviews an achieved goal. Pause and unlink to set a different goal, or choose Review achieved goal + evidence.');
        await action('review'); return;
      }
      let objective;
      if (command === 'edit-goal') {
        view.editingGoal = node.id; view.linkFrom = null; view.moveNode = null;
        try { objective = (await ui.ask('Goal · what should this BZZY achieve?', { initialValue: loadSession(target).goal?.objective || '' }))?.trim(); }
        finally { view.editingGoal = null; }
      } else objective = (await ui.ask('Goal · what should this BZZY achieve?'))?.trim();
      if (!objective) return;
      const session = loadSession(target), replacement = await confirmGoalReplacement(ui, session.goal); if (!replacement.confirmed) return;
      await input(target, { operation: 'goal', objective, replaceGoalId: replacement.replaceGoalId, options: ui.executionOptions(options, session) }); return;
    }
    if (command === 'model' || command === 'effort') { await model(false, command === 'effort'); return; }
    if (command === 'place') { view.drawer = false; view.moveNode = node.id; return; }
    if (command === 'move') {
      const [nodeId, ...coordinates] = argument.split(' ');
      replaceCanvas(moveCanvasModel(view.canvas.id, view.canvas.revision, nodeId, coordinates.map(Number), id())); view.moveNode = null; return;
    }
    if (command === 'default') { const saved = saveSessionDefaultSelection(loadSession(target)); tui.notice(savedDefaultMessage(saved)); return; }
    if (command === 'link') { view.drawer = false; view.linkFrom = node.id; return; }
    if (command === 'connect') {
      const from = view.linkFrom, to = argument; view.linkFrom = null;
      if (!from || from === to) return;
      const mode = await ui.chooseOne('Link · affected work will pause', [
        { value: 'delegate', label: 'Delegate · source is BRAIN → target is HANDS' },
        { value: 'debate', label: 'Debate · challenge the goal and evidence' },
        { value: 'besties', label: 'Besties · exchange evidence and peer reviews' },
        { value: 'parallel', label: 'Parallel · independent approaches to one goal' },
      ], { presentation: 'context' }); if (!mode) return;
      const source = view.canvas.nodes.find(node => node.id === from), members = view.canvas.groups.find(group => group.members.includes(from))?.members || [from];
      await pauseNodes([...members, to]);
      replaceCanvas(await owned(source.sessionId, () => linkCanvasModels(view.canvas.id, view.canvas.revision, from, to, mode, owner, id())));
      tui.notice('Linked · work remains paused. Set a goal, resume explicitly, or review an achieved goal.'); return;
    }
    if (command === 'unlink') {
      const linked = group(); if (!linked) return;
      const lead = view.canvas.nodes.find(node => node.id === linked.lead);
      await pauseNodes(linked.members);
      replaceCanvas(await owned(lead.sessionId, () => unlinkCanvasModels(view.canvas.id, view.canvas.revision, node.id, owner, id())));
      tui.notice('Unlinked · conversations retained · work stays paused.'); return;
    }
    if (command === 'review') {
      replaceCanvas(prepareCanvasReview(view.canvas.id, view.canvas.revision, node.id, id()));
      const reviewId = group().reviewSessionId, session = loadSession(reviewId);
      await input(reviewId, { operation: 'execute', prompt: session.goal.objective, goal: true, preparedGoalId: session.goal.id,
        options: ui.executionOptions({ ...options, mode: 'debate', debateAgents: session.debateAgents, rounds: 5, artifact: group().reviewArtifact }, session) }); return;
    }
  }
  view.onMouse = (button, x, y, release) => {
    if (release || button & 32 || button & 64) return true;
    const hit = tui.hitTargets.findLast(hit => hit.row === y && x >= hit.left && x <= hit.right);
    view.anchor = { left: x, row: y };
    if ((button & 3) === 2) {
      view.goalClick = null;
      if (['canvas-node', 'canvas-model', 'canvas-effort'].includes(hit?.type)) { view.focus = hit.id; tui.localCommand('/canvas menu ' + hit.id); } else tui.localCommand('/canvas home');
    }
    else if ((button & 3) === 0) {
      if (hit?.type === 'canvas-goal') {
        const previous = view.goalClick, now = Date.now();
        view.goalClick = { id: hit.id, at: now, x, y };
        if (previous?.id === hit.id && previous.y === y && Math.abs(previous.x - x) <= 3 && now - previous.at < 450) {
          view.goalClick = null; tui.localCommand('/canvas edit-goal ' + hit.id);
        }
      } else if (hit?.type === 'canvas-open') { view.goalClick = null; tui.localCommand('/canvas open'); }
      else if (hit?.type === 'canvas-title' && view.canvas) { view.goalClick = null; tui.localCommand('/canvas rename'); }
      else if (view.moveNode) {
        const { width, top, available, cardWidth, cardHeight } = tui.canvasGeometry;
        const px = Math.max(0, Math.min(1, (x - cardWidth / 2) / Math.max(1, width - cardWidth))), py = Math.max(0, Math.min(1, (y - top - 3) / Math.max(1, available - cardHeight)));
        tui.localCommand(`/canvas move ${view.moveNode} ${px} ${py}`);
      } else if (['canvas-node', 'canvas-model', 'canvas-effort'].includes(hit?.type)) {
        view.goalClick = null;
        view.focus = hit.id;
        if (view.linkFrom) tui.localCommand('/canvas connect ' + hit.id);
        else if (hit.type !== 'canvas-node') tui.localCommand('/canvas ' + (hit.type === 'canvas-effort' ? 'effort ' : 'model ') + hit.id);
      } else view.goalClick = null;
    }
    tui.schedule(); return true;
  };
  view.onKey = key => {
    if (key.ctrl && ['c', 'd'].includes(key.name)) { tui.localCommand('/canvas quit'); return true; }
    if (key.name === 'tab' || ['left', 'right', 'up', 'down'].includes(key.name)) {
      const nodes = view.canvas?.nodes || [], index = nodes.findIndex(node => node.id === view.focus), direction = key.shift || ['left', 'up'].includes(key.name) ? -1 : 1;
      view.focus = nodes[(index + direction + nodes.length) % nodes.length]?.id; tui.schedule(); return true;
    }
    if (key.name === 'f10' || key.name === 'return') { tui.localCommand('/canvas ' + (key.name === 'return' && view.focus ? view.linkFrom ? 'connect ' + view.focus : 'chat' : view.focus ? 'menu ' + view.focus : 'home')); return true; }
    if (key.name === 'escape') { view.linkFrom = null; view.moveNode = null; tui.schedule(); return true; }
    if (!key.ctrl && !key.meta && ['n', 'o', 'i'].includes(key.name)) { tui.localCommand('/canvas ' + ({ n: 'new', o: 'open', i: 'insert' }[key.name])); return true; }
    return !key.ctrl;
  };
  ui.onAnswerApproval = (question, answer) => {
    if (view.historyThread) throw new Error('Work history is read-only. Esc returns to the canvas.');
    return input(question.sessionId || binding()?.sessionId || binding()?.controlId, { operation: 'answer', questionId: question.id, answer });
  };
  ui.permissionConnection = undefined;
  let interval;
  try {
    if (initial) await open(initial);
    else if (options.provider || options.model || options.launchDefault || options.mode) await open(createChatSession(selectedProvider(options), options));
    else tui.schedule();
    if (launch && initial) await input(initial.id, { operation: 'execute', prompt: launch.prompt, ...launch.flags,
      ...(launch.flags?.goal ? { preparedGoalId: initial.goal.id } : {}), options: ui.executionOptions(options, initial) }, options.requestId || id());
    interval = setInterval(() => { void poll(); }, 400);
    while (!stopped && !ui.detached && !ui.coreLifecycleInterrupted) {
      const text = await ui.ask('bzzy › '); if (text == null) break;
      try {
        if (/^\/canvas(?:\s|$)/.test(text)) { const [command, ...rest] = text.slice(8).trim().split(' '); await action(command || 'home', rest.join(' ')); }
        else if (await ui.settingsCommand(text)) { /* Existing private settings and QR flow. */ }
        else if (text === '/quit' || text === '/exit') break;
        else if (text === '/help') ui.event('info', { message: chatHelp + '\nEsc returns to the canvas. F10 opens the character menu.' });
        else if (text === '/new') await create();
        else if (text === '/sessions') await action('open');
        else if (text === '/pause' || text === '/goal pause') await action('pause');
        else if (text === '/goal resume') await action('resume');
        else if (text === '/goal') await action('goal');
        else if (text === '/providers' || text === '/models' || text === '/models @effort') await action('model');
        else if (text === '/default') await action('default');
        else if (text === '/solo' || text === '/singular') await action('unlink');
        else if (text === '/delegate' || text === '/parallel' || text === '/besties') await action('link');
        else if (text === '/debate') await action(group()?.mode === 'debate' ? 'review' : 'link');
        else if (text === '/cancel' || text === '/goal cancel') await input(binding()?.controlId || focused()?.sessionId, { operation: 'control', action: 'cancel' });
        else if (/^\/export(?:\s|$)/.test(text)) await exportProject(loadSession(binding()?.controlId || focused()?.sessionId || view.canvas.id), text.replace(/^\/export\s*/, ''), ui);
        else if (text === '/share') await shareTerminal(loadSession(view.canvas.id), ui);
        else if (/^\/import(?:\s|$)/.test(text)) { forgetPrivateImportInput(ui, text); await importTerminal(text.replace(/^\/import\s*/, ''), view.canvas?.cwd || options.cwd, ui); }
        else if (/^\/skill_that(?:\s|$)/.test(text)) await skillThat(loadSession(binding()?.controlId || focused()?.sessionId), text.replace(/^\/skill_that\s*/, ''), ui);
        else if (text === '/doctor') { const session = loadSession(binding()?.controlId || focused()?.sessionId); await checkConnections(ui, { providerId: session.provider, live: true, model: session.model, effort: session.selectedEffort, session }); }
        else if (/^\/open-session /.test(text)) await open(loadSession(text.slice(14).trim()));
        else if (/^\/alias /.test(text)) { setSessionAlias(view.canvas.id, text.slice(7).trim()); view.alias = loadSession(view.canvas.id).alias; }
        else if (text.trim()) {
          if (view.historyThread) throw new Error('Work history is read-only. Esc returns to the canvas.');
          const target = binding()?.sessionId || binding()?.controlId;
          if (!target) throw new Error('Insert a model first.');
          const snapshot = await api(target), question = snapshot.questions[0];
          if (text.startsWith('/goal ')) {
            const controlId = binding()?.controlId || target, session = loadSession(controlId), replacement = await confirmGoalReplacement(ui, session.goal);
            if (replacement.confirmed) await input(controlId, { operation: 'goal', objective: text.slice(6).trim(), replaceGoalId: replacement.replaceGoalId, options: ui.executionOptions(options, session) });
          } else if (text.startsWith('/')) throw new Error('Use the character menu for model links and goal controls. /help lists chat commands.');
          else if (question) await input(target, { operation: 'answer', questionId: question.id, answer: text });
          else if (active(snapshot)) {
            if (!snapshot.capabilities.activeSteering) throw new Error('Pause this character before sending a new message.');
            await input(target, { operation: 'control', action: 'steer', text });
          } else if (binding()?.groupId && binding().sessionId !== binding().controlId) throw new Error('This is an assigned worker thread. Set or resume the group goal from the character menu.');
          else await input(target, { operation: 'execute', prompt: text, options: ui.executionOptions(options, snapshot.session) });
        }
      } catch (error) { tui.notice(error.message, true); if (view.drawer) ui.event('error', { message: error.message }); }
      await poll(); tui.schedule();
    }
    return 0;
  } finally {
    stopped = true; clearInterval(interval); ui.onAnswerApproval = previousApproval; ui.permissionConnection = previousPermissions;
    if (ui.coreLifecycleInterrupted && view.canvas) ui.setSession(view.canvas.id);
    // Keep the final canvas mounted while Settings closes or the CLI reloads;
    // clearing it here briefly exposed the other frontend before terminal exit.
    if (ui.coreLifecycleInterrupted) { view.offline = true; view.drawer = false; }
  }
}
