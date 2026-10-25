import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { goalIndicator, goalValidationIndicator } from '../src/goal-indicator.js';
import { palette, createTerminalTheme } from '../src/terminal-theme.js';
import { clean, cellWidth } from '../src/terminal-format.js';

const goal = { id: randomUUID(), objective: 'Confirm the original goal with its evidence.', status: 'complete' };
const projection = (state, extra = {}) => ({ state, sourceGoalId: goal.id, reviewSessionId: randomUUID(), revision: 2,
  sourceRevision: 'a'.repeat(64), resultRevision: 'b'.repeat(64), evidenceFingerprint: 'c'.repeat(64), updatedAt: new Date().toISOString(), ...extra });
function terminal(t, minimal = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-validation-ui-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 80, rows: 24 }); output.resume();
  const ui = new UI({ input, output, error: output, minimal, pet: false }), session = { id: randomUUID(), alias: 'Validated goal', cwd: directory,
    provider: 'codex', model: 'Active chat model', selectedEffort: 'high', goal };
  ui.setSession(session.id); ui.tui.theme = createTerminalTheme(output, { FORCE_COLOR: '3' });
  ui.tui.value = 'keep this draft'; ui.tui.cursor = 4;
  t.after(() => { ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { ui, tui: ui.tui, output, session };
}

test('only current complete goals with checked validation metadata receive the green secondary badge', () => {
  assert.equal(goalIndicator(goal).tone, palette.goalSuccess);
  assert.equal(goalValidationIndicator(goal, projection('validated')).tone, palette.goalSuccess);
  assert.equal(goalValidationIndicator(goal, projection('validated')).label, 'Validated ✓');
  for (const invalid of [null, projection('validated', { sourceGoalId: randomUUID() }), projection('validated', { revision: 0 })])
    assert.equal(goalValidationIndicator(goal, invalid), null);
  for (const status of ['active', 'paused', 'awaiting_review']) assert.equal(goalValidationIndicator({ ...goal, status }, projection('validated')), null);
  assert.equal(goalValidationIndicator(goal, projection('validated', { evidenceFingerprint: '' })).tone, palette.warning);
  assert.equal(goalValidationIndicator(goal, projection('validated', { reviewSessionId: '' })).label, 'Validation inconclusive');
  const tones = { not_validated: palette.danger, inconclusive: palette.warning, pending: palette.goalActive, paused: palette.muted, cancelled: palette.muted, stale: palette.warning };
  for (const [state, tone] of Object.entries(tones)) assert.equal(goalValidationIndicator(goal, projection(state)).tone, tone);
  assert.equal(goalValidationIndicator(goal, projection('inconclusive', { reason: 'host_checks_incomplete' })).reason, 'Required evidence or verification checks are incomplete.');
});

test('achieved and validation badges survive restoration, fit compact layouts and preserve model/draft', t => {
  for (const minimal of [false, true]) {
    const { ui, tui, output, session } = terminal(t, minimal);
    for (const [state, expected] of [['validated', 'Validated ✓'], ['not_validated', 'Not validated ✗'], ['inconclusive', 'Validation inconclusive'],
      ['pending', 'Validating'], ['paused', 'Validation paused'], ['cancelled', 'Validation cancelled'], ['stale', 'Validation stale']]) {
      const current = projection(state, { revision: 2 + ['validated', 'not_validated', 'inconclusive', 'pending', 'paused', 'cancelled', 'stale'].indexOf(state),
        reason: state === 'inconclusive' ? 'host_checks_incomplete' : '' });
      ui.updateSession({ session: { ...session, goalValidation: current } });
      for (const columns of [40, 80, 140]) {
        output.columns = columns; tui.render(); const frame = tui.lastFrame.map(clean).join('\n');
        assert.match(frame, /Goal achieved ✓/); assert.ok(frame.includes(expected), `${state} at ${columns} columns`);
        assert.ok(tui.lastFrame.every(line => cellWidth(line) < columns));
      }
      if (state === 'inconclusive') assert.match(tui.lastFrame.map(clean).join('\n'), /Required evidence or verification checks are incomplete/);
    }
    assert.equal(tui.model, 'Active chat model'); assert.equal(tui.value, 'keep this draft'); assert.equal(tui.cursor, 4);
  }
});

test('consensus prose and child-review summaries cannot promote validation or replace the original achieved state', t => {
  const { ui, tui, session } = terminal(t);
  ui.updateSession({ ...session, goalValidation: projection('not_validated', { reason: 'original_goal_unsupported' }) });
  ui.event('debate.result', { debateId: randomUUID(), status: 'complete', goalSatisfaction: 'supported', message: 'Validated ✓. Every reviewer agrees.' });
  ui.event('summary', { debateId: randomUUID(), status: 'awaiting_review', message: 'The validation finished.' });
  ui.event('summary', { status: 'complete', message: 'Validated ✓', goalValidation: projection('validated') });
  const badges = tui.goalBadgeLayout(79);
  assert.equal(tui.goal.status, 'complete'); assert.match(clean(badges.line), /Goal achieved ✓.*Not validated ✗/);
  assert.equal(goalValidationIndicator(tui.goal, tui.goalValidation).tone, palette.danger);
});

test('new goals hide old validation and retired goals cannot return through delayed snapshots or events', t => {
  const { ui, tui, session } = terminal(t); const previous = projection('validated');
  ui.updateSession({ ...session, goalValidation: previous }); assert.equal(tui.goalValidation.state, 'validated');
  ui.event('message.user', { kind: 'goal', text: 'A different current goal.' });
  assert.equal(goalValidationIndicator(tui.goal, tui.goalValidation), null);
  const next = { id: randomUUID(), objective: 'A different current goal.', status: 'complete' };
  ui.updateSession({ ...session, goal: next, goalValidation: { state: 'none', sourceGoalId: next.id } });
  ui.event('goal.validation', previous); ui.updateSession({ ...session, goalValidation: previous });
  assert.equal(tui.goal.id, next.id); assert.equal(goalValidationIndicator(tui.goal, tui.goalValidation), null);
});

test('out-of-order revisions, replaced reviews and same-revision stale projections never restore green', t => {
  const { ui, tui, session } = terminal(t), reviewSessionId = randomUUID();
  const initial = projection('validated', { reviewSessionId }); ui.updateSession({ ...session, goalValidation: initial });
  const pending = projection('pending', { revision: 3 }); ui.updateSession({ ...session, goalValidation: pending });
  ui.updateSession({ ...session, goalValidation: initial }); assert.equal(tui.goalValidation.state, 'pending');
  ui.updateSession({ ...session, goalValidation: { ...pending, state: 'stale', reason: 'source_or_evidence_changed' } });
  ui.updateSession({ ...session, goalValidation: { ...pending, state: 'validated' } }); assert.equal(tui.goalValidation.state, 'stale');
  ui.event('goal.validation', initial); assert.notEqual(tui.goalValidation?.state, 'validated', 'historical green events are rechecked against current Core records');
});

test('reviewer dissent or missing evidence keeps the goal achieved while validation remains unconfirmed', t => {
  const { ui, tui, session } = terminal(t);
  ui.updateSession({ ...session, goalValidation: projection('not_validated', { reason: 'agent_dissent' }) });
  ui.event('debate.result', { debateId: randomUUID(), status: 'awaiting_review', goalSatisfaction: 'inconclusive', reason: 'agent_dissent',
    validationAssessment: { achieved: false }, message: 'One reviewer found a conflicting account result, so validation stopped.' });
  assert.match(clean(tui.goalBadgeLayout(79).line), /Goal achieved ✓.*Not validated ✗/);
  assert.match(tui.goalBadgeLayout(79).extra.map(clean).join('\n'), /A reviewer found a conflicting result/);
  ui.updateSession({ ...session, goalValidation: projection('inconclusive', { revision: 3, reason: 'missing_evidence' }) });
  ui.event('debate.result', { debateId: randomUUID(), status: 'awaiting_review', goalSatisfaction: 'supported', assessments: [true, true],
    message: 'The selected reviewers agree, but required final verification is missing.' });
  assert.equal(goalValidationIndicator(tui.goal, tui.goalValidation).tone, palette.warning);
  assert.match(tui.goalBadgeLayout(79).extra.map(clean).join('\n'), /The available evidence did not settle the question/);
  assert.equal(tui.goal.status, 'complete');
});
