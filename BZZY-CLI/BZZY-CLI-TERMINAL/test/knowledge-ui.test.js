import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { UI } from '../src/ui.js';
import { knowledgeCommand, knowledgeAction, knowledgeRows } from '../src/knowledge-ui.js';
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '../src/providers.js';
import { CoreKnowledge } from '@bzzy/core/knowledge';
import { remember } from '@bzzy/core/engine/memory.js';
import { initializeProject } from '@bzzy/core/engine/project.js';
import { saveSession, loadSession } from '@bzzy/core/engine/store.js';
import { listRecords, getRecord } from '@bzzy/core/engine/database.js';
import { createSkill, inspectSkill, readSkill, listSkills, stageSkillCandidate, listSkillCandidates } from '@bzzy/core/engine/skills.js';

let directory, previousHome, alpha, beta;
test.beforeEach(() => {
  previousHome = process.env.BZZY_HOME;
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-knowledge-ui-')));
  process.env.BZZY_HOME = path.join(directory, 'private');
  alpha = path.join(directory, 'alpha'); beta = path.join(directory, 'beta');
  fs.mkdirSync(alpha); fs.mkdirSync(beta);
});
test.afterEach(() => {
  if (previousHome == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previousHome;
  fs.rmSync(directory, { recursive: true, force: true });
});
function sessionAt(cwd) {
  const session = createChatSession(getProvider('codex'), { cwd, model: 'fixture-model', effort: 'default' });
  initializeProject(session); saveSession(session); return session;
}
function terminal(session = sessionAt(alpha)) {
  const input = new PassThrough(); input.isTTY = true; input.setRawMode = () => {};
  const output = new PassThrough(); Object.assign(output, { isTTY: true, rows: 36, columns: 120 }); output.resume();
  const ui = new UI({ input, output, error: output }); ui.setSession(session.id); ui.updateSession({ ...session, alias: 'fixture-project' });
  const events = []; ui.event = (type, data) => events.push({ type, ...data });
  return { ui, session, events };
}
function answers(ui, values) { ui.ask = async () => values.shift(); }
const rowsText = ui => skillRows(ui).map(row => row.text).join('\n');

test('Learn shows pinned inputs, staged defaults, project facts and optional retrieval without starting inference', async () => {
  const { ui, session } = terminal();
  try {
    ui.tui.value = 'preserve unsent draft';
    await knowledgeCommand('/learn', ui); await knowledgeAction('settings', ui);
    assert.match(rowsText(ui), /Skill policy: new stage.*corrections stage/);
    const memory = remember(session, { kind: 'hypothesis', statement: 'Owner fact projection fixture stays attributed.' });
    await knowledgeAction('facts', ui); answers(ui, [memory.id]); ui.chooseOne = async () => 'yes';
    await knowledgeAction('facts-pin', ui); assert.match(rowsText(ui), /Owner fact projection fixture/);
    await knowledgeAction('retrieval', ui); assert.match(rowsText(ui), /Local embeddings: off/);
    assert.equal(listRecords('core.learning.job').length, 0);
    await knowledgeCommand('/learn review', ui);
    assert.ok(ui.knowledgeState.packetId); await knowledgeAction('packet', ui);
    assert.match(rowsText(ui), /Pinned learning packet/); assert.match(rowsText(ui), /sourceCutoff/);
    assert.equal(ui.tui.value, 'preserve unsent draft'); assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('knowledge views distinguish pending relationship checks from stale evidence and retain historical labels', async () => {
  const { ui, session } = terminal();
  const pending = { kind: 'memory', sourceId: 'legacy-memory', id: 'legacy-memory', sessionId: session.id,
    statement: 'A previously confirmed observation.', truth: 'confirmed', stale: false,
    relationshipCoverage: 'backfill-pending', freshnessStatus: 'unverified', revision: 1, evidence: [] };
  const stale = { ...pending, sourceId: 'changed-memory', statement: 'An observation whose evidence changed.',
    truth: 'inconclusive', stale: true, freshnessStatus: 'stale', staleReasons: ['evidence-unavailable-or-changed'] };
  ui.knowledgeAPI = { request(operation) {
    if (operation === 'search') return { items: [pending, stale] };
    if (operation === 'facts.read') return { enabled: true, items: [{ ...pending, historical: true, pinned: true }] };
    if (operation === 'resolutions.search') return { items: [{ ...pending, symptom: 'Earlier diagnostic observation.',
      fixSteps: ['Inspect the original control.'], memoryId: pending.id, match: 'exact', causeStatus: 'unverified' }] };
    throw new Error('Unexpected operation: ' + operation);
  } };
  try {
    await knowledgeCommand('/memory observation', ui);
    assert.match(rowsText(ui), /confirmed · relationship check pending/);
    assert.match(rowsText(ui), /inconclusive · STALE · relationship check pending/);
    await knowledgeAction('hit:0', ui);
    assert.match(rowsText(ui), /Recorded truth is historical; the relationship check is not complete/);
    assert.doesNotMatch(rowsText(ui), /STALE/);
    await knowledgeAction('hit:1', ui);
    assert.match(rowsText(ui), /STALE/); assert.match(rowsText(ui), /evidence-unavailable-or-changed/);
    await knowledgeAction('facts', ui);
    assert.match(rowsText(ui), /confirmed · relationship check pending · historical · owner pinned/);
    answers(ui, ['Earlier diagnostic observation']); await knowledgeAction('resolutions', ui);
    assert.match(rowsText(ui), /confirmed · relationship check pending/);
    assert.match(rowsText(ui), /Historical procedures need current evidence/);
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('core.learning.job').length, 0);
  } finally { ui.close(); }
});

test('reviewed skill policy updates use the displayed owner revision and preserve conversation changes', async () => {
  const { ui } = terminal(), api = new CoreKnowledge();
  try {
    await knowledgeCommand('/learn settings', ui);
    const picks = ['stage', 'off', 'yes']; ui.chooseOne = async () => picks.shift();
    await knowledgeAction('evolution-policy', ui);
    assert.equal(ui.knowledgeState.evolution.newSkills, 'stage'); assert.equal(ui.knowledgeState.evolution.updates, 'off');
    const shownRevision = ui.knowledgeState.evolution.revision;
    api.request('skill.evolution.settings', { settings: { updates: 'stage' }, expectedRevision: shownRevision, reviewed: true });
    const stalePicks = ['stage', 'off', 'yes']; ui.chooseOne = async () => stalePicks.shift();
    await assert.rejects(knowledgeAction('evolution-policy', ui), /changed/);
    assert.equal(listRecords('core.learning.job').length, 0);
  } finally { ui.close(); }
});

test('learning settings can return to the bounded source route without dispatching work', async () => {
  const { ui } = terminal();
  try {
    await knowledgeCommand('/learn settings', ui);
    const picks = ['source', 'yes', 'bounded_source', 'yes'];
    ui.chooseOne = async (_title, options) => {
      const pick = picks.shift();
      assert.ok(options.some(option => option.value === pick));
      return pick;
    };
    await knowledgeAction('learning-model', ui);
    assert.equal(ui.knowledgeState.settings.modelRoute.source, 'source');
    await knowledgeAction('learning-model', ui);
    assert.equal(ui.knowledgeState.settings.modelRoute.source, 'bounded_source');
    assert.equal(ui.knowledgeState.settings.revision, 2);
    assert.equal(listRecords('core.learning.job').length, 0);
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('opening memory, learning and candidates preserves the composer and performs no model work', async () => {
  const { ui, session, events } = terminal();
  try {
    const before = JSON.stringify(loadSession(session.id)); ui.tui.value = 'keep my unsent draft';
    for (const command of ['/memory', '/learn', '/learn candidates', '/learn fixtures']) {
      assert.equal(await knowledgeCommand(command, ui), true);
      ui.tui.render(); assert.equal(ui.tui.value, 'keep my unsent draft');
    }
    assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('core.learning.job').length, 0);
    assert.equal(JSON.stringify(loadSession(session.id)), before); assert.equal(ui.sessionId, session.id);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
  } finally { ui.close(); }
});

test('project search and skill previews cannot follow a conversation change into another project', async () => {
  const first = sessionAt(alpha), second = sessionAt(beta);
  remember(first, { kind: 'hypothesis', statement: 'ALPHA_ONLY ownership baseline.' });
  remember(second, { kind: 'hypothesis', statement: 'BETA_ONLY account control.' });
  const skill = createSkill({ name: 'private-method', description: 'A project method.', instructions: 'ALPHA_ONLY supporting instructions.' }, { projectRoot: alpha, scope: 'project' });
  const { ui } = terminal(first);
  try {
    await knowledgeCommand('/memory ownership', ui); assert.match(rowsText(ui), /ALPHA_ONLY/); assert.doesNotMatch(rowsText(ui), /BETA_ONLY/);
    await knowledgeAction('hit:0', ui); const oldState = ui.knowledgeState, oldKey = ui.knowledgeContextKey;
    await skillsCommand('/skills view:' + skill.id, ui); assert.match(rowsText(ui), /ALPHA_ONLY/);
    ui.setSession(second.id); ui.updateSession(second);
    assert.equal(ui.skillPreview, null); assert.equal(ui.knowledgeView, null);
    assert.doesNotMatch(rowsText(ui), /ALPHA_ONLY/);
    ui.knowledgeView = 'hit'; ui.knowledgeState = oldState; ui.knowledgeContextKey = oldKey;
    assert.doesNotMatch(knowledgeRows(ui).map(row => row.text).join('\n'), /ALPHA_ONLY/);
    await assert.rejects(knowledgeAction('invalidate-memory', ui), /Conversation changed/);
    await knowledgeCommand('/memory account', ui); assert.match(rowsText(ui), /BETA_ONLY/); assert.doesNotMatch(rowsText(ui), /ALPHA_ONLY/);
  } finally { ui.close(); }
});

test('explicit review only queues learning, and pause resume cancel use the displayed revision', async () => {
  const { ui, session, events } = terminal();
  try {
    await knowledgeCommand('/learn review', ui); const id = ui.knowledgeState.id;
    assert.ok(id); assert.equal(ui.knowledgeState.state, 'queued');
    await knowledgeAction('pause-job', ui); assert.equal(ui.knowledgeState.state, 'paused');
    await knowledgeAction('resume-job', ui); assert.equal(ui.knowledgeState.state, 'queued');
    await knowledgeCommand('/learn cancel ' + id, ui); assert.equal(ui.knowledgeState.state, 'cancelled');
    assert.equal(listRecords('core.learning.job').length, 1); assert.equal(listRecords('execution').length, 0);
    assert.equal(getRecord('core.learning.job', id).sessionId, session.id);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
  } finally { ui.close(); }
});

test('profile edits show a preview, require explicit approval and reject stale revisions', async () => {
  const { ui, events } = terminal(), owner = new CoreKnowledge();
  try {
    await knowledgeCommand('/learn profiles', ui);
    answers(ui, ['Prefer concise evidence-first reports.']);
    await knowledgeAction('edit-profile:user', ui);
    assert.match(rowsText(ui), /Review user profile/); assert.equal(owner.request('profiles').profiles.find(item => item.target === 'user').text, '');
    ui.chooseOne = async () => 'cancel'; await knowledgeAction('save-profile', ui);
    assert.equal(owner.request('profiles').profiles.find(item => item.target === 'user').text, '');
    ui.chooseOne = async () => 'yes'; await knowledgeAction('save-profile', ui);
    const saved = owner.request('profiles').profiles.find(item => item.target === 'user'); assert.match(saved.text, /concise evidence/);
    answers(ui, ['A stale pending edit.']); await knowledgeAction('edit-profile:user', ui);
    owner.request('profile.update', { target: 'user', text: 'A newer owner preference.', expectedRevision: saved.revision, reviewed: true });
    await assert.rejects(knowledgeAction('save-profile', ui), /changed|revision/);
    assert.equal(owner.request('profiles').profiles.find(item => item.target === 'user').text, 'A newer owner preference.');
    assert.equal(events.filter(event => event.type === 'error').length, 0);
  } finally { ui.close(); }
});

test('owner history restores reviewed profiles and restores old memory as inconclusive', async () => {
  const { ui, session } = terminal(), owner = new CoreKnowledge();
  try {
    owner.request('profile.update', { target: 'user', text: 'Initial reporting preference.', expectedRevision: 0, reviewed: true });
    owner.request('profile.update', { target: 'user', text: 'Newer reporting preference.', expectedRevision: 1, reviewed: true });
    await knowledgeCommand('/learn profiles', ui); await knowledgeAction('profile-history:user', ui);
    assert.match(rowsText(ui), /Initial reporting preference/); ui.chooseOne = async () => 'cancel';
    await knowledgeAction('restore-profile:1', ui); assert.equal(owner.request('profiles').profiles[0].revision, 2);
    ui.chooseOne = async () => 'yes'; await knowledgeAction('restore-profile:1', ui);
    assert.equal(owner.request('profiles').profiles[0].text, 'Initial reporting preference.'); assert.equal(owner.request('profiles').profiles[0].revision, 3);
    const record = remember(session, { kind: 'hypothesis', statement: 'A versioned observation requires retesting.' });
    owner.request('memory.invalidate', { sessionId: session.id, id: record.id, reason: 'Synthetic environment changed.', expectedRevision: 1 });
    ui.knowledgeIncludeStale = true; await knowledgeCommand('/memory versioned', ui); await knowledgeAction('hit:0', ui); await knowledgeAction('memory-history', ui);
    assert.match(rowsText(ui), /Restore as inconclusive for revalidation/); await knowledgeAction('restore-memory:1', ui);
    const restored = getRecord('memory', record.id); assert.equal(restored.revision, 3); assert.equal(restored.truth, 'inconclusive'); assert.equal(restored.verification, null);
  } finally { ui.close(); }
});

test('fixture import previews exact cases before registration and candidate evaluation only queues work', async () => {
  const { ui, session, events } = terminal(), owner = new CoreKnowledge();
  const definition = { name: 'Synthetic authorization cases', cases: [
    { id: 'real', observations: 'A verified synthetic positive ownership differential.', expected: 'real' },
    { id: 'control', observations: 'A synthetic equivalent authorized control.', expected: 'false_positive' },
    { id: 'unknown', observations: 'A synthetic case missing a reliable baseline.', expected: 'inconclusive' }
  ] };
  const file = path.join(directory, 'offline-fixtures.json'); fs.writeFileSync(file, JSON.stringify(definition));
  try {
    await knowledgeCommand('/learn fixtures', ui); answers(ui, [file]); ui.chooseOne = async () => 'project';
    await knowledgeAction('import-fixtures', ui); assert.equal(ui.knowledgeView, 'fixture-import');
    assert.deepEqual(ui.knowledgeState.definition, definition); assert.match(rowsText(ui), /Approve and register these exact cases/);
    assert.equal(owner.request('fixtures.list', { sessionId: session.id }).length, 0);
    ui.chooseOne = async () => 'cancel'; await knowledgeAction('register-fixtures', ui);
    assert.equal(owner.request('fixtures.list', { sessionId: session.id }).length, 0);
    ui.chooseOne = async () => 'yes'; await knowledgeAction('register-fixtures', ui);
    const fixture = owner.request('fixtures.list', { sessionId: session.id })[0]; assert.equal(fixture.caseCount, 3);
    const pending = stageSkillCandidate({ name: 'candidate-check', description: 'Check ownership controls.', instructions: 'Compare owner, foreign-account and baseline responses.' }, { session });
    await knowledgeAction('candidate:' + pending.id, ui); ui.chooseOne = async () => fixture.id;
    await knowledgeAction('candidate-evaluate', ui);
    assert.equal(ui.knowledgeView, 'job'); assert.equal(ui.knowledgeState.state, 'queued');
    await knowledgeAction('fixture:' + fixture.id, ui); assert.match(rowsText(ui), /synthetic positive ownership/);
    ui.chooseOne = async () => 'yes'; await knowledgeAction('revoke-fixtures', ui);
    assert.equal(ui.knowledgeState.reviewed, false); assert.ok(ui.knowledgeState.revokedAt);
    assert.equal(listRecords('execution').length, 0); assert.equal(listSkills({ session }).skills.length, 0);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
  } finally { ui.close(); }
});

test('candidate approval pins its displayed content, active base and evaluated corpus record', async () => {
  const { ui, session } = terminal(), calls = [];
  const candidate = { id: 'candidate-fixture', name: 'reviewed-method', scope: 'project', projectId: session.projectId,
    state: 'evaluated', revision: 7, baseRevision: 3, version: 'candidate-version', evaluation: { id: 'evaluation-fixture', status: 'passed', authority: 'host-fixture', fixtureHash: 'fixture-hash' } };
  ui.knowledgeAPI = { request(operation, input) { calls.push({ operation, input }); if (operation === 'candidate.inspect') return candidate; if (operation === 'candidate.accept') return { ...candidate, state: 'accepted' }; throw new Error('Unexpected operation'); } };
  try {
    await knowledgeAction('candidate:' + candidate.id, ui); ui.chooseOne = async () => 'cancel'; await knowledgeAction('candidate-accept', ui);
    assert.equal(calls.filter(call => call.operation === 'candidate.accept').length, 0);
    ui.chooseOne = async () => 'yes'; await knowledgeAction('candidate-accept', ui);
    assert.deepEqual(calls.find(call => call.operation === 'candidate.accept').input, { sessionId: session.id, id: candidate.id,
      expectedRevision: 7, expectedSkillRevision: 3, expectedEvaluationId: 'evaluation-fixture', reviewed: true, activate: true });
    assert.equal(listRecords('execution').length, 0);
  } finally { ui.close(); }
});

test('a conversation change while an owner prompt is open prevents the pending write', async () => {
  const first = sessionAt(alpha), second = sessionAt(beta), { ui, events } = terminal(first), calls = [];
  try {
    await knowledgeCommand('/learn profiles', ui); answers(ui, ['A pending preference.']); await knowledgeAction('edit-profile:user', ui);
    const owner = ui.knowledgeAPI;
    ui.knowledgeAPI = { request(operation, input) { calls.push(operation); return owner.request(operation, input); } };
    ui.chooseOne = async () => { ui.setSession(second.id); ui.updateSession(second); return 'yes'; };
    await assert.rejects(knowledgeAction('save-profile', ui), /Conversation changed/);
    assert.ok(!calls.includes('profile.update'));
    ui.setSession(first.id); ui.updateSession(first);
    ui.ask = async () => { ui.setSession(second.id); ui.updateSession(second); return 'must-not-create'; };
    await skillsCommand('/skills create', ui);
    assert.equal(listSkills({ projectRoot: beta }).total, 0);
    assert.ok(events.some(event => event.type === 'error' && /Conversation changed/.test(event.message)));
  } finally { ui.close(); }
});

test('skill creation defaults to project, history rollback needs review and promotion uses a separate preview', async () => {
  const { ui, session, events } = terminal();
  try {
    answers(ui, ['local-method', 'Project-owned verification.', 'Compare controlled baselines.']); await skillsCommand('/skills create', ui);
    const first = listSkills({ session }).skills.find(item => item.name === 'local-method'); assert.equal(first.scope, 'project'); assert.equal(first.enabled, false);
    const next = createSkill({ name: first.name, description: first.description, instructions: 'Compare controlled baselines and replay evidence.' }, { projectRoot: alpha, scope: 'project', expectedRevision: first.revision });
    await skillsCommand('/skills history:' + first.id, ui); assert.match(rowsText(ui), /Restore this version for review/);
    ui.chooseOne = async () => 'cancel'; await skillsCommand(`/skills rollback:${first.id}|${first.version}|${next.revision}`, ui);
    assert.equal(inspectSkill(first.id, { session }).version, next.version);
    ui.chooseOne = async () => 'restore'; await skillsCommand(`/skills rollback:${first.id}|${first.version}|${next.revision}`, ui);
    assert.equal(inspectSkill(first.id, { session }).version, first.version); assert.equal(inspectSkill(first.id, { session }).enabled, false);
    answers(ui, ['generic-controls', 'Review generic control groups.', 'Parameterize the selected target and compare authorized baseline controls.']);
    await skillsCommand('/skills promote:' + first.id, ui); assert.match(rowsText(ui), /Review a separate global workflow/);
    assert.equal(listSkillCandidates({ session }).total, 0);
    await skillsCommand('/skills promote-confirm', ui);
    const promoted = listSkillCandidates({ session }).candidates[0]; assert.equal(promoted.scope, 'global'); assert.equal(promoted.state, 'pending');
    assert.equal(readSkill(first.id, { session, enabledOnly: false }).version, first.version);
    ui.chooseOne = async () => 'global'; await skillsCommand('/skills scope', ui);
    answers(ui, ['shared-method', 'A generic shared workflow.', 'Inspect authorized inputs and report reproducible observations.']); await skillsCommand('/skills create', ui);
    assert.equal(inspectSkill('shared-method', { scope: 'global' }).scope, 'global'); assert.equal(listRecords('execution').length, 0);
    assert.equal(events.filter(event => event.type === 'error').length, 0);
  } finally { ui.close(); }
});
