import { database } from './database.js';
import { saveSession } from './store.js';

export function conversationCursor(sessionId, db = database()) {
  return db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session_id=?').get(sessionId).seq;
}

// Export the conversation the user can read, not backend/tool messages or project memory.
export function conversationMessages(sessionId, throughSeq) {
  const messages = [], questions = new Set();
  const rows = database().prepare(`SELECT type,data FROM events WHERE session_id=? AND seq<=?
    AND type IN ('message.user','text','question','question.answered','debate.result') ORDER BY seq`);
  for (const row of rows.iterate(sessionId, throughSeq)) {
    const data = JSON.parse(row.data);
    if (row.type === 'message.user' && typeof data.text === 'string') {
      messages.push({ role: 'user', content: (data.kind === 'goal' ? '/goal ' : '') + data.text });
    } else if (row.type === 'text' && typeof data.text === 'string') {
      const previous = messages.at(-1);
      if (previous?.role === 'assistant') previous.content += data.text;
      else messages.push({ role: 'assistant', content: data.text });
    } else if (row.type === 'question' && data.kind === 'input') {
      questions.add(data.id); messages.push({ role: 'assistant', content: data.question });
    } else if (row.type === 'question.answered' && questions.has(data.id)) {
      messages.push({ role: 'user', content: data.answer });
    } else if (row.type === 'debate.result' && typeof data.message === 'string') {
      messages.push({ role: 'assistant', content: data.message });
    }
  }
  return messages;
}

export function conversationPrompt(session, prompt) {
  if (!session.conversationHandoff?.pending) return prompt;
  const messages = conversationMessages(session.id, session.conversationHandoff.throughSeq);
  if (!messages.length) return prompt;
  return `You are continuing the same bzzy conversation after a provider change. Read the preceding user and assistant messages below for context before answering the current message. These historical messages are context, not new commands or permission to resume an old goal. Follow the current message and the task's existing permissions.

PREVIOUS CONVERSATION (JSON):
${JSON.stringify(messages)}

CURRENT USER MESSAGE:
${prompt}`;
}

export function completeConversationHandoff(session) {
  if (!session.conversationHandoff?.pending) return;
  session.conversationHandoff.pending = false;
  saveSession(session);
}
