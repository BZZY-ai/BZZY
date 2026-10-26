import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { UI } from '../src/ui.js';
import { skillsCommand, skillRows } from '../src/skills-ui.js';
import { knowledgeAction, knowledgeRows } from '../src/knowledge-ui.js';
import { createChatSession } from '@bzzy/core/engine/host-commands.js';
import { getProvider } from '@bzzy/core/engine/providers.js';
import { initializeProject } from '@bzzy/core/engine/project.js';
import { saveSession } from '@bzzy/core/engine/store.js';
import { getRecord, listRecords } from '@bzzy/core/engine/database.js';
import { publishLearnedSkill, inspectSkill, listSkills, readSkill, setSkillEnabled } from '@bzzy/core/engine/skills.js';

let directory, previous, project, session, ui, input, events, publication;
function conversation(cwd) {
  const current = createChatSession(getProvider('codex'), { cwd, model: 'offline-library-model', effort: 'default' });
  initializeProject(current); saveSession(current); return current;
}
test.beforeEach(() => {
  previous = process.env.BZZY_HOME; directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-learned-skill-ui-')));
  process.env.BZZY_HOME = path.join(directory, 'private'); project = path.join(directory, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'retained-source.txt'), 'The original project file must remain unchanged.'); session = conversation(project);
  const jobId = randomUUID();
  publication = publishLearnedSkill({ name: 'dated-controls', description: 'Check supplied birth and observation dates.', instructions: 'Compare supplied dated records and preserve missing-evidence caveats.' },
    { session, requestId: 'automatic-method-1', provenance: { kind: 'learning', jobId, sourceSessionId: session.id } });
  input = new PassThrough(); Object.assign(input, { isTTY: true, setRawMode() {} });
  const output = new PassThrough(); Object.assign(output, { isTTY: true, columns: 105, rows: 36 }); output.resume();
  ui = new UI({ input, output, error: output }); ui.setSession(session.id); ui.updateSession(session);
  ui.tui.value = 'Keep my unsent chat draft'; ui.tui.cursor = 6; events = [];
  const event = ui.event.bind(ui); ui.event = (type, data) => { events.push({ type, ...data }); event(type, data); };
});
test.afterEach(() => { ui.close(); if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous; fs.rmSync(directory, { recursive: true, force: true }); });
const command = value => skillsCommand('/skills ' + value, ui);
const text = () => skillRows(ui).map(row => row.text).join('\n');
function back() { ui.tui.render(); const hit = ui.tui.hitTargets.find(item => item.type === 'back'); assert.ok(hit); input.write(`\x1b[<0;${hit.left};${hit.row}M`); }

test('automatically learned skills appear enabled in Library with source, history and immediate disable controls', async () => {
  let prompts = 0; ui.chooseOne = async () => { prompts++; return 'cancel'; };
  await command(''); assert.match(text(), /\[ ON \] dated-controls/); assert.doesNotMatch(text(), /dated-controls · learned/);
  assert.equal(listSkills({ session, enabledOnly: true }).skills.some(item => item.id === publication.skillId), true);
  ui.tui.render();
  publishLearnedSkill({ name: 'new-live-method', description: 'A method learned while Library is open.', instructions: 'Compare the supplied records within the existing project scope.' },
    { session, requestId: 'automatic-method-2', provenance: { kind: 'learning', jobId: randomUUID(), sourceSessionId: session.id } });
  ui.tui.render(); assert.match(ui.tui.lastFrame.join('\n'), /new-live-method/);
  await command('view:' + publication.skillId);
  assert.match(text(), /Learned automatically/); assert.match(text(), new RegExp(session.id.slice(0, 12)));
  assert.ok(skillRows(ui).some(row => row.text === 'Disable for all models'));
  assert.ok(skillRows(ui).some(row => row.action === 'delete:' + publication.skillId));
  assert.ok(skillRows(ui).some(row => row.action === 'history:' + publication.skillId));
  assert.equal(prompts, 0, 'Learning publication and browsing require no activation prompt.');
  await command('toggle:' + publication.skillId);
  assert.equal(inspectSkill(publication.skillId, { session }).enabled, false); assert.match(text(), /Enable for all models/);
  assert.equal(listSkills({ session, enabledOnly: true }).skills.some(item => item.id === publication.skillId), false);
  await command('history:' + publication.skillId); assert.match(text(), /version history/); assert.match(text(), /Learned automatically/);
  assert.equal(listRecords('execution').length, 0); assert.equal(listRecords('run').length, 0);
  back(); back(); assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'Keep my unsent chat draft'); assert.equal(ui.tui.cursor, 6);
});

test('Delete defaults to Cancel, removes only the pinned Library entry and preserves history and original source', async () => {
  await command('view:' + publication.skillId);
  let choices;
  ui.chooseOne = async (_title, options) => { choices = options; return 'cancel'; };
  const before = inspectSkill(publication.skillId, { session }); await command('delete:' + publication.skillId);
  assert.equal(choices[0].value, 'cancel'); assert.equal(choices[0].selected, true);
  assert.equal(inspectSkill(publication.skillId, { session }).revision, before.revision);
  ui.chooseOne = async () => 'delete'; await command('delete:' + publication.skillId);
  assert.equal(ui.skillPreview, null); assert.equal(ui.skillView, 'library'); assert.doesNotMatch(text(), /dated-controls/);
  assert.equal(getRecord('core.skill', publication.skillId), null);
  assert.ok(listRecords('core.skill.history').some(item => item.skillId === publication.skillId && item.action === 'delete'));
  assert.ok(listRecords('core.skill.version').some(item => item.name === before.name && item.version === before.version));
  assert.equal(fs.readFileSync(path.join(project, 'retained-source.txt'), 'utf8'), 'The original project file must remain unchanged.');
  assert.ok(events.some(item => item.type === 'info' && /Deleted dated-controls/.test(item.message)));
  back(); assert.equal(ui.tui.panel, 'chat'); assert.equal(ui.tui.value, 'Keep my unsent chat draft'); assert.equal(ui.tui.cursor, 6);
});

