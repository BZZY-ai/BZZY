import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { root } from './process.js';
import { home, readJson, writeJson, saveSession } from './store.js';

const continuation = fs.readFileSync(path.join(root, 'assets', 'goal-continuation.md'), 'utf8');
export const terminalGoal = goal => goal && goal.status !== 'active';

export function newGoal(objective, tokenBudget) {
  if (!objective?.trim()) throw new Error('A goal needs an objective.');
  return { id: randomUUID(), objective: objective.trim(), status: 'active', tokenBudget: tokenBudget ?? null,
    tokensUsed: 0, turns: 0, noActivityTurns: 0, blockerStreak: 0, lastBlocker: null,
    evidence: [], createdAt: new Date().toISOString() };
}

export function continuationPrompt(goal) {
  const values = { objective: escapeXml(goal.objective), tokens_used: goal.tokensUsed,
    token_budget: goal.tokenBudget ?? 'none', remaining_tokens: goal.tokenBudget == null ? 'unbounded' : Math.max(0, goal.tokenBudget - goal.tokensUsed) };
  return continuation.replace(/\{\{ (\w+) \}\}/g, (_, key) => String(values[key]));
}

export function reportPath(sessionId, nonce) {
  if (!/^[a-f0-9-]{36}$/.test(sessionId) || !/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid goal report handle.');
  return path.join(home(), 'runtime', `${sessionId}-${nonce}.json`);
}

export function validateReport(report) {
  if (!report || !['complete', 'blocked'].includes(report.status)) throw new Error('Status must be complete or blocked.');
  if (!Array.isArray(report.evidence) || !report.evidence.length || report.evidence.some(e => typeof e !== 'string' || !e.trim())) {
    throw new Error('Supply concrete evidence for the completion or blocker audit.');
  }
  if (report.status === 'blocked' && !report.blocker?.trim()) throw new Error('Supply the recurring blocker.');
  return { status: report.status, evidence: report.evidence.map(s => s.trim()), blocker: report.blocker?.trim() };
}

export function applyReport(session, report, activity, tokens) {
  const goal = session.goal;
  if (!goal || goal.status !== 'active') return;
  goal.tokensUsed += Math.max(0, tokens || 0);
  if (report?.status === 'complete') {
    goal.status = 'verifying';
    goal.evidence = report.evidence;
  } else if (report?.status === 'blocked') {
    const blocker = report.blocker.toLowerCase().replace(/\s+/g, ' ').trim();
    goal.blockerStreak = blocker === goal.lastBlocker ? goal.blockerStreak + 1 : 1;
    goal.lastBlocker = blocker;
    goal.evidence = report.evidence;
    if (goal.blockerStreak >= 3) { goal.status = 'blocked'; goal.reason = report.blocker; }
  } else {
    goal.blockerStreak = 0;
    goal.lastBlocker = null;
  }
  goal.noActivityTurns = activity ? 0 : goal.noActivityTurns + 1;
  if (goal.status === 'active' && goal.noActivityTurns >= 3) {
    goal.status = 'blocked';
    goal.reason = 'Three turns produced no tool activity outside goal reporting.';
  }
  if (goal.status === 'active' && goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) goal.status = 'budget_limited';
  saveSession(session);
}

export function readReport(sessionId, nonce) {
  const file = reportPath(sessionId, nonce);
  const report = readJson(file, null);
  fs.rmSync(file, { force: true });
  return report ? validateReport(report) : null;
}

export function writeReport(sessionId, nonce, report) {
  writeJson(reportPath(sessionId, nonce), validateReport(report));
}

function escapeXml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
