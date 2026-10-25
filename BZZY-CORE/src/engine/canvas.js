import { randomUUID } from 'node:crypto';
import { getRecord, putRecord, transaction, digest, listRecords, database, now } from './database.js';
import { createChatSession } from './host-commands.js';
import { loadSession, saveSession, sessionPath, lockFile } from './store.js';
import { getProvider, selectionFromSession } from './providers.js';
import { assertSessionIdle } from './models.js';
import { requireOwner } from './runtime.js';
import { setSessionMode, setSessionProvider } from './session-operations.js';
import { prepareChatDebate, finishChatDebate } from './chat-debate.js';
import { isStalledGoal } from './goal-state.js';

// Local owner composition. Characters are terminal model slots, never persistent
// Agents. Executions, permissions, inference and outcomes remain in the existing
// Core engines. Reading or editing a canvas cannot enqueue model work.
const kind = 'terminal.canvas';
const selected = session => ({ provider: session.provider, model: session.model, effort: session.selectedEffort || 'default', capabilities: session.modelCapabilities });
const slot = (session, index = 0, selection = selected(session)) => ({ id: randomUUID(), sessionId: index ? null : session.id,
  selection, appearance: Math.floor(Math.random() * 12), position: null });
const conflict = message => { throw Object.assign(new Error(message), { code: 'CONFLICT' }); };
const modeAgents = session => session.mode === 'delegate' && session.executor ? [selected(session), session.executor]
  : session[{ parallel: 'parallelAgents', besties: 'besties', debate: 'debateAgents' }[session.mode]];

export function readCanvas(sessionId) {
  const session = loadSession(sessionId);
  if (session.parentSessionId || session.purpose === 'agent') throw new Error('Open a root terminal chat as a canvas.');
  const saved = getRecord(kind, sessionId);
  if (saved) return saved;
  const agents = modeAgents(session);
  const nodes = session.modelSelectionRequired ? [] : (agents || [selected(session)]).map((selection, i) => slot(session, i, selection));
  return { version: 1, id: sessionId, sessionId, cwd: session.cwd, revision: 0, nodes,
    groups: nodes.length > 1 ? [{ id: randomUUID(), mode: session.mode, lead: nodes[0].id, members: nodes.map(node => node.id) }] : [] };
}

// Store the first generated identities once. Reopening never changes the cast.
export function openCanvas(sessionId) {
  return transaction(() => {
    const canvas = getRecord(kind, sessionId) || readCanvas(sessionId); let changed = false;
    // A fully approved phone or minimal terminal can configure a previously
    // solo slot. Project its actual Core selections without starting work,
    // claiming input, or reusing another character's independent conversation.
    for (const node of [...canvas.nodes]) {
      if (!node.sessionId || groupFor(canvas, node.id)) continue;
      const session = loadSession(node.sessionId), agents = modeAgents(session);
      if (!Array.isArray(agents) || agents.length < 2) continue;
      node.selection = selected(session);
      const members = [node.id];
      for (const [index, selection] of agents.slice(1).entries()) { const peer = slot(session, index + 1, selection); canvas.nodes.push(peer); members.push(peer.id); }
      canvas.groups.push({ id: randomUUID(), mode: session.mode, lead: node.id, members }); changed = true;
    }
    if (changed) { canvas.revision++; canvas.updatedAt = now(); }
    return changed || !getRecord(kind, sessionId) ? putRecord(kind, sessionId, canvas) : canvas;
  });
}

function edit(sessionId, revision, requestId, input, apply) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(requestId)) throw new Error('Supply a stable canvas request ID.');
  const unlock = lockFile(sessionPath(sessionId) + '.canvas.lock');
  const key = digest({ sessionId, requestId }), fingerprint = digest({ revision, ...input });
  try {
    const previous = getRecord('canvas-request', key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) conflict('This canvas request ID was used for different content.');
      if (previous.result) return previous.result;
      throw new Error('The previous canvas edit did not finish. Inspect the saved chat before trying another edit.');
    }
    const canvas = openCanvas(sessionId);
    if (canvas.revision !== revision) conflict('The canvas changed. Reopen the menu and try again.');
    putRecord('canvas-request', key, { sessionId, fingerprint, state: 'applying' });
    apply(canvas); canvas.revision++; canvas.updatedAt = now();
    putRecord(kind, sessionId, canvas);
    putRecord('canvas-request', key, { sessionId, fingerprint, state: 'applied', result: canvas });
    return canvas;
  } finally { unlock(); }
}
const nodeFor = (canvas, id) => { const node = canvas.nodes.find(node => node.id === id); if (!node) throw new Error('This character no longer exists.'); return node; };
const groupFor = (canvas, id) => canvas.groups.find(group => group.members.includes(id));

