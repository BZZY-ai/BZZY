import fs from 'node:fs';
import path from 'node:path';
import { startAssignment, assignmentStatus, delay } from './delegation.js';
import { getRecord, putRecord, digest, now } from './database.js';
import { fileInfo, artifact } from './evidence.js';
import { formatInvestigation } from './debate-format.js';

export function investigationReadiness(investigation, totalAgents, { sessionId } = {}) {
  const reports = investigation?.reports || [], required = Math.min(2, totalAgents);
  const usable = [], reasons = [];
  for (let index = 0; index < totalAgents; index++) {
    const entry = reports[index], label = entry?.participant?.provider || `agent ${index + 1}`;
    let reason;
    if (!entry) reason = 'no investigation result';
    else if (entry.state !== 'awaiting_review') reason = `ended ${entry.state}${entry.error ? `: ${String(entry.error).replace(/\s+/g, ' ').trim().slice(0, 500)}` : ''}`;
    else if (!entry.report) reason = 'returned no structured report';
    else if (!['complete', 'partial'].includes(entry.report.status)) reason = `${entry.report.status}: ${entry.report.summary}`;
    else if (!entry.report.evidence?.length) reason = `${entry.report.status} report cited no recorded evidence`;
    else {
      const imported = new Set(entry.artifacts?.flatMap(item => [item.id, item.originalId]).filter(Boolean));
      if (entry.report.evidence.some(id => !imported.has(id))) reason = 'report evidence was not preserved in the fixed bundle';
      if (!reason && sessionId) for (const id of entry.report.evidence) {
        const reference = entry.artifacts.find(item => item.id === id || item.originalId === id), copy = reference && getRecord('artifact', reference.id);
        try {
          if (!copy || copy.sessionId !== sessionId || copy.sha256 !== reference.sha256 || fileInfo(copy.path).sha256 !== copy.sha256) { reason = 'preserved investigation evidence failed its scope or integrity check'; break; }
        } catch { reason = 'preserved investigation evidence is unavailable'; break; }
      }
    }
    if (reason) reasons.push(`${label}: ${reason}`); else usable.push(entry);
  }
  return { passed: usable.length >= required, required, usable: usable.length, total: totalAgents, reasons };
}

export function investigationConsensus(investigation, totalAgents) {
  const reports = investigation?.reports || [], required = Math.floor(totalAgents / 2) + 1;
  const votes = reports.map((entry, index) => {
    const verdict = entry?.report?.verdict;
    const imported = new Set(entry?.artifacts?.flatMap(item => [item.id, item.originalId]).filter(Boolean));
    const evidence = entry?.report?.evidence || [];
    const counted = entry?.state === 'awaiting_review' && entry.report?.status === 'complete' && ['real', 'false_positive'].includes(verdict)
      && evidence.length > 0 && evidence.every(id => imported.has(id));
    return { index, provider: entry?.participant?.provider || `agent ${index + 1}`, verdict: counted ? verdict : null,
      reportedVerdict: verdict || null, state: entry?.state || 'missing', status: entry?.report?.status || null, counted };
  });
  const counts = { real: votes.filter(vote => vote.verdict === 'real').length, false_positive: votes.filter(vote => vote.verdict === 'false_positive').length };
  const verdict = counts.real >= required ? 'real' : counts.false_positive >= required ? 'false_positive' : null;
  return { reached: Boolean(verdict), verdict, required, total: totalAgents, counts, votes, assessmentOnly: true, maySkipChallenge: false };
}

