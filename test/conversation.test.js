import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession, loadSession } from '../src/store.js';
import { appendEvent } from '../src/database.js';
import { BUILTINS } from '../src/providers.js';
import { conversationCursor, conversationMessages, conversationPrompt, completeConversationHandoff } from '../src/conversation.js';

test('chat handoff preserves multiline messages and follow-up answers without forwarding tool, approval or memory records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-conversation-')), previous = process.env.BZZY_HOME;
  process.env.BZZY_HOME = path.join(directory, 'private');
  try {
    const session = createSession(BUILTINS.codex, directory);
    appendEvent(session.id, 'message.user', { text: 'Inspect this\nsecond line', kind: 'goal' });
    for (let i = 0; i < 1001; i++) appendEvent(session.id, 'tool', { name: 'shell', detail: 'PRIVATE-TOOL' });
    appendEvent(session.id, 'text', { text: 'First ' }); appendEvent(session.id, 'text', { text: 'answer.\n' });
    appendEvent(session.id, 'question', { id: 'input', kind: 'input', question: 'Which file?' });
    appendEvent(session.id, 'question.answered', { id: 'input', answer: 'source.js' });
    appendEvent(session.id, 'question', { id: 'approval', kind: 'approval', question: 'PRIVATE-APPROVAL' });
    appendEvent(session.id, 'question.answered', { id: 'approval', answer: 'yes' });
    appendEvent(session.id, 'memory', { statement: 'PRIVATE-MEMORY' });
    appendEvent(session.id, 'backend', { params: { text: 'PRIVATE-REASONING' } });
    appendEvent(session.id, 'debate.result', { message: 'The earlier conclusion needs verification.' });
    session.conversationHandoff = { throughSeq: conversationCursor(session.id), pending: true };
    appendEvent(session.id, 'message.user', { text: 'Current message, once only' });
    assert.deepEqual(conversationMessages(session.id, session.conversationHandoff.throughSeq), [
      { role: 'user', content: '/goal Inspect this\nsecond line' },
      { role: 'assistant', content: 'First answer.\n' },
      { role: 'assistant', content: 'Which file?' },
      { role: 'user', content: 'source.js' },
      { role: 'assistant', content: 'The earlier conclusion needs verification.' },
    ]);
    const prompt = conversationPrompt(session, 'Current message, once only');
    assert.doesNotMatch(prompt, /PRIVATE-|"yes"/);
    assert.equal(prompt.split('Current message, once only').length, 2);
    completeConversationHandoff(session);
    assert.equal(loadSession(session.id).conversationHandoff.pending, false);
    assert.equal(conversationPrompt(session, 'Next message'), 'Next message');
  } finally {
    if (previous == null) delete process.env.BZZY_HOME; else process.env.BZZY_HOME = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
