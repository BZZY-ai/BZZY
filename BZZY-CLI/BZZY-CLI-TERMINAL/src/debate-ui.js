import { clean, clip, wrapProse } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { fillSurface } from './terminal-surface.js';
import { parseMessageBody } from '@bzzy/core/message-format';
import { renderMessageContent } from './message-renderer.js';

// Colors belong to participant slots, never to a provider or model name.
const participantTones = [palette.agent, palette.goalSuccess, palette.warning, palette.accent, palette.goalActive, palette.yolo];
export const debateParticipantTone = index => participantTones[index % participantTones.length];

export function recordDebateEvent(entries, type, data) {
  const id = data.debateId || data.reviewSessionId;
  let entry = id ? entries.find(item => item.kind === 'debate' && item.debateId === id)
    : entries.findLast(item => item.kind === 'debate' && !item.result);
  let created = false;
  if (!entry) {
    entry = { kind: 'debate', text: '', debateId: id || `legacy-debate-${entries.length}`, title: '', expanded: false,
      participants: [], messages: [], phase: '', result: null, revision: 0 };
    entries.push(entry); created = true;
  }
  entry.revision++;
  if (data.title || data.objective) entry.title = clean(data.title || data.objective);
  for (const [index, participant] of (data.participants || data.agents || []).entries()) registerParticipant(entry, participant, index);
  if (type === 'debate.phase' || type === 'debate.started') {
    entry.phase = clean(data.phase || (type === 'debate.started' ? 'starting' : entry.phase));
    entry.phaseStatus = clean(data.status || 'started');
  } else if (type === 'debate.message') {
    const participant = messageParticipant(entry, data);
    const key = data.messageId || JSON.stringify([data.assignmentId || participant.id, data.phase || '', data.role || '', data.round || 0]);
    const message = { key, participantId: participant.id, role: clean(data.role || data.phase || 'review'), round: Number.isSafeInteger(data.round) ? data.round : null,
      maxRounds: Number.isSafeInteger(data.maxRounds) ? data.maxRounds : null, text: String(data.text ?? ''), state: clean(data.state || '') };
    message.label = participantLabel({ ...participant, provider: clean(data.provider || participant.provider), model: clean(data.model || participant.model) });
    message.copyEntry = { kind: 'assistant', text: message.text, label: message.label + ' · ' + message.role };
    const previous = entry.messages.findIndex(item => item.key === key);
    if (previous < 0) entry.messages.push(message); else entry.messages[previous] = message;
    entry.phase = message.role;
  } else if (type === 'debate.result') {
    entry.result = { ...data };
    entry.result.copyEntry = { kind: 'assistant', text: resultBody(data), label: 'Validation consensus' };
  }
  return { entry, created };
}

function registerParticipant(entry, source, index) {
  const data = typeof source === 'string' ? { provider: source } : source || {};
  const slot = Number.isSafeInteger(data.index) ? data.index : Number.isSafeInteger(data.participantIndex) ? data.participantIndex : index;
  const id = String(data.id || data.participantId || `slot:${slot}`);
  let participant = entry.participants.find(item => item.id === id || item.index === slot);
  if (!participant) { participant = { id, index: slot }; entry.participants.push(participant); }
  Object.assign(participant, { provider: clean(data.provider || participant.provider || ''), model: clean(data.model || participant.model || ''),
    label: clean(data.label || participant.label || '') });
  entry.participants.sort((a, b) => a.index - b.index);
  return participant;
}

function messageParticipant(entry, data) {
  const object = typeof data.participant === 'object' ? data.participant : {};
  const provider = data.provider || object.provider || (typeof data.participant === 'string' ? data.participant : '');
  const id = data.participantId || object.id;
  const index = data.participantIndex ?? object.index;
  let participant = id ? entry.participants.find(item => item.id === id) : Number.isSafeInteger(index) ? entry.participants.find(item => item.index === index) : null;
  if (!participant && !id && !Number.isSafeInteger(index)) {
    const matching = entry.participants.filter(item => item.provider === provider);
    participant = matching.length === 1 ? matching[0] : entry.participants.find(item => item.assignments?.includes(data.assignmentId));
    if (!participant && /^main\b/.test(data.role || '')) participant = entry.participants.find(item => item.index === 0);
  }
  participant ||= registerParticipant(entry, { ...object, id: id || (Number.isSafeInteger(index) ? `slot:${index}` : data.assignmentId || undefined),
    index: Number.isSafeInteger(index) ? index : entry.participants.length, provider, model: data.model || object.model }, entry.participants.length);
  if (data.assignmentId) { participant.assignments ||= []; if (!participant.assignments.includes(data.assignmentId)) participant.assignments.push(data.assignmentId); }
  return participant;
}

const participantLabel = participant => `Agent ${participant.index + 1}${participant.label && participant.label !== `Agent ${participant.index + 1}` ? ' · ' + participant.label : ''}${participant.provider ? ' · ' + participant.provider : ''}${participant.model ? ' · ' + participant.model : ''}`;
const resolvedResult = result => result?.status === 'complete' && !result.unresolvedDisagreement?.length && !result.decision?.remainingObjections?.length
  && !['unsupported', 'inconclusive'].includes(result.goalSatisfaction);

