import { getRecord, putRecord, now } from './database.js';
import { sessionMemoryEligible } from './session-memory.js';
import { advanceConversationSource } from './conversation-source.js';
import { queueSessionCompaction } from './session-compactor.js';
import { knowledgeAccess, refreshKnowledgeHistory } from './knowledge-index.js';

// Called by the execution owner, independently of whether its native goal ends.
// Only deterministic derived work runs here; the compactor owns paid admission.
export function maintainSessionHistory(session) {
  if (!sessionMemoryEligible(session)) return null;
  const saved = getRecord('session', session.id);
  if (!saved || getRecord('session-deletion', session.id) || ['paused', 'cancelled'].includes(saved.executionState)) return null;
  const source = advanceConversationSource(saved);
  if (source.deferred) return { deferred: true, reason: 'awaiting_finalized_native_messages' };
  try {
    const result = queueSessionCompaction(saved, { throughSeq: source.sealedThroughSeq, maxParts: 32 });
    const knowledge = refreshKnowledgeHistory(saved, knowledgeAccess(saved), { limit: 64, sessionOnly: true });
    const state = { version: 1, sessionId: saved.id, goalId: saved.goal?.id || null, scannedThroughSeq: source.scanSeq,
      sealedThroughSeq: source.sealedThroughSeq, indexedThroughSeq: result.indexed.indexedThroughSeq || 0,
      indexingRemaining: Boolean(source.remaining || result.indexed.indexingRemaining || knowledge.remaining),
      pendingMessages: source.pendingMessages, status: 'indexed', updatedAt: now() };
    putRecord('core.history.maintenance', saved.id, state); return state;
  } catch (error) {
    // Derived failures cannot turn a successful mutation into a model retry.
    const state = { version: 1, sessionId: saved.id, status: 'deferred', reason: /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'HISTORY_INDEX_UNAVAILABLE', updatedAt: now() };
    putRecord('core.history.maintenance', saved.id, state); return state;
  }
}