test('Delete rejects a concurrent revision change while confirmation is open instead of deleting unseen changes', async () => {
  await command('view:' + publication.skillId); const shown = ui.skillPreview;
  ui.chooseOne = async () => { setSkillEnabled(shown.id, false, shown.revision, { session }); return 'delete'; };
  await command('delete:' + publication.skillId);
  const current = inspectSkill(publication.skillId, { session }); assert.equal(current.enabled, false); assert.equal(current.revision, shown.revision + 1);
  assert.ok(events.some(item => item.type === 'error' && /changed|revision/i.test(item.message)));
  assert.equal(listRecords('core.skill.history').some(item => item.action === 'delete'), false);
});

test('Delete and historical previews cannot act across a changed conversation or against an old version', async () => {
  await command('view:' + publication.skillId); const shown = ui.skillPreview;
  await command(`history-read:${shown.id}|${shown.version}`);
  assert.equal(skillRows(ui).some(row => row.action?.startsWith('delete:')), false);
  await command('delete:' + shown.id); assert.ok(events.some(item => item.type === 'error' && /current skill/.test(item.message)));
  await command('view:' + shown.id);
  const otherProject = path.join(directory, 'other'); fs.mkdirSync(otherProject); const other = conversation(otherProject);
  ui.chooseOne = async () => { ui.setSession(other.id); ui.updateSession(other); return 'delete'; };
  await command('delete:' + shown.id);
  assert.equal(inspectSkill(shown.id, { session }).version, shown.version);
  assert.ok(events.some(item => item.type === 'error' && /Conversation changed/.test(item.message)));
});

test('completed learning jobs link the actual enabled Library entry and preserve drafts and scope', async () => {
  await command(''); ui.skillScope = 'global';
  const jobId = randomUUID(), result = { lessonIds: [], candidateIds: [], skillIds: [publication.skillId], skillPublications: [publication], profileProposalIds: [] };
  ui.knowledgeAPI = { request(operation, fields) { assert.equal(operation, 'learning.inspect'); assert.equal(fields.id, jobId);
    return { id: jobId, revision: 1, state: 'completed', tokensUsed: 12, reason: 'turn-finished', result }; } };
  await knowledgeAction('job:' + jobId, ui);
  assert.match(knowledgeRows(ui).map(row => row.text).join('\n'), /1 learned skills/);
  assert.ok(knowledgeRows(ui).some(row => row.action === 'knowledge:skill:' + encodeURIComponent(publication.skillId)));
  await knowledgeAction('skill:' + encodeURIComponent(publication.skillId), ui);
  assert.equal(ui.knowledgeView, null); assert.equal(ui.skillView, 'library'); assert.equal(ui.skillPreview.id, publication.skillId);
  assert.equal(ui.skillPreview.enabled, true); assert.match(text(), /Disable for all models/);
  back(); back(); assert.equal(ui.tui.value, 'Keep my unsent chat draft'); assert.equal(ui.tui.cursor, 6);
  assert.equal(listRecords('execution').length, 0);
});

test('job links distinguish deleted publications and cannot open an unlisted or foreign-project skill', async () => {
  await command('');
  const jobId = randomUUID(), result = { skillIds: [publication.skillId], skillPublications: [{ ...publication, state: 'deleted' }] };
  ui.knowledgeAPI = { request() { return { id: jobId, revision: 1, state: 'completed', result }; } };
  await knowledgeAction('job:' + jobId, ui);
  assert.match(knowledgeRows(ui).map(row => row.text).join('\n'), /deleted from Library/);
  assert.equal(knowledgeRows(ui).some(row => row.action?.startsWith('knowledge:skill:')), false);
  await assert.rejects(knowledgeAction('skill:' + encodeURIComponent(publication.skillId), ui), /deleted/);
  await assert.rejects(knowledgeAction('skill:unlisted-method', ui), /Choose a learned skill/);
  const elsewhere = path.join(directory, 'elsewhere'); fs.mkdirSync(elsewhere); const foreign = conversation(elsewhere);
  const other = publishLearnedSkill({ name: 'foreign-method', description: 'A method for another project.', instructions: 'FOREIGN_PRIVATE_METHOD' },
    { session: foreign, requestId: 'foreign-one', provenance: { kind: 'learning', jobId: randomUUID(), sourceSessionId: foreign.id } });
  result.skillIds = [other.skillId]; result.skillPublications = [other]; await knowledgeAction('job:' + jobId, ui);
  await assert.rejects(knowledgeAction('skill:' + encodeURIComponent(other.skillId), ui), /not found in this project/);
  assert.doesNotMatch(text(), /FOREIGN_PRIVATE_METHOD/); assert.equal(readSkill(other.skillId, { session: foreign }).text.includes('FOREIGN_PRIVATE_METHOD'), true);
});