export function insertCanvasModel(sessionId, revision, selection, requestId) {
  // Validate through the same Core provider selection contract as other clients.
  const normalized = selectionFromSession({ provider: selection?.provider, model: selection?.model, selectedEffort: selection?.effort, modelCapabilities: selection?.capabilities });
  return edit(sessionId, revision, requestId, { action: 'insert', selection: normalized }, canvas => {
    if (canvas.nodes.length >= 8) throw new Error('This canvas supports up to eight characters. Open another chat for more.');
    const root = loadSession(sessionId);
    let session;
    if (!canvas.nodes.length && root.modelSelectionRequired) {
      assertSessionIdle(root);
      Object.assign(root, { provider: normalized.provider, backend: getProvider(normalized.provider).backend, model: normalized.model,
        selectedEffort: normalized.effort, modelCapabilities: normalized.capabilities, modelSelectionRequired: false });
      saveSession(root); session = root;
    } else {
      session = createChatSession(getProvider(normalized.provider), { cwd: canvas.cwd, model: normalized.model, effort: normalized.effort,
        launchDefault: normalized });
      session.canvasParentId = sessionId; saveSession(session);
    }
    const node = slot(session); node.selection = normalized;
    // Avoid identical silhouettes next to each other without tying appearance to
    // a provider or model. The saved identity survives model changes.
    while (canvas.nodes.some(other => other.appearance === node.appearance)) node.appearance = (node.appearance + 1) % 12;
    canvas.nodes.push(node);
  });
}

function paused(canvas, ids) {
  for (const id of ids) {
    const node = nodeFor(canvas, id);
    if (!node.sessionId) continue;
    const session = loadSession(node.sessionId); assertSessionIdle(session);
    if (session.executionState !== 'paused') conflict('Pause the affected characters before changing models or links.');
  }
}

export function linkCanvasModels(sessionId, revision, from, to, mode, owner, requestId) {
  if (!['delegate', 'debate', 'parallel', 'besties'].includes(mode)) throw new Error('Choose a supported link.');
  return edit(sessionId, revision, requestId, { action: 'link', from, to, mode }, canvas => {
    if (from === to) throw new Error('Link two different characters.');
    const a = nodeFor(canvas, from), b = nodeFor(canvas, to), existing = groupFor(canvas, from);
    if (groupFor(canvas, to)) conflict('Unlink that character before adding it to another group.');
    if (existing && (existing.mode !== mode || existing.lead !== from || mode === 'delegate' || existing.members.length >= 3)) conflict('Unlink this group first. Delegate supports two characters; other groups support two or three.');
    const members = [...(existing?.members || [from]), to]; paused(canvas, members);
    const lead = loadSession(a.sessionId); requireOwner(lead.id, owner);
    const selections = members.map(id => { const node = nodeFor(canvas, id); return node.sessionId ? selected(loadSession(node.sessionId)) : node.selection; });
    setSessionMode(lead.id, owner, { mode, expectedUpdatedAt: lead.updatedAt,
      selection: mode === 'delegate' ? { supervisor: selections[0], executor: selections[1] } : { agents: selections } });
    if (existing) existing.members = members;
    else canvas.groups.push({ id: randomUUID(), mode, lead: from, members });
  });
}

export function unlinkCanvasModels(sessionId, revision, nodeId, owner, requestId) {
  return edit(sessionId, revision, requestId, { action: 'unlink', nodeId }, canvas => {
    const group = groupFor(canvas, nodeId); if (!group) return;
    paused(canvas, group.members);
    if (group.reviewSessionId) { const review = loadSession(group.reviewSessionId); assertSessionIdle(review); }
    const bindings = canvasBindings(canvas);
    const lead = loadSession(nodeFor(canvas, group.lead).sessionId); requireOwner(lead.id, owner);
    setSessionMode(lead.id, owner, { mode: 'solo', expectedUpdatedAt: lead.updatedAt });
    for (const id of group.members) {
      const node = nodeFor(canvas, id), thread = bindings.get(id)?.sessionId;
      if (thread && thread !== node.sessionId) node.threads = [...new Set([...(node.threads || []), thread])];
      if (!node.sessionId) {
        const session = createChatSession(getProvider(node.selection.provider), { cwd: canvas.cwd, model: node.selection.model, effort: node.selection.effort, launchDefault: node.selection });
        session.canvasParentId = sessionId; session.executionState = 'paused'; saveSession(session); node.sessionId = session.id;
      }
    }
    canvas.groups = canvas.groups.filter(item => item.id !== group.id);
  });
}

