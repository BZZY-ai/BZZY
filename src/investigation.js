import fs from 'node:fs';
import path from 'node:path';
import { startAssignment, assignmentStatus, delay } from './delegation.js';
import { getRecord, putRecord, digest, now } from './database.js';
import { fileInfo, artifact } from './evidence.js';

export async function investigate(session, choices, snapshot, options, ui, coordinator) {
  const pending = new Map(), reports = []; let next = 0;
  const concurrency = Math.min(session.contract.limits.concurrency, choices.length);
  ui.event('info', { message: `/goal ${session.goal.objective}\nPHASE 1 · Independent analysis and permitted tests · ${choices.length} agents` });
  ui.event('debate.phase', { phase: 'investigation', agents: choices, status: 'started' });
  while ((next < choices.length || pending.size) && !coordinator.stopping) {
    while (next < choices.length && pending.size < concurrency) {
      const index = next++, selection = choices[index];
      const job = startAssignment(session, { requestId: `investigate-${session.id}-${index}`, objective: session.goal.objective,
        context: `Independently investigate the selected material in BZZY_SELECTED_MATERIAL.txt and this workspace. Analyze the actual claim and run useful, bounded tests when permitted by the task policy and declared scope. Do not contact unlisted targets or use unspecified accounts. Do not inspect other agents' work during this independent phase. Preserve uncertainty: a failed test does not disprove a hypothesis. Save decisive files and test results using record_evidence. Return finish_assignment with status, summary, evidence, observations, testsPerformed, supportingClaims, objections, assumptions and missingVerification. Do not start a debate or claim the parent objective is satisfied. Source edits stay in your isolated workspace.`,
        acceptanceCriteria: ['Report actual analysis and permitted tests, cite recorded evidence, and identify what remains unverified.'],
        limits: { runtimeSeconds: Math.min(options.runtimeSeconds || 300, session.contract.limits.assignmentSeconds || 300) } },
      { executor: selection, snapshot, role: 'executor', allowDebate: true });
      pending.set(index, job.id);
      ui.event('info', { message: `${selection.provider} · independent investigation · assignment ${job.id}` });
    }
    for (const [index, id] of pending) {
      const job = assignmentStatus(id);
      if (['starting', 'running'].includes(job.round.state)) continue;
      const report = { participant: choices[index], assignmentId: id, state: job.round.state, error: job.round.error || job.latestReport?.stopReason || null, report: job.latestReport?.report || null, artifacts: job.latestReport?.artifacts || [], usage: job.latestReport?.usage || { available: false } };
      reports[index] = report; pending.delete(index);
      ui.event('debate.message', { participant: choices[index].provider, role: 'investigation', phase: 'investigation', text: report.report?.summary || `Investigation ended: ${job.round.state}. Evidence remains incomplete.` });
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
