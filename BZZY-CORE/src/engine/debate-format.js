const describe = item => typeof item === 'string' ? item : item?.claim || item?.summary || item?.description || JSON.stringify(item);

const concise = value => String(value || '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);

export function formatInvestigation(report) {
  const summary = report?.report?.summary?.trim();
  const state = report?.state || 'incomplete';
  const failed = !['awaiting_review', 'complete'].includes(state);
  if (!failed && summary) return summary;
  const message = summary
    ? `${summary}\nInvestigation ended: ${state}.`
    : `Investigation ended: ${state}. Evidence remains incomplete.`;
  const reason = concise(report?.error);
  return reason ? `${message}\nReason: ${reason}` : message;
}

export function assessObjectionDispositions(reports, decision) {
  const objections = reports.flatMap(item => item.report?.objections || []);
  const ids = [...new Set(objections.map(item => typeof item === 'string' ? item : item?.id).filter(Boolean))];
  const dispositions = Array.isArray(decision?.objectionDispositions) ? decision.objectionDispositions : [];
  const byId = new Map(dispositions.filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
  const missing = ids.filter(id => !byId.has(id));
  const invalid = dispositions.filter(item => !item || typeof item.id !== 'string' || !['accepted', 'resolved', 'rejected', 'unresolved'].includes(item.status));
  const unresolved = [...new Set([
    ...(decision?.remainingObjections || []).map(describe),
    ...dispositions.filter(item => item?.status === 'unresolved').map(item => item.id),
    ...missing.map(id => `${id}: no main-agent disposition`),
  ])];
  return { complete: missing.length === 0 && invalid.length === 0, objectionCount: ids.length, missing, invalid: invalid.length, unresolved };
}

export function formatPosition(report) {
  if (!report) return 'No complete report was returned; this assessment remains unresolved.';
  const objections = (report.objections || []).map(item => typeof item === 'string' ? item : `${item.id || 'objection'}: ${describe(item)}`);
  return [report.summary, report.position, ...objections.map(item => '• ' + item)].filter(Boolean).join('\n');
}

export function formatDecision(decision, unresolved = []) {
  if (!decision) return 'No final decision was returned. Review the partial evidence before continuing.';
  const lines = [];
  for (const [key, label] of [['acceptedConclusions', 'Supported'], ['rejectedClaims', 'Rejected'], ['corrections', 'Corrections'], ['remainingObjections', 'Unresolved'], ['nextVerificationSteps', 'Next verification']]) {
    const items = key === 'remainingObjections' ? [...new Set([...(decision[key] || []).map(describe), ...unresolved.map(describe)])] : (decision[key] || []).map(describe);
    if (items.length) lines.push(`${label}:`, ...items.map(item => `• ${item}`));
  }
  return lines.join('\n') || 'No additional conclusions or verification steps were recorded.';
}
