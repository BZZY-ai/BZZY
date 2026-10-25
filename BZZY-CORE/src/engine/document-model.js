import fs from 'node:fs';
import path from 'node:path';
import { home, readJson } from './files.js';
import { createSession, loadSession, saveSession, sessionDeleted } from './store.js';
import { getProvider, selectionFromSession } from './providers.js';
import { CodexEngine } from './engines/codex.js';
import { ClaudeEngine } from './engines/claude.js';
import { learningWorkingDirectory } from './learning-backend.js';
import { backendStartupFailure } from './backend-startup.js';

const fail = (code, message) => Object.assign(new Error(message), { code });
const stopped = () => readJson(path.join(home(), 'runtime', 'operator-stop.json'), null)?.stopped === true;
const boundedText = (value, maximum, label) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) {
    throw fail('INVALID_DOCUMENT_TASK', `Invalid ${label}.`);
  }
  return value;
};

// Authentication stays with the official backend. This runner deliberately uses
// the verified learning permission profile, with no tools and an empty cwd; a
// prompt asking a normal coding agent not to execute tools is insufficient.
export async function runRestrictedDocumentModel({ source, selection, prompt, instructions, signal, budget = {}, task, Engine: override }) {
  if (signal?.aborted) throw signal.reason || fail('DOCUMENT_CANCELLED', 'Creation cancelled.');
  const saved = loadSession(typeof source === 'string' ? source : source?.id);
  if (!saved || sessionDeleted(saved.id) || saved.role === 'learning-review') throw fail('DOCUMENT_SCOPE', 'The source session is unavailable.');
  const scope = ['cwd', 'projectRoot', 'agentNamespace'];
  if (typeof source === 'object' && scope.some(key => (source[key] ?? null) !== (saved[key] ?? null))) throw fail('DOCUMENT_SCOPE', 'The source session changed.');
  if (stopped()) throw fail('DOCUMENT_CANCELLED', 'BZZY Core is stopped.');
  prompt = boundedText(prompt, 128 * 1024, 'document input');
  instructions = boundedText(instructions, 16 * 1024, 'document instructions');
  if (task !== undefined && (!task || typeof task !== 'object' || Array.isArray(task) || Object.keys(task).some(key => !['kind', 'id'].includes(key)) ||
      typeof task.kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(task.kind) || typeof task.id !== 'string' || !/^[a-f0-9-]{1,80}$/.test(task.id))) {
    throw fail('INVALID_DOCUMENT_TASK', 'Invalid host document task identity.');
  }
  const tokenBudget = budget.tokenBudget ?? 12000, runtimeSeconds = budget.runtimeSeconds ?? 90;
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 200000 || !Number.isFinite(runtimeSeconds) || runtimeSeconds <= 0 || runtimeSeconds > 120) {
    throw fail('INVALID_DOCUMENT_TASK', 'Invalid document generation budget.');
  }
  const chosen = selectionFromSession(selection ? { provider: selection.provider, model: selection.model,
    selectedEffort: selection.effort, modelCapabilities: selection.capabilities } : saved);
  const provider = getProvider(chosen.provider), controller = new AbortController();
  const draft = createSession(provider, home(), chosen.model);
  draft.cwd = learningWorkingDirectory(draft.id);
  Object.assign(draft, { role: 'learning-review', purpose: 'document', selectedEffort: chosen.effort,
    modelCapabilities: chosen.capabilities, backendHomes: saved.backendHomes,
    documentSourceSessionId: saved.id, ...(task ? { documentTaskKind: task.kind, documentTaskId: task.id } : {}), executionState: 'running' });
  saveSession(draft);
  let text = '', engine, closing, deadline, monitor;
  const close = () => closing ||= Promise.resolve().then(() => engine?.close());
  const abort = reason => {
    if (controller.signal.aborted) return;
    controller.abort(reason || fail('DOCUMENT_CANCELLED', 'Creation cancelled.'));
    Promise.resolve().then(() => engine?.interrupt('document_cancelled')).catch(() => {});
    close().catch(() => {});
  };
  const externalAbort = () => abort(signal.reason);
  const ui = { interactive: false, newline() {}, async approve() { return false; }, async ask() { return null; }, event(type, data) {
    if (type !== 'text' || controller.signal.aborted) return;
    text += data.text || '';
    if (Buffer.byteLength(text) > 32768) abort(fail('DOCUMENT_BUDGET', 'Document output limit reached.'));
  } };
  try {
    const Engine = override || (provider.backend === 'claude' ? ClaudeEngine : CodexEngine);
    engine = new Engine(provider, draft, { learningReview: true, documentOnly: true, documentTaskInstructions: instructions,
      yolo: false, tokenBudget, policy: { mode: 'read-only', network: 'disabled', writablePaths: [] }, maxTurns: 1 }, ui);
    signal?.addEventListener('abort', externalAbort, { once: true });
    if (signal?.aborted) externalAbort();
    deadline = setTimeout(() => abort(fail('DOCUMENT_BUDGET', 'Document generation time limit reached.')), runtimeSeconds * 1000);
    monitor = setInterval(() => {
      const current = loadSession(saved.id);
      if (stopped() || !current || sessionDeleted(saved.id) || scope.some(key => (current[key] ?? null) !== (saved[key] ?? null))) {
        abort(fail('DOCUMENT_CANCELLED', 'The source session or Core state changed.'));
      }
    }, 100);
    const aborted = new Promise((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return engine.run(prompt, { goal: false });
    }), aborted]);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (engine.interrupted || result?.interrupted) throw fail('DOCUMENT_CANCELLED', 'Document generation was interrupted.');
    const tokens = draft.usage?.tokens || result?.tokens || 0;
    const usageAvailable = Number.isSafeInteger(tokens) && tokens >= 0 && (draft.usage?.available === true || Number.isSafeInteger(result?.tokens));
    if (tokens > tokenBudget) throw Object.assign(fail('DOCUMENT_BUDGET', 'Document generation token limit reached.'),
      usageAvailable ? { tokens, usageAvailable: true } : {});
    return { text, tokens, usageAvailable, resolvedModel: draft.resolvedModel || chosen.model || null };
  } catch (error) {
    const failure = backendStartupFailure(error);
    if (failure) draft.backendFailure = failure;
    throw error;
  } finally {
    clearTimeout(deadline); clearInterval(monitor);
    signal?.removeEventListener('abort', externalAbort);
    try { await close(); } finally {
      try {
        draft.executionState = 'idle'; draft.backendProcess = null;
        if (!sessionDeleted(draft.id)) saveSession(draft);
      } finally {
        fs.rmSync(path.join(home(), 'runtime', 'learning', draft.id), { recursive: true, force: true });
        fs.rmSync(path.join(home(), 'runtime', 'agent-backends', draft.id), { recursive: true, force: true });
        fs.rmSync(path.join(home(), 'runtime', `${draft.id}-models.json`), { force: true });
      }
    }
  }
}
