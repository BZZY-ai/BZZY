import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSession, saveSession, loadSession } from '../src/engine/store.js';
import { getProvider } from '../src/engine/providers.js';
import { appendEvent, events, putRecord } from '../src/engine/database.js';
import { RunnerUI } from '../src/engine/runtime-ui.js';
import { debateEventUI } from '../src/engine/debate-events.js';
import { finishChatDebate } from '../src/engine/chat-debate.js';

test('persistent RunnerUI stores typed review events once per conversation and finalization preserves a newer source goal', () => {
  const previous = process.env.BZZY_HOME, directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-validation-events-')));
  try {
    process.env.BZZY_HOME = path.join(directory, 'private');
    const parent = createSession(getProvider('codex'), directory, 'source-model');
    parent.goal = { id: randomUUID(), status: 'complete', objective: 'Original completed objective.' }; saveSession(parent);
    const original = appendEvent(parent.id, 'text', { text: '<message><p>Keep this original assistant body.</p></message>' });
    const review = createSession(getProvider('codex'), directory, 'review-model');
    Object.assign(review, { parentSessionId: parent.id, reviewSource: { sessionId: parent.id, goalId: parent.goal.id },
      goal: { id: randomUUID(), status: 'awaiting_review', objective: parent.goal.objective }, summary: { usage: { totalTokens: 20, complete: true } } }); saveSession(review);
    const choices = [0, 1].map(index => ({ provider: 'codex', model: `review-${index}`, effort: 'default' }));
    const runner = new RunnerUI(review.id, { parentSessionId: parent.id });
    const wrapped = debateEventUI(review, runner, choices);
    assert.equal(debateEventUI(review, wrapped, choices), wrapped);
    wrapped.event('debate.started', { participants: choices });
    wrapped.event('debate.message', { participantIndex: 0, role: 'main opening', round: 0, maxRounds: 1, assignmentId: 'fixture-assignment', text: 'The supplied evidence remains inconclusive.' });
    wrapped.event('debate.result', { status: 'awaiting_review', goalSatisfaction: 'inconclusive', message: 'Validation finished · unresolved.' });
    const typed = id => events(id, 0, 100).filter(event => event.type.startsWith('debate.'));
    assert.equal(typed(review.id).length, 3); assert.equal(typed(parent.id).length, 3);
    assert.deepEqual(typed(parent.id).map(event => event.type), typed(review.id).map(event => event.type));
    assert.ok(typed(parent.id).every(event => event.data.sessionId === review.id && event.data.sourceSessionId === parent.id && event.data.debateId === review.goal.id));
    putRecord('debate', review.id, { debateId: review.goal.id, goalSatisfaction: 'inconclusive', decision: null, unresolvedDisagreement: ['Controls incomplete.'] });
    const newer = { id: randomUUID(), status: 'active', objective: 'A newer independent user objective.' };
    parent.goal = newer; saveSession(parent);
    finishChatDebate(parent.id, review.id); finishChatDebate(parent.id, review.id);
    assert.equal(typed(parent.id).filter(event => event.type === 'debate.result').length, 1);
    assert.deepEqual(loadSession(parent.id).goal, newer);
    assert.equal(events(parent.id, 0, 100).find(event => event.seq === original.seq).data.text, original.data.text);
    runner.close();
  } finally {
    if (previous === undefined) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