export async function investigate(session, choices, snapshot, options, ui, coordinator) {
  const pending = new Map(), reports = []; let next = 0;
  const concurrency = Math.min(session.contract.limits.concurrency, choices.length);
  ui.event('info', { message: `PHASE 1 · Independent analysis and permitted tests · ${choices.length} agents` });
  ui.event('debate.phase', { phase: 'investigation', agents: choices, status: 'started' });
  while ((next < choices.length || pending.size) && !coordinator.stopping) {
    while (next < choices.length && pending.size < concurrency) {
      const index = next++, selection = choices[index];
      const job = startAssignment(session, { requestId: `investigate-${session.id}-${index}`, objective: session.goal.objective,
        context: `Independently investigate the ORIGINAL user goal, acceptance conditions, achieved-goal claim and ALL its original evidence in BZZY_SELECTED_MATERIAL.txt and the immutable mission brief. Read every original source evidence artifact with read_artifact, paginating until complete; identify missing ranges rather than silently substituting a summary. Start by locating and reading relevant workspace files. When the selected material contains only the goal, the workspace is supplied material; absence of --artifact is not missing context. Analyze the actual vulnerability and claimed impact/severity separately: a real low-impact issue does not satisfy a HIGH-severity goal. Run useful, bounded re-tests only when permitted by the inherited task policy and original declared scope. Do not contact unlisted targets, use unspecified accounts or inspect other agents' work during this independent phase. Preserve uncertainty: a failed test does not disprove a hypothesis. Save decisive files and test results using record_evidence. Use status complete when recorded evidence supports a real/false-positive classification, partial when it supports only part, and inconclusive when it cannot classify the claim. Set verdict real, false_positive or inconclusive; matching votes describe agreement and never replace adversarial challenge or original-goal verification. Return finish_assignment with status, verdict, summary, evidence, objections with stable IDs, conclusions, position and uncertainties. Do not start a debate or claim the parent objective is satisfied. Source edits stay in your isolated workspace.`,
        acceptanceCriteria: ['Report actual analysis and permitted tests, cite recorded evidence, and identify what remains unverified.'],
        limits: { runtimeSeconds: Math.min(options.runtimeSeconds || 300, session.contract.limits.assignmentSeconds || 300) } },
      { executor: selection, snapshot, role: 'executor', allowDebate: true, independent: true, sharedEvidence: session.reviewSource?.evidenceIds || [] });
      pending.set(index, job.id);
      ui.event('info', { message: `${selection.provider} · independent investigation · assignment ${job.id}` });
    }
    for (const [index, id] of pending) {
      const job = assignmentStatus(id);
      if (['starting', 'running'].includes(job.round.state)) continue;
      const report = { participant: choices[index], assignmentId: id, state: job.round.state, error: job.round.error || job.latestReport?.stopReason || null, report: job.latestReport?.report || null, artifacts: job.latestReport?.artifacts || [], usage: job.latestReport?.usage || { available: false } };
      reports[index] = report; pending.delete(index);
      ui.event('debate.message', { participant: choices[index].provider, role: 'investigation', phase: 'investigation', assignmentId: id,
        state: report.state, error: report.error, text: formatInvestigation(report) });
    }
    const agents = reports.filter(Boolean).map(report => ({ ...report.participant, role: 'investigation', assignmentId: report.assignmentId, tokens: report.usage.tokens ?? null, available: Boolean(report.usage.available) }));
    coordinator.checkBudget(agents.reduce((sum, agent) => sum + (agent.tokens || 0), 0));
    if (next < choices.length || pending.size) await delay(100);
  }
  const bundle = path.join(snapshot.directory, 'BZZY_INVESTIGATION_EVIDENCE');
  if (fs.existsSync(bundle)) throw new Error('Reserved investigation evidence path already exists.');
  fs.mkdirSync(bundle, { mode: 0o700 });
  const evidenceIndex = []; let bytes = 0;
  for (const [index, report] of reports.entries()) {
    if (!report) continue;
    const entry = { ...report, artifacts: [] };
    for (const [number, reference] of report.artifacts.entries()) {
      const item = getRecord('artifact', reference.id);
      if (!item) throw new Error('Investigation artifact is missing from the evidence store.');
      if (bytes + item.size > 50 * 1024 * 1024) { entry.artifacts.push({ id: item.id, omitted: 'Evidence bundle limit reached; the original artifact remains available.' }); continue; }
      const info = fileInfo(item.path);
      if (info.sha256 !== item.sha256) throw new Error('Investigation artifact changed after recording.');
      const relative = `BZZY_INVESTIGATION_EVIDENCE/agent-${index + 1}-${number + 1}.txt`;
      fs.copyFileSync(item.path, path.join(snapshot.directory, relative));
      snapshot.manifest[relative] = { size: info.size, sha256: info.sha256 }; bytes += info.size;
      const imported = artifact(session, fs.readFileSync(item.path), `investigation:${report.participant.provider}:${item.label}`, item.mediaType);
      Object.assign(imported, { importedFrom: item.id, importedSha256: item.sha256,
        ...(item.source ? { source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 } : {}) }); putRecord('artifact', imported.id, imported);
      entry.artifacts.push({ id: imported.id, originalId: item.id, path: relative, sha256: item.sha256, label: item.label });
    }
    evidenceIndex.push(entry);
  }
  const indexPath = 'BZZY_INVESTIGATION_REPORTS.json', content = JSON.stringify(evidenceIndex, null, 2);
  fs.writeFileSync(path.join(snapshot.directory, indexPath), content, { mode: 0o600 });
  snapshot.manifest[indexPath] = { size: Buffer.byteLength(content), sha256: digest(content) };
  snapshot.manifestHash = digest(snapshot.manifest); putRecord('snapshot', snapshot.id, snapshot);
  const result = { reports: evidenceIndex, snapshotHash: snapshot.manifestHash, createdAt: now(), independent: true, testsAreAgentReported: true };
  putRecord('debate-investigation', session.id, result);
  ui.event('debate.phase', { phase: 'investigation', status: 'finished', snapshotHash: snapshot.manifestHash });
  return reports.filter(Boolean).map(report => ({ ...report.participant, role: 'investigation', assignmentId: report.assignmentId, tokens: report.usage.tokens ?? null, available: Boolean(report.usage.available) }));
}
