import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { clean, cellWidth } from '../src/terminal-format.js';
import { createTerminalTheme } from '../src/terminal-theme.js';
import { recordDebateEvent, debateEntryLayout, debateParticipantTone, validationResultStatus, validationSummary } from '../src/debate-ui.js';
import { palette } from '../src/terminal-theme.js';

const participants = debateId => Array.from({ length: 3 }, (_, index) => ({ id: `${debateId}:participant:${index}`, index, provider: 'same-provider', model: 'same-model' }));
const started = (debateId = 'review-one') => ({ debateId, participants: participants(debateId) });
const message = (index, options = {}) => ({ debateId: 'review-one', participantId: `review-one:participant:${index}`, participantIndex: index,
  provider: 'same-provider', model: 'same-model', role: index ? 'reviewer' : 'main agent', assignmentId: `assignment-${index}`, round: 1, maxRounds: 3,
  text: `Distinct private discussion from participant ${index + 1}.`, ...options });
const result = (options = {}) => ({ debateId: 'review-one', status: 'awaiting_review', goalSatisfaction: 'inconclusive',
  message: 'The final conclusion needs another account control.', unresolvedDisagreement: ['The account control is missing.'], ...options });
const settle = () => new Promise(resolve => setTimeout(resolve, 90));

function terminal(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-debate-ui-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = directory;
  const input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 120, rows: 36 }); output.resume();
  const ui = new UI({ input, output, error: output, ...options }); ui.setSession('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  ui.updateSession({ id: ui.sessionId, alias: 'Review project', cwd: directory, provider: 'codex', model: 'Chat model', selectedEffort: 'high' });
  ui.tui.value = 'keep this editable draft'; ui.tui.cursor = 5;
  t.after(() => { ui.close(); if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return { ui, input, output, tui: ui.tui };
}

test('Validate is one collapsed block, with consensus and unresolved objections always below', t => {
  const { ui, tui } = terminal(t);
  ui.event('message.user', { text: 'Review the achieved goal.' }); ui.event('text', { text: 'Original answer remains.' });
  tui.render(); const header = tui.lastFrame[0];
  ui.event('debate.started', started());
  for (let index = 0; index < 3; index++) ui.event('debate.message', message(index));
  ui.event('debate.result', result()); tui.render();
  const block = tui.entries.find(entry => entry.kind === 'debate');
  assert.equal(block.expanded, false); assert.equal(block.messages.length, 3);
  assert.equal(tui.entries.filter(entry => entry.kind === 'assistant').length, 1, 'participant discussions stay inside their block');
  const body = tui.content(119).map(clean).join('\n');
  assert.match(body, /▸ VALIDATE.*3 agents.*3 messages/); assert.doesNotMatch(body, /Distinct private discussion/);
  assert.match(body, /CONSENSUS · Not validated ✗[\s\S]*The final conclusion[\s\S]*The account control is missing/);
  assert.ok(body.indexOf('CONSENSUS') > body.indexOf('Click to expand'));
  assert.equal(tui.lastFrame[0], header); assert.equal(tui.model, 'Chat model'); assert.equal(tui.value, 'keep this editable draft'); assert.equal(tui.cursor, 5);
});

test('actual mouse and keyboard toggle debate locally, and Escape respects a picker first', async t => {
  const { ui, tui, input } = terminal(t); ui.event('debate.started', started()); ui.event('debate.message', message(0)); tui.render();
  const toggle = tui.hitTargets.find(hit => hit.type === 'debate-toggle'); assert.ok(toggle);
  input.write(`\x1b[<0;${toggle.left + 1};${toggle.row}M`); tui.render();
  const block = tui.entries.find(entry => entry.kind === 'debate'); assert.equal(block.expanded, true);
  assert.match(tui.content(119).map(clean).join('\n'), /Distinct private discussion from participant 1/);
  const picked = ui.chooseOne('Model', { choices: [{ value: 'one', label: 'One' }] }); await Promise.resolve();
  input.write('\x1b[27u'); assert.equal(await picked, null); assert.equal(block.expanded, true);
  input.write('\x1b'); await settle(); assert.equal(block.expanded, false);
  input.write('\x02'); assert.equal(block.expanded, true); input.write('\x02'); assert.equal(block.expanded, false);
  assert.equal(tui.value, 'keep this editable draft'); assert.equal(tui.cursor, 5); assert.equal(tui.inputQueue.length, 0);
});

test('participant slots retain distinct colors across same-provider models, phases and repeated events', () => {
  const entries = []; recordDebateEvent(entries, 'debate.started', started());
  for (const index of [2, 0, 1]) recordDebateEvent(entries, 'debate.message', message(index, { role: 'investigation', assignmentId: `investigation-${index}`, round: 0 }));
  for (const index of [1, 2, 0]) recordDebateEvent(entries, 'debate.message', message(index));
  recordDebateEvent(entries, 'debate.message', message(1));
  recordDebateEvent(entries, 'debate.message', message(1, { round: 2, provider: 'different-provider', model: 'different-model' }));
  recordDebateEvent(entries, 'debate.started', started());
  const block = entries[0]; assert.equal(entries.length, 1); assert.equal(block.participants.length, 3); assert.equal(block.messages.length, 7);
  assert.equal(new Set(block.participants.map(participant => debateParticipantTone(participant.index))).size, 3);
  block.expanded = true;
  for (const name of ['blue', 'black', 'white']) for (const force of ['3', '1', '0']) {
    const theme = createTerminalTheme({ isTTY: true }, { FORCE_COLOR: force }, name), rows = debateEntryLayout(block, 119, theme).lines;
    for (const index of [0, 1, 2]) {
      const row = rows.find(line => clean(line).includes(`Agent ${index + 1} · same-provider · same-model · Independent check`)); assert.ok(row);
      if (force !== '0') assert.ok(row.includes(theme.foreground(debateParticipantTone(index))));
    }
    if (force !== '0') assert.equal(new Set([0, 1, 2].map(index => theme.foreground(debateParticipantTone(index)))).size, 3);
    assert.match(rows.map(clean).join('\n'), /Agent 2 · different-provider · different-model · Challenge · round 2/);
  }
});

test('linked/replayed reviews deduplicate by debate ID and preserve separate review blocks', t => {
  const { ui, tui } = terminal(t);
  for (let replay = 0; replay < 2; replay++) {
    ui.event('debate.started', started()); ui.event('debate.phase', { debateId: 'review-one', phase: 'challenge' });
    ui.event('debate.message', message(1)); ui.event('debate.result', result());
  }
  ui.event('debate.started', started('review-two'));
  ui.event('debate.message', message(0, { debateId: 'review-two', participantId: 'review-two:participant:0' }));
  const blocks = tui.entries.filter(entry => entry.kind === 'debate'); assert.equal(blocks.length, 2);
  assert.equal(blocks[0].messages.length, 1); assert.equal(blocks[1].messages.length, 1); assert.equal(blocks[1].result, null);
  assert.equal(blocks[0].expanded, false); assert.equal(blocks[1].expanded, false);
});

test('expanded bodies wrap to terminal width, preserve rich message bodies for copying, and survive resize', t => {
  const { ui, tui, output } = terminal(t);
  const original = '<message version="1"><p>A <b>rich</b> review with 🐝你 and a complete original body.</p></message>';
  ui.event('debate.started', started()); ui.event('debate.message', message(0, { text: original }));
  ui.event('debate.message', message(1, { text: 'A long report with Unicode 🐝你. '.repeat(20) }));
  ui.event('debate.result', result({ status: 'complete', goalSatisfaction: 'supported', message: 'The checked conclusion is supported.', unresolvedDisagreement: [] }));
  const block = tui.entries.find(entry => entry.kind === 'debate'); tui.toggleDebate(block);
  assert.equal(block.messages[0].copyEntry.text, original);
  for (const width of [16, 39, 71, 79, 119, 159]) {
    const rows = tui.entryLayout(block, width).lines;
    assert.ok(rows.every(line => cellWidth(line) <= width), `content fits ${width} columns`);
    output.columns = width + 1; tui.render(); assert.equal(block.expanded, true);
    assert.ok(tui.lastFrame.every(line => cellWidth(line) <= width));
  }
  const layout = tui.entryLayout(block, 119);
  assert.ok(layout.hits.some(hit => hit.type === 'response' && hit.entry.text === original));
  assert.doesNotMatch(layout.lines.map(clean).join('\n'), /<message|<p>|<b>/);
  assert.match(layout.lines.map(clean).join('\n'), /CONSENSUS · Review complete/);
});

test('legacy debate events remain readable and an inconsistent completion never hides objections', () => {
  const entries = []; recordDebateEvent(entries, 'debate.message', { participant: 'old-provider', role: 'reviewer', text: 'Legacy report' });
  recordDebateEvent(entries, 'debate.result', { status: 'complete', message: 'A conclusion', unresolvedDisagreement: ['An unresolved control'] });
  const block = entries[0], theme = createTerminalTheme({ isTTY: false }, {});
  assert.equal(block.messages[0].text, 'Legacy report');
  assert.match(debateEntryLayout(block, 79, theme).lines.map(clean).join('\n'), /Not validated ✗[\s\S]*CONSENSUS · Not validated ✗[\s\S]*An unresolved control/);
});

test('efficient validation phases display natural labels and summaries while retaining original bodies for copy', () => {
  const entries = [], theme = createTerminalTheme({ isTTY: false }, {});
  recordDebateEvent(entries, 'debate.started', started());
  const original = JSON.stringify({ summary: 'The supplied answer matches the saved record.', validationAssessment: { objective: 'Check the answer', achieved: true, criteria: [] } });
  recordDebateEvent(entries, 'debate.message', message(0, { phase: 'independent_check', role: 'independent assessment', round: 0, text: original }));
  recordDebateEvent(entries, 'debate.message', message(1, { phase: 'missing_evidence', role: 'focused followup', round: 1, text: 'The missing account control was checked.' }));
  recordDebateEvent(entries, 'debate.message', message(2, { phase: 'final_review', role: 'fresh reviewer', round: 1, text: 'The final review confirms the cited evidence.' }));
  recordDebateEvent(entries, 'debate.phase', { debateId: 'review-one', phase: 'consensus' });
  const block = entries[0]; block.expanded = true;
  const body = debateEntryLayout(block, 119, theme).lines.map(clean).join('\n');
  for (const label of ['Independent check', 'Checking missing evidence', 'Final review', 'Consensus']) assert.ok(body.includes(label));
  assert.match(body, /The supplied answer matches the saved record/); assert.doesNotMatch(body, /validationAssessment|"achieved"|\btrue\b|\bfalse\b|\bnull\b|round 1/);
  assert.equal(block.messages[0].copyEntry.text, original); assert.equal(block.messages.length, 3);
});

test('internal tri-state and structured fallback fields never become raw chat JSON', () => {
  for (const literal of ['true', 'false', 'null', '{"validationAssessment":{"achieved":null}}'])
    assert.equal(validationSummary(literal), 'The reviewer did not provide a readable summary.');
  const entries = [], theme = createTerminalTheme({ isTTY: false }, {});
  recordDebateEvent(entries, 'debate.result', result({ message: null, decision: {
    validationAssessment: { achieved: false }, remainingObjections: [{ claim: 'A selected reviewer found a conflicting account result.', achieved: false }],
  } }));
  const body = debateEntryLayout(entries[0], 119, theme).lines.map(clean).join('\n');
  assert.match(body, /Not validated ✗[\s\S]*A selected reviewer found a conflicting account result/);
  assert.doesNotMatch(body, /"achieved"|validationAssessment|\btrue\b|\bfalse\b|\bnull\b|\[object Object\]/);
  assert.equal(validationResultStatus(result({ reason: 'agent_dissent' })).tone, palette.danger);
  assert.equal(validationResultStatus(result({ reason: 'missing_evidence' })).tone, palette.warning);
  assert.equal(validationResultStatus(result({ status: 'complete', goalSatisfaction: 'supported', unresolvedDisagreement: [], decision: { nextVerificationSteps: ['Run the missing control.'] } })).label, 'Not validated ✗');
});

test('plain terminal output uses natural summaries without internal assessment objects', () => {
  const input = new PassThrough(), output = new PassThrough(); let written = '';
  output.on('data', chunk => { written += chunk; });
  const ui = new UI({ input, output, error: output });
  try {
    ui.event('debate.message', message(0, { phase: 'independent_check', text: JSON.stringify({ summary: 'The answer matches the cited source.', validationAssessment: { achieved: true } }) }));
    ui.event('debate.result', result({ reason: 'missing_evidence', message: 'One account control is still missing.', validationAssessment: { achieved: null } }));
    assert.match(written, /Independent check[\s\S]*The answer matches the cited source/);
    assert.match(written, /CONSENSUS · Not validated ✗[\s\S]*One account control is still missing/);
    assert.doesNotMatch(written, /validationAssessment|"achieved"|\btrue\b|\bfalse\b|\bnull\b/);
  } finally { ui.close(); }
});
