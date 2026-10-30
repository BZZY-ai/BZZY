import { database, getRecord } from './database.js';
import { diagnosticRedactor } from './diagnostic-redaction.js';
import { sanitizedTaskPreview } from './assignment-task.js';

// Produced even when the worker never calls finish_assignment. This receipt
// describes observed work; it deliberately cannot supply a worker verdict.
export function assignmentHandoff(job, worker, round, result = {}) {
  if (!worker || worker.assignmentId !== job.id || worker.parentSessionId !== job.parentSessionId || worker.assignmentRound !== round) return null;
  const rows = database().prepare(`SELECT id,json_extract(data,'$.sourceSeq') AS sourceSeq,
    json_extract(data,'$.outcome') AS outcome,json_extract(data,'$.name') AS name,
    json_extract(data,'$.exitCode') AS exitCode,json_extract(data,'$.summary') AS summary
    FROM records WHERE kind='core.episode.observation' AND json_extract(data,'$.sessionId')=?
    AND json_extract(data,'$.assignmentId')=? AND json_extract(data,'$.assignmentRound')=?
    ORDER BY updated_at DESC,id LIMIT 17`).all(worker.id, job.id, round);
  const checkpoint = getRecord('checkpoint', worker.id);
  const own = checkpoint?.scope?.assignmentId === job.id && checkpoint.scope.assignmentRound === round ? checkpoint : null;
  const { scrub } = diagnosticRedactor({ roots: [worker.cwd, worker.projectRoot], maxString: 320, maxItems: 16 });
  // Sanitize whole logical values before excerpting. Keep a real byte ceiling
  // as well as per-field bounds, including multi-byte text and legacy lists.
  const lines = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 6) : [];
  const remaining = lines(result.report?.nextSteps).length ? lines(result.report.nextSteps) : lines(own?.pendingActions);
  const receipt = scrub({ version: 1, provenance: 'host-partial-handoff', assignmentId: job.id, round,
    workerSessionId: worker.id, parentSessionId: job.parentSessionId,
    task: sanitizedTaskPreview(getRecord('round', `${job.id}:${round}`)?.objective || job.contract?.objective),
    state: 'incomplete', stopReason: result.stopReason || worker.stopReason || 'worker-ended', missingReport: !result.report,
    attempts: rows.slice(0,16), moreAttempts: rows.length > 16,
    checkpoint: own ? { revision: own.revision, decisions: lines(own.decisions), completedWork: lines(own.completedWork),
      pendingActions: lines(own.pendingActions), unresolvedQuestions: lines(own.unresolvedQuestions) } : null,
    artifacts: (result.artifacts || []).slice(0,12).map(item => ({ id:item.id, label:item.label, sha256:item.sha256 })),
    changedPaths: (result.changes || []).slice(0,12).map(item => item.path),
    artifactScope: 'Worker-session evidence; artifacts may originate in earlier rounds. Inspect their source records before use.',
    remainingChecks: remaining.length ? remaining : ['Not fully recorded. Inspect saved evidence and the original assignment before continuing.'],
    authority: 'Host observations and attributed worker progress only. Missing checks remain unknown; this is not a structured worker report, verified finding or permission to retry.' });
  const lists = [receipt.changedPaths, receipt.checkpoint?.decisions, receipt.checkpoint?.completedWork,
    receipt.checkpoint?.pendingActions, receipt.checkpoint?.unresolvedQuestions, receipt.attempts, receipt.artifacts, receipt.remainingChecks].filter(Array.isArray);
  while (Buffer.byteLength(JSON.stringify(receipt)) > 8192) {
    const largest = lists.filter(items => items.length > 1).sort((a, b) => Buffer.byteLength(JSON.stringify(b)) - Buffer.byteLength(JSON.stringify(a)))[0];
    if (largest) { largest.pop(); receipt.omittedDetails = true; continue; }
    // Pathological source strings can still exceed the envelope with one item
    // per field. Their full records remain available through the source IDs.
    receipt.checkpoint = own ? { revision: own.revision, details: 'Open the worker checkpoint record.' } : null;
    receipt.changedPaths = []; receipt.attempts = receipt.attempts.slice(0, 1); receipt.artifacts = receipt.artifacts.slice(0, 1);
    receipt.omittedDetails = true;
    break;
  }
  return receipt;
}
