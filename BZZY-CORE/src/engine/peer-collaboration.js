import { randomUUID } from 'node:crypto';
import { getRecord, putRecord, database, reserveRequest, appendEvent, now, digest } from './database.js';
import { loadSession } from './store.js';
import { readArtifact, inside, fileInfo } from './evidence.js';

function membership(session) {
  const group = session.bestiesSessionId && getRecord('besties', session.bestiesSessionId), parent = group && loadSession(session.bestiesSessionId);
  if (!group || group.goalId !== parent?.goal?.id || !group.peers.some(peer => peer.sessionId === session.id)) throw new Error('Peer collaboration is outside this active besties objective.');
  const index = group.peers.findIndex(peer => peer.sessionId === session.id);
  return { group, parent, other: group.peers[(index + 1) % group.peers.length] };
}
function messages(groupId, after = 0, limit = 50, recipient) {
  return database().prepare(`SELECT data FROM records WHERE kind='peer-message' AND json_extract(data,'$.groupId')=? AND json_extract(data,'$.seq')>?
    ${recipient ? "AND json_extract(data,'$.to')=?" : ''} ORDER BY json_extract(data,'$.seq') LIMIT ?`).all(groupId, after, ...(recipient ? [recipient] : []), limit).map(row => JSON.parse(row.data));
}
function evidenceFresh(id) {
  try {
    const item = getRecord('artifact', id); if (!item) return false;
    readArtifact(id, 0, 1);
    return !item.source || fileInfo(inside(item.sourceWorkspace, item.source)).sha256 === item.sourceSha256;
  } catch { return false; }
}
export function sendPeerMessage(session, input) {
  const { group, parent, other } = membership(session), to = input.to || other.sessionId, evidence = input.evidence || [];
  if (to === session.id || !group.peers.some(peer => peer.sessionId === to) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000 || !Array.isArray(evidence) || evidence.length > 16) throw new Error('Send one bounded message to another bestie, with at most 16 evidence IDs.');
  for (const id of evidence) if (getRecord('artifact', id)?.sessionId !== session.id || !evidenceFresh(id)) throw new Error('Shared evidence must be current immutable evidence recorded by this peer.');
  return reserveRequest(`peer-message:${parent.goal.id}:${session.id}`, input.requestId || digest({ to, text: input.text, evidence }), { to, text: input.text, evidence }, db => {
    const message = { id: randomUUID(), groupId: parent.id, goalId: group.goalId, from: session.id, to, text: input.text.trim(), evidence, createdAt: now() };
    const event = appendEvent(parent.id, 'peer.message', message, db); message.seq = event.seq;
    putRecord('peer-message', message.id, message, db);
    appendEvent(to, 'peer.message', message, db); appendEvent(session.id, 'peer.sent', message, db);
    return message;
  });
}
export function peerInbox(session, { after, limit = 20 } = {}) {
  const { parent } = membership(session);
  if (!Number.isSafeInteger(after ?? 0) || (after ?? 0) < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Peer inbox needs a nonnegative cursor and limit 1–50.');
  const previous = getRecord('peer-cursor', session.id)?.after || 0;
  const cursor = after ?? previous, items = messages(parent.id, cursor, limit, session.id);
  const nextCursor = items.at(-1)?.seq || cursor;
  putRecord('peer-cursor', session.id, { after: Math.max(previous, nextCursor), updatedAt: now() });
  return { items, nextCursor, hasMore: items.length === limit };
}
export function peerArtifactAllowed(session, id) {
  if (!session.bestiesSessionId) return false;
  const { parent } = membership(session);
  return Boolean(database().prepare(`SELECT 1 FROM records WHERE kind='peer-message' AND json_extract(data,'$.groupId')=? AND json_extract(data,'$.to')=?
    AND EXISTS (SELECT 1 FROM json_each(json_extract(records.data,'$.evidence')) WHERE value=?) LIMIT 1`).get(parent.id, session.id, id));
}
export function reviewPeerEvidence(session, input) {
  const { group, parent } = membership(session), message = getRecord('peer-message', input.messageId);
  if (!message || message.groupId !== parent.id || message.to !== session.id || message.from === session.id || !group.peers.some(peer => peer.sessionId === message.from) || !message.evidence.length) throw new Error('Review an evidence-bearing message sent to you by another peer.');
  if (!['supported', 'inconclusive', 'disputed'].includes(input.assessment) || !input.rationale?.trim() || input.rationale.length > 4000 || !Array.isArray(input.evidence) || !input.evidence.length || input.evidence.some(id => !message.evidence.includes(id))) throw new Error('Peer review needs assessment, rationale and the message evidence IDs inspected.');
  for (const id of input.evidence) {
    const inspected = database().prepare(`SELECT 1 FROM records WHERE kind='artifact-read' AND json_extract(data,'$.sessionId')=? AND json_extract(data,'$.artifactId')=? LIMIT 1`).get(session.id, id);
    if (!inspected || !evidenceFresh(id)) throw new Error('Open current peer evidence with read_artifact before reviewing it.');
  }
  const review = { id: randomUUID(), groupId: parent.id, goalId: parent.goal.id, reviewer: session.id, peerSessionId: message.from,
    messageId: message.id, assessment: input.assessment, rationale: input.rationale, evidence: input.evidence, createdAt: now(), provenance: 'peer-judgment' };
  putRecord('peer-review', `${session.id}:${message.id}`, review); appendEvent(parent.id, 'peer.review', review); appendEvent(message.from, 'peer.review', review);
  const feedback = sendPeerMessage(session, { requestId: `review-${digest({ messageId: message.id, assessment: input.assessment, rationale: input.rationale })}`,
    to: message.from, text: `Review of ${message.id}: ${input.assessment}. ${input.rationale.slice(0, 3500)}`, evidence: [] });
  return { ...review, feedbackMessageId: feedback.id };
}
export function peerCollaborationState(session, { verifyEvidence = true } = {}) {
  const groupId = session.bestiesSessionId || (session.mode === 'besties' ? session.id : null), group = groupId && getRecord('besties', groupId);
  if (!group || group.goalId !== loadSession(groupId)?.goal?.id) return null;
  const latestClaims = group.peers.map(peer => database().prepare(`SELECT data FROM records WHERE kind='peer-message' AND json_extract(data,'$.groupId')=? AND json_extract(data,'$.from')=?
    AND json_array_length(json_extract(data,'$.evidence'))>0 ORDER BY json_extract(data,'$.seq') DESC LIMIT 1`).get(groupId, peer.sessionId)).filter(Boolean).map(row => JSON.parse(row.data));
  const reviews = latestClaims.map(message => getRecord('peer-review', `${message.to}:${message.id}`)).filter(Boolean);
  const supported = latestClaims.length === group.peers.length && latestClaims.every(message => {
    const review = reviews.find(item => item.messageId === message.id);
    return review?.assessment === 'supported' && message.evidence.every(id => review.evidence.includes(id) && (!verifyEvidence || evidenceFresh(id)));
  });
  const activity = database().prepare(`SELECT json_extract(data,'$.to') AS sessionId, MAX(json_extract(data,'$.seq')) AS after FROM records
    WHERE kind='peer-message' AND json_extract(data,'$.groupId')=? GROUP BY json_extract(data,'$.to')`).all(groupId);
  return { groupId, goalId: group.goalId, self: session.bestiesSessionId ? session.id : null, peers: group.peers, latestClaims, reviews, supported, activity,
    unresolved: latestClaims.length < group.peers.length ? 'All peers must share decisive evidence.' : supported ? null : 'Mutual evidence review is missing, disputed, inconclusive or stale.',
    inbox: session.bestiesSessionId ? messages(groupId, getRecord('peer-cursor', session.id)?.after || 0, 12, session.id) : [] };
}