function resultBody(result) {
  if (result.message) return String(result.message);
  const parts = [];
  for (const [key, label] of [['acceptedConclusions', 'Accepted conclusions'], ['rejectedClaims', 'Rejected claims'], ['corrections', 'Corrections'],
    ['remainingObjections', 'Remaining objections'], ['nextVerificationSteps', 'Next verification steps']]) {
    const values = result.decision?.[key];
    if (Array.isArray(values) && values.length) parts.push(label + '\n' + values.map(item => '• ' + (typeof item === 'string' ? item : JSON.stringify(item))).join('\n'));
  }
  if (Array.isArray(result.unresolvedDisagreement) && result.unresolvedDisagreement.length)
    parts.push('Unresolved disagreement\n' + result.unresolvedDisagreement.map(item => '• ' + item).join('\n'));
  return parts.join('\n\n') || 'The review returned no conclusion.';
}

export function debateEntryLayout(entry, width, theme) {
  const lines = [], hits = [], color = theme.color;
  const put = (text, tone = palette.text, bold = false) => lines.push(color(clip(text, width), tone, bold));
  const state = entry.result ? resolvedResult(entry.result) ? 'finished' : 'needs review' : (entry.phase || 'starting').replaceAll('_', ' ');
  const caption = `${entry.expanded ? '▾' : '▸'} VALIDATE · ${entry.participants.length} agents · ${entry.messages.length} messages · ${state}`;
  hits.push({ type: 'debate-toggle', entry, row: lines.length, left: 3, right: width - 1 });
  put('  ╭─ ' + caption, palette.accent, true);
  if (entry.title) put('  │ ' + entry.title, palette.muted);
  const legendWidth = Math.max(8, Math.floor((width - 6) / Math.max(1, entry.participants.length)) - 2);
  if (width < entry.participants.length * 10 + 6) {
    for (const participant of entry.participants) put('  │ ● ' + participantLabel(participant), debateParticipantTone(participant.index), true);
  } else {
    let legend = color('  │ ', palette.border);
    for (const participant of entry.participants)
      legend += color(clip('● ' + participantLabel(participant), legendWidth), debateParticipantTone(participant.index), true) + '  ';
    if (entry.participants.length) lines.push(legend);
  }
  if (entry.expanded) {
    for (const message of entry.messages) {
      const participant = entry.participants.find(item => item.id === message.participantId);
      const tone = debateParticipantTone(participant?.index || 0);
      const label = `${message.label || (participant ? participantLabel(participant) : 'Agent')} · ${message.role}${message.round ? ` · round ${message.round}${message.maxRounds ? '/' + message.maxRounds : ''}` : ''}`;
      put('  │ ' + label, tone, true);
      const projection = parseMessageBody(message.text);
      const body = projection.isFormatted ? renderMessageContent(projection, { width: Math.max(1, width - 9), theme, background: palette.agentSurface }).lines
        : wrapProse(clean(projection.plainText), Math.max(1, width - 9));
      for (const line of body) {
        hits.push({ type: 'response', entry: message.copyEntry, row: lines.length, left: 5, right: width - 2 });
        lines.push(color('  │ ▎ ', tone) + fillSurface(line, Math.max(1, width - 8), theme, palette.agentSurface, palette.text));
      }
      put('  │', palette.border);
    }
    if (!entry.messages.length) put('  │ Waiting for participant responses…', palette.muted);
  }
  put('  ╰─ ' + (entry.expanded ? 'Click to collapse · Esc closes' : 'Click to expand') + ' · Ctrl+B latest validation', palette.muted);
  if (entry.result) {
    const status = resolvedResult(entry.result) ? 'Review complete' : 'Needs review';
    const satisfaction = ['supported', 'unsupported', 'inconclusive'].includes(entry.result.goalSatisfaction) ? ` · goal ${entry.result.goalSatisfaction}` : '';
    put(''); put('  CONSENSUS · ' + status + satisfaction, resolvedResult(entry.result) ? palette.goalSuccess : palette.warning, true);
    const body = resultBody(entry.result), projection = parseMessageBody(body);
    const rendered = projection.isFormatted ? renderMessageContent(projection, { width: Math.max(1, width - 7), theme, background: palette.agentSurface }).lines
      : wrapProse(clean(projection.plainText), Math.max(1, width - 7));
    for (const line of rendered) {
      hits.push({ type: 'response', entry: entry.result.copyEntry, row: lines.length, left: 3, right: width - 2 });
      lines.push(color('  ▎ ', palette.agent) + fillSurface(line, Math.max(1, width - 6), theme, palette.agentSurface, palette.text));
    }
    const missingObjections = (entry.result.unresolvedDisagreement || []).filter(item => !projection.plainText.includes(String(item)));
    if (missingObjections.length) {
      put('  Unresolved objections', palette.warning, true);
      for (const item of missingObjections) for (const line of wrapProse('• ' + clean(String(item)), Math.max(1, width - 5))) put('  ' + line);
    }
  }
  put('');
  return { lines, hits };
}
