const describe = item => typeof item === 'string' ? item : item?.claim || item?.summary || item?.description || JSON.stringify(item);

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