export function changeCanvasModel(sessionId, revision, nodeId, selection, owner, requestId) {
  return edit(sessionId, revision, requestId, { action: 'model', nodeId, selection }, canvas => {
    if (groupFor(canvas, nodeId)) conflict('Unlink this paused group before changing a character’s model.');
    paused(canvas, [nodeId]); const node = nodeFor(canvas, nodeId), session = loadSession(node.sessionId);
    const normalized = selectionFromSession({ provider: selection.provider, model: selection.model, selectedEffort: selection.effort, modelCapabilities: selection.capabilities });
    const changed = setSessionProvider(session.id, owner, session.provider, normalized.provider, normalized);
    changed.executionState = 'paused'; saveSession(changed); node.selection = normalized;
  });
}

export function moveCanvasModel(sessionId, revision, nodeId, position, requestId) {
  if (!Array.isArray(position) || position.length !== 2 || position.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('Choose a position within this canvas.');
  return edit(sessionId, revision, requestId, { action: 'move', nodeId, position }, canvas => { nodeFor(canvas, nodeId).position = position; });
}

export function removeCanvasModel(sessionId, revision, nodeId, requestId) {
  return edit(sessionId, revision, requestId, { action: 'remove', nodeId }, canvas => {
    if (groupFor(canvas, nodeId)) conflict('Pause and unlink the group before removing a character.');
    paused(canvas, [nodeId]);
    const node = nodeFor(canvas, nodeId);
    canvas.archivedNodes = [...(canvas.archivedNodes || []), { ...node, removedAt: now() }];
    canvas.nodes = canvas.nodes.filter(node => node.id !== nodeId);
  });
}

export function canvasBindings(canvas) {
  const bindings = new Map(canvas.nodes.map(node => [node.id, { sessionId: node.sessionId, controlId: node.sessionId, role: 'SOLO' }]));
  for (const group of canvas.groups) {
    const lead = nodeFor(canvas, group.lead), root = loadSession(group.reviewSessionId || lead.sessionId);
    // An external mode change makes a saved link stale, never executable as the
    // former mode. The frontend displays this and requires an explicit repair.
    const stale = root.mode !== group.mode;
    let children = listRecords('session', { parentSessionId: root.id }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (group.mode === 'delegate') {
      const jobs = listRecords('assignment', { parentSessionId: root.id }).filter(item => item.goalId === (root.goal?.id || null));
      const running = job => ['starting', 'running'].includes(getRecord('round', `${job.id}:${job.currentRound}`)?.state);
      jobs.sort((a, b) => Number(running(b)) - Number(running(a)) || String(b.createdAt || '').localeCompare(a.createdAt || ''));
      const assignment = jobs[0];
      children = assignment?.workerSessionId ? [loadSession(assignment.workerSessionId)] : [];
    } else if (group.mode === 'debate') {
      // Resolve stable assignment slots, including duplicate selections. Sorting
      // workers by model name would silently put the wrong conversation on a
      // character when phases change or two participants use the same model.
      children = group.members.map((_, index) => {
        const names = [index === 0 ? `debate-main-${root.id}` : `debate-${root.id}-${index - 1}`, `investigate-${root.id}-${index}`];
        for (const name of names) {
          const row = database().prepare('SELECT response FROM requests WHERE scope=? AND id=?').get(`assignment:${root.id}:${root.goal?.id || 'chat'}`, name);
          const jobId = row?.response && JSON.parse(row.response).id, job = jobId && getRecord('assignment', jobId);
          if (job?.workerSessionId) return loadSession(job.workerSessionId);
        }
        return null;
      });
    } else {
      const record = getRecord(group.mode, root.id);
      const current = record && record.goalId === root.goal?.id && (record.modeRevision || 0) === (root.modeRevision || 0);
      const ids = current ? record?.peers?.map(peer => peer.sessionId) || record?.children?.map(child => typeof child === 'string' ? child : child.sessionId || child.id) : [];
      children = (ids || []).map(id => loadSession(id));
    }
    const selections = group.mode === 'delegate' ? [selected(root), root.executor] : root[{ parallel: 'parallelAgents', besties: 'besties', debate: 'debateAgents' }[group.mode]];
    group.members.forEach((id, index) => {
      const session = group.mode === 'delegate' ? index ? children[0] : root : children[index] || (index === 0 ? root : null);
      const job = session?.assignmentId && getRecord('assignment', session.assignmentId);
      bindings.set(id, { sessionId: session?.id, controlId: root.id, groupId: group.id, stale, groupGoalStatus: root.goal?.status, groupStalled: isStalledGoal(root.goal),
        role: group.mode === 'delegate' ? index ? 'HANDS' : 'BRAIN' : group.mode.toUpperCase(), slot: index,
        selection: session ? { ...selected(session), model: session.resolvedModel || session.model } : selections?.[index],
        ...(job ? { assignment: { outcome: job.review?.outcome, state: getRecord('round', `${job.id}:${job.currentRound}`)?.state } } : {}) });
    });
  }
  return bindings;
}

export function canvasEventActors(canvas, sessionId, event, bindings = canvasBindings(canvas)) {
  let speaker = sessionId;
  if (event.type === 'peer.message' || event.type === 'peer.sent') speaker = event.data.from;
  else if (event.type === 'peer.review') speaker = event.data.reviewer;
  else if (event.type === 'debate.message' || /^assignment\.(finished|reviewed|failed)/.test(event.type)) {
    const job = getRecord('assignment', event.data.assignmentId || event.data.id);
    if (job?.parentSessionId === sessionId) speaker = job.workerSessionId;
  }
  const actors = [...bindings].filter(([, value]) => value.sessionId === speaker);
  if (actors.length) return actors;
  if (/^assignment\.(created|started|followup)/.test(event.type)) return [...bindings].filter(([, value]) => value.controlId === sessionId && value.slot === 0);
  return [];
}

export function prepareCanvasReview(sessionId, revision, nodeId, requestId) {
  return edit(sessionId, revision, requestId, { action: 'review', nodeId }, canvas => {
    const group = groupFor(canvas, nodeId);
    if (group?.mode !== 'debate') throw new Error('Link two or three characters for Validate first.');
    const source = loadSession(nodeFor(canvas, group.lead).sessionId);
    if (source.goal?.status !== 'complete') throw new Error('Validate review needs an achieved goal and its recorded evidence.');
    assertSessionIdle(source);
    if (group.reviewSessionId) {
      const review = loadSession(group.reviewSessionId); assertSessionIdle(review);
      if (!group.reviewFinished) throw new Error('Resume or finish the existing review before starting another.');
    }
    const agents = group.members.map(id => nodeFor(canvas, id).selection);
    const prepared = prepareChatDebate(source, '', agents.slice(1).map(agent => agent.provider), { debateAgents: agents });
    group.reviewSessionId = prepared.session.id; group.reviewArtifact = prepared.options.artifact; group.reviewFinished = false;
  });
}

export function finishCanvasReviews(sessionId) {
  const pending = getRecord(kind, sessionId)?.groups.some(group => group.reviewSessionId && !group.reviewFinished
    && ['complete', 'awaiting_review', 'cancelled', 'failed'].includes(loadSession(group.reviewSessionId).goal?.status));
  if (!pending) return;
  let unlock;
  try { unlock = lockFile(sessionPath(sessionId) + '.canvas.lock', 'This canvas is being updated.'); }
  catch (error) { if (error.message === 'This canvas is being updated.') return; throw error; }
  try { return transaction(() => {
  const canvas = getRecord(kind, sessionId); if (!canvas) return;
  for (const group of canvas.groups) {
    if (!group.reviewSessionId || group.reviewFinished) continue;
    const session = loadSession(group.reviewSessionId);
    if (['complete', 'awaiting_review', 'cancelled', 'failed'].includes(session.goal?.status)) {
      const result = finishChatDebate(nodeFor(canvas, group.lead).sessionId, session.id);
      if (result.pending) continue;
      group.reviewFinished = true;
      canvas.revision++; putRecord(kind, sessionId, canvas);
    }
  }
  }); } finally { unlock(); }
}
