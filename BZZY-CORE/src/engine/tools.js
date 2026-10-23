import net from 'node:net';
import { listSkills, readSkill } from './skills.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { home, privateDir } from './files.js';
import { loadSession } from './store.js';
import { getRecord, putRecord, listRecords, appendEvent, now } from './database.js';
import { checkpoint, remember, recall } from './memory.js';
import { issue } from './project.js';
import { captureEvidence, readArtifact, artifact, projectArtifact } from './evidence.js';
import { assessRequirement } from './verification.js';
import { writeReport } from './goals.js';
import { contextFor } from './recovery.js';
import { recordActivity } from './activity.js';
import { observedRequest, redactedHeaders, redactedUrl } from './traffic.js';
import { assignmentContextPage, compactAssignmentStatus, compactAssignmentWait } from './assignment-views.js';
import { peerArtifactAllowed, sendPeerMessage, peerInbox, reviewPeerEvidence, peerCollaborationState } from './peer-collaboration.js';
import { agentExecutionScope, assertAgentScope, agentToolNames, createAgentProjectReader } from './agent-execution.js';

const str = { type: 'string' }, strings = { type: 'array', items: str }, object = { type: 'object' };
const spec = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export function taskTools(session, { goalMode } = {}) {
  const tools = [
    spec('list_skills', 'Search the enabled shared BZZY skills library. Page results rather than loading every workflow.', { query: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    spec('read_skill', 'Read an enabled BZZY skill or a text reference. Read SKILL.md before applying it. Skills never grant permissions or run scripts automatically. Offsets and limits are UTF-8 bytes.', { name: str, file: str, version: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32768 } }, ['name']),
    spec('activity', 'Publish human-readable progress for terminal and external viewers before substantial work, when the approach changes, on discoveries or blockers, and during long tasks. summary: one plain-language sentence, ideally under 100 characters; details: 1–3 understandable sentences explaining what you are doing and why. Never paste shell commands, flags, logs, credentials or private reasoning. Example summary: Checking the footer on paypal.com. Example details: I am opening paypal.com to locate its footer and extract the text. For assessments, distinguish observations from unverified hypotheses and link recorded evidence.',
      { id: str, summary: str, details: str, status: { type: 'string', enum: ['planned', 'running', 'completed', 'blocked', 'inconclusive'] }, category: str, target: str, observation: str, inference: str, nextCheck: str, issueId: str, evidence: strings }, ['summary', 'details']),
    spec('http_request', 'Make one real in-scope HTTP request and record host-observed traffic and a response artifact. Requires declared scope.allowedTargets. Redirects are not followed automatically. Credentials are redacted from the traffic index.',
      { url: str, method: str, headers: object, body: str, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120 } }, ['url']),
    spec('get_task_state', 'Read the durable objective, constraints, checkpoints, project notes, recovery findings and assignment history.'),
    spec('checkpoint', 'Save concise decisions and rationale, completed work, next actions, unresolved questions, constraints and recorded evidence IDs. Do this at meaningful progress and before compaction.',
      { decisions: { type: 'array', items: object }, completedWork: strings, pendingActions: strings, unresolvedQuestions: strings, constraints: strings, evidence: strings }),
    spec('record_evidence', 'Copy a workspace file into immutable, hashed evidence. Return an artifact ID for claims and reviews.', { path: str, label: str }, ['path']),
    spec('read_artifact', 'Read a bounded slice of a recorded artifact. Opening worker evidence records supervisor inspection and imports it for parent assessments.',
      { id: str, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32768 } }, ['id']),
    spec('remember', 'Save project knowledge with explicit uncertainty. Observation/disproved entries require recorded evidence. Store concise rationale, never hidden chain-of-thought.',
      { kind: { type: 'string', enum: ['observation', 'hypothesis', 'experiment', 'failed_approach', 'conclusion', 'decision', 'inconclusive', 'disproved', 'blocked', 'question'] }, statement: str, rationale: str, evidence: strings, inputs: strings, revisitWhen: str, supersedes: str }, ['kind', 'statement']),
    spec('recall', 'Find dated project knowledge, with source references and stale-input flags.', { query: str, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
    spec('issue', 'Create/update a project assessment issue. Distinguish blocked, inconclusive, disproved and resolved; resolved/disproved require evidence.',
      { id: str, title: str, status: { type: 'string', enum: ['open', 'investigating', 'resolved', 'blocked', 'inconclusive', 'disproved'] }, details: str, resolution: str, evidence: strings }, ['title']),
  ];
  if (!['executor', 'reviewer'].includes(session.role)) tools.push(spec('assess_requirement', 'Assess a declared acceptance requirement using evidence you inspected. This is supervisor judgment; automated checks are also enforced before completion.',
    { id: str, status: { type: 'string', enum: ['supported', 'partial', 'unsupported', 'inconclusive'] }, rationale: str, evidence: strings }, ['id', 'status', 'rationale', 'evidence']));
  if (['executor', 'reviewer', 'peer'].includes(session.role)) tools.push(spec('finish_assignment', 'Return your bounded worker claim for supervisor review. This never completes the parent goal. Save full supporting evidence first.',
    { status: { type: 'string', enum: ['complete', 'partial', 'blocked', 'inconclusive'] }, summary: str, evidence: strings,
      verdict: { type: 'string', enum: ['real', 'false_positive', 'inconclusive'] }, nextSteps: strings, uncertainties: strings,
      objections: { type: 'array', items: object }, conclusions: strings, position: str, changedBecause: str, decision: object }, ['status', 'summary', 'evidence']));
  if (session.goal && goalMode !== false && !['executor', 'reviewer'].includes(session.role)) tools.push(
    spec('get_goal', 'Read the current persistent goal and usage.'),
    spec('update_goal', 'Report full completion with evidence, or the same genuine blocker across three turns. Host acceptance checks still apply.',
      { status: { type: 'string', enum: ['complete', 'blocked'] }, evidence: strings, blocker: str }, ['status', 'evidence']),
  );
  if (session.mode === 'delegate' && goalMode !== false && !['executor', 'reviewer'].includes(session.role)) tools.push(
    spec('delegate', 'Start the required bounded executor assignment before doing routine execution yourself, including small lookups, page retrieval and extraction. You retain strategy and final judgment. Persist a contract; wait efficiently; inspect evidence; accept, follow up or take over. Delegate goals require attempted and reviewed executor work before completion.',
      { requestId: str, objective: str, context: str, inputs: strings, evidence: { type: 'array', items: str, maxItems: 32, description: 'Recorded parent or inspected evidence IDs to share explicitly. Workers can read only these IDs and their own evidence.' }, constraints: strings, acceptanceCriteria: { type: 'array', items: { type: 'string' } }, artifacts: { type: 'array', items: object }, policy: object, limits: object,
        waitSeconds: { type: 'integer', minimum: 0, maximum: 30, description: 'Wait for the compact report within this call; default 20 seconds. Use 0 to start asynchronously.' } }, ['requestId', 'objective', 'context', 'acceptanceCriteria']),
    spec('list_assignments', 'List a bounded page of assignment IDs and compact statuses for this objective. Full reports are available through their reportArtifactId and read_artifact.', { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }),
    spec('assignment_status', 'Read a saved assignment report without invoking a model.', { id: str }, ['id']),
    spec('wait_assignment', 'Wait up to 30 seconds for a specific assignment round. Wait timeout never cancels the worker.', { id: str, round: { type: 'integer', minimum: 1 }, timeoutSeconds: { type: 'integer', minimum: 0, maximum: 30 } }, ['id']),
    spec('followup_assignment', 'Send a focused follow-up in the same worker conversation; preserve boundaries and full round history. Return the compact result after waiting, without a separate status call.', { id: str, requestId: str, feedback: str, objective: str,
      evidence: { type: 'array', items: str, maxItems: 32, description: 'Additional recorded evidence IDs to share. Existing selected evidence remains available; at most 32 distinct IDs per assignment.' },
      waitSeconds: { type: 'integer', minimum: 0, maximum: 30, description: 'Default 20 seconds; 0 starts asynchronously.' } }, ['id', 'requestId', 'feedback', 'objective']),
    spec('review_assignment', 'Close a finished assignment as accepted/inconclusive/abandoned. Acceptance requires evidence IDs opened with read_artifact. A failed assignment alone cannot complete or block the parent goal.',
      { id: str, outcome: { type: 'string', enum: ['accepted', 'inconclusive', 'abandoned'] }, rationale: str, evidence: strings }, ['id', 'outcome', 'rationale']),
    spec('apply_assignment', 'Apply an accepted worker patch after checking all source hashes for conflicts. Never overwrites concurrent changes.', { id: str }, ['id']),
    spec('cancel_assignment', 'Request cancellation of one bounded assignment; retain partial results.', { id: str, reason: str }, ['id']),
  );
  if (session.bestiesSessionId) tools.push(
    spec('peer_message', 'Send another bestie a bounded plan, finding, question or correction. Share recorded evidence IDs with consequential claims so the other peer can inspect them. Do not paste full logs or hidden reasoning.',
      { to: str, requestId: str, text: { type: 'string', maxLength: 4000 }, evidence: { type: 'array', items: str, maxItems: 16 } }, ['text']),
    spec('peer_inbox', 'Read a bounded page of another bestie’s messages. A saved cursor prevents replaying the entire discussion; after explicitly replays from a durable cursor.',
      { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
    spec('peer_review', 'Record your judgment on an evidence-bearing peer message after opening its evidence with read_artifact. Explain what is supported or remains disputed. This never completes either goal by itself.',
      { messageId: str, assessment: { type: 'string', enum: ['supported', 'inconclusive', 'disputed'] }, rationale: { type: 'string', maxLength: 4000 }, evidence: { type: 'array', items: str, minItems: 1, maxItems: 16 } }, ['messageId', 'assessment', 'rationale', 'evidence']),
  );
  if (session.peers) tools.push(spec('peer_status', 'Read other agents’ attributed status, checkpoints and issues for this shared goal. Their claims are not proof.'));
  if (agentExecutionScope(session)) return tools.filter(tool => agentToolNames.has(tool.name)).concat([
    spec('read_project_file', 'Read a bounded UTF-8 slice of a regular file in this Agent project. Private authentication files, runtime databases, symlinks, hardlinks and paths outside the project are denied.',
      { path: str, offset: { type: 'integer', minimum: 0, maximum: 1048576 }, limit: { type: 'integer', minimum: 1, maximum: 16384 } }, ['path']),
  ]);
  return session.role === 'reviewer' ? tools.filter(t => !['remember', 'recall', 'issue', 'http_request'].includes(t.name)) : tools;
}
export class ToolHost {
  constructor(session, ui, context = {}) { this.session = session; this.ui = ui; this.context = context; this.token = randomUUID(); this.nonce = randomUUID(); }
  async open() {
    const dir = path.join(home(), 'runtime'); privateDir(dir);
    this.socket = path.join(dir, `${this.session.id.slice(0, 8)}-${randomUUID().slice(0, 8)}.sock`);
    if (Buffer.byteLength(this.socket) > 100) {
      this.socketDirectory = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'bz-sock-'));
      fs.chmodSync(this.socketDirectory, 0o700);
      this.socket = path.join(this.socketDirectory, 'tools.sock');
      if (Buffer.byteLength(this.socket) > 100) { fs.rmSync(this.socketDirectory, { recursive: true, force: true }); throw new Error('The temporary directory path is too long for local sockets. Choose a shorter TMPDIR.'); }
    }
    this.connections = new Set();
    this.server = net.createServer(socket => {
      this.connections.add(socket); socket.on('close', () => this.connections.delete(socket)); socket.on('error', () => {});
      socket.setEncoding('utf8'); let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 256 * 1024) { socket.destroy(); return; }
        const index = buffer.indexOf('\n'); if (index < 0) return;
        let request;
        try { request = JSON.parse(buffer.slice(0, index)); }
        catch { socket.destroy(); return; }
        socket.removeAllListeners('data');
        const valid = typeof request.token === 'string' && Buffer.byteLength(request.token) === Buffer.byteLength(this.token) && timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token));
        if (!valid) { socket.end(JSON.stringify({ error: 'Invalid tool capability.' }) + '\n'); return; }
        Promise.resolve().then(() => request.method === 'list' ? taskTools(this.session, this.context) : this.call(request.name, request.arguments || {}))
          .then(result => socket.end(JSON.stringify({ result }) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
      });
    });
    try { await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socket, resolve); }); }
    catch (error) { await this.close(); throw error; }
    fs.chmodSync(this.socket, 0o600); return this;
  }
  async close() {
    this.projectReader?.close(); this.projectReader = null;
    for (const socket of this.connections || []) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.socket) fs.rmSync(this.socket, { force: true });
    if (this.socketDirectory) fs.rmSync(this.socketDirectory, { recursive: true, force: true });
  }
  async call(name, input) {
    const agentScope = agentExecutionScope(this.session);
    if (agentScope) {
      assertAgentScope(this.session, agentScope);
      if (!agentToolNames.has(name)) throw Object.assign(new Error('This tool is outside persistent Agent permissions.'), { code: 'FORBIDDEN' });
      if (name === 'read_project_file') {
        this.projectReader ||= createAgentProjectReader(this.session, agentScope);
        return this.projectReader.read(input);
      }
    }
    if (!taskTools(this.session, this.context).some(t => t.name === name)) throw new Error('Tool is not authorized for this task role or execution.');
    const session = this.session;
    appendEvent(session.id, 'coordination.tool', { name, input: name === 'http_request' ? { ...input, url: redactedUrl(input.url), headers: redactedHeaders(input.headers || {}), body: input.body ? '[body omitted]' : undefined } : input });
    if (name === 'list_skills') return listSkills({ ...input, enabledOnly: true });
    if (name === 'read_skill') return readSkill(input.name, { ...input, enabledOnly: true, sessionId: session.id });
    if (name === 'activity') { const record = recordActivity(session, input, this.ui); this.activityReporter?.explicit(record); return record; }
    if (name === 'http_request') { this.activityReporter?.tool(null, name, input); return observedRequest(session, input, this.ui); }
    if (name === 'get_task_state') return JSON.parse(contextFor(session));
    if (name === 'peer_message') return sendPeerMessage(session, input);
    if (name === 'peer_inbox') return peerInbox(session, input);
    if (name === 'peer_review') return reviewPeerEvidence(session, input);
    if (name === 'peer_status' && session.bestiesSessionId) return peerCollaborationState(session);
    if (name === 'peer_status') return (session.peers || []).map(peer => {
      const current = loadSession(peer.sessionId);
      return { ...peer, status: current?.goal?.status, executionState: current?.executionState, usage: current?.usage, checkpoint: getRecord('checkpoint', peer.sessionId),
        issues: listRecords('issue').filter(i => i.sessionId === peer.sessionId).slice(0, 30) };
    });
    if (name === 'get_goal') return loadSession(session.id).goal;
    if (name === 'update_goal') { writeReport(session.id, this.nonce, input); return 'Report recorded for acceptance assessment.'; }
    if (name === 'checkpoint') return checkpoint(session, input);
    if (name === 'remember') return remember(session, input);
    if (name === 'recall') return recall(session.projectRoot || session.cwd, input.query, input.limit);
    if (name === 'issue') return issue(session, input);
    if (name === 'record_evidence') return captureEvidence(session, input.path, input.label);
    if (name === 'assess_requirement') return assessRequirement(session, input, session.role);
    if (name === 'read_artifact') {
      const { item, job } = authorizedArtifact(session, input.id);
      const result = readArtifact(input.id, input.offset, input.limit);
      if (job || item.sessionId !== session.id) {
        putRecord('artifact-read', randomUUID(), { sessionId: session.id, assignmentId: job?.id || null, artifactId: input.id, offset: input.offset || 0, nextOffset: result.nextOffset, createdAt: now() });
        const key = `${session.id}:${item.id}:${item.sha256}`, previous = getRecord('artifact-import', key);
        let copy = previous && getRecord('artifact', previous.importedEvidenceId);
        if (!copy || !fs.existsSync(copy.path)) {
          copy = artifact(session, fs.readFileSync(item.path), `inspected-worker:${input.id}`, item.mediaType);
          Object.assign(copy, { importedFrom: item.id, importedSha256: item.sha256,
            ...(item.source ? { source: item.source, sourceWorkspace: item.sourceWorkspace, sourceSha256: item.sourceSha256 } : {}) });
          putRecord('artifact', copy.id, copy);
          putRecord('artifact-import', key, { sourceArtifactId: item.id, sourceSha256: item.sha256, importedEvidenceId: copy.id, sessionId: session.id });
        }
        result.importedEvidenceId = copy.id;
      }
      return result;
    }
    if (name === 'finish_assignment') {
      if (!['complete', 'partial', 'blocked', 'inconclusive'].includes(input.status) || !input.summary?.trim() || !Array.isArray(input.evidence)) throw new Error('Assignment report needs status, summary and evidence IDs.');
      if (input.evidence.some(id => getRecord('artifact', id)?.sessionId !== session.id)) throw new Error('Report evidence must belong to this worker session.');
      const report = { ...input, sessionId: session.id, reportedAt: now(), provenance: 'worker-claim' };
      putRecord('worker-report', session.id, report); return { recorded: true, requiresSupervisorReview: true };
    }
    const d = await import('./delegation.js');
    if (name === 'delegate') {
      const waitSeconds = assignmentWaitSeconds(input.waitSeconds), { waitSeconds: ignoredWait, ...assignmentInput } = input;
      if (input.evidence != null && (!Array.isArray(input.evidence) || input.evidence.length > 32 || input.evidence.some(id => typeof id !== 'string'))) throw new Error('Assignment evidence must contain at most 32 recorded artifact IDs.');
      const sharedEvidence = [...new Set(input.evidence || [])];
      for (const id of sharedEvidence) authorizedArtifact(session, id);
      const job = d.startAssignment(session, assignmentInput, { sharedEvidence });
      const waited = compactAssignmentWait(await d.waitAssignment(session.id, job.id, waitSeconds, job.currentRound));
      return { ...compactAssignmentStatus(d.assignmentStatus(job.id)), ...waited, state: waited.round.state, sharedEvidence, next: waited.terminal ? 'Inspect decisive evidence with read_artifact, then review_assignment.' : 'wait_assignment' };
    }
    if (name === 'list_assignments') {
      const offset = input.offset ?? 0, limit = input.limit ?? 10;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Assignment list needs a nonnegative offset and a limit of 1–20.');
      return assignmentContextPage(session, { offset, limit });
    }
    const job = d.assignmentStatus(input.id);
    if (job.parentSessionId !== session.id) throw new Error('Assignment belongs to another task.');
    if (name === 'assignment_status') return compactAssignmentStatus(job);
    if (name === 'wait_assignment') return compactAssignmentWait(await d.waitAssignment(session.id, input.id, input.timeoutSeconds, input.round));
    if (name === 'followup_assignment') {
      const waitSeconds = assignmentWaitSeconds(input.waitSeconds), { waitSeconds: ignoredWait, ...assignmentInput } = input;
      if (input.evidence != null && (!Array.isArray(input.evidence) || input.evidence.length > 32 || input.evidence.some(id => typeof id !== 'string'))) throw new Error('Assignment evidence must contain at most 32 recorded artifact IDs.');
      const sharedEvidence = input.evidence == null ? undefined : [...new Set([...(job.sharedEvidence || []), ...input.evidence])];
      if (sharedEvidence?.length > 32) throw new Error('An assignment can share at most 32 distinct evidence IDs; start a new bounded assignment for additional work.');
      for (const id of sharedEvidence || []) authorizedArtifact(session, id);
      const started = d.followupAssignment(session, input.id, assignmentInput, { sharedEvidence });
      return compactAssignmentWait(await d.waitAssignment(session.id, started.id, waitSeconds, started.round));
    }
    if (name === 'review_assignment') return d.reviewAssignment(session, input.id, input);
    if (name === 'apply_assignment') return d.applyAssignment(session, input.id);
    if (name === 'cancel_assignment') return d.cancelAssignment(session.id, input.id, input.reason);
    throw new Error('Unknown task tool.');
  }
}

function authorizedArtifact(session, id) {
  const item = getRecord('artifact', id) || projectArtifact(session.projectRoot || session.cwd, id);
  if (!item) throw new Error('Unknown artifact.');
  const job = listRecords('assignment').find(candidate => candidate.parentSessionId === session.id && candidate.workerSessionId === item.sessionId);
  const currentPeerEvidence = session.bestiesSessionId && session.peers?.some(peer => peer.sessionId !== session.id && peer.sessionId === item.sessionId);
  const projectHistory = !['executor', 'reviewer'].includes(session.role) && !currentPeerEvidence && item.projectRoot === (session.projectRoot || session.cwd);
  const peerGrant = session.bestiesSessionId && item.sessionId !== session.id && peerArtifactAllowed(session, id);
  if (item.sessionId !== session.id && !job && !session.allowedArtifactIds?.includes(id) && !projectHistory && !peerGrant) throw new Error('Artifact is outside this task and its assignments.');
  return { item, job };
}

function assignmentWaitSeconds(value = 20) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 30) throw new Error('waitSeconds must be an integer from 0 to 30.');
  return value;
}
export function bridgeRequest(socketPath, token, request) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); socket.setEncoding('utf8'); let buffer = '';
    socket.once('error', reject); socket.once('connect', () => socket.write(JSON.stringify({ token, ...request }) + '\n'));
    socket.on('data', chunk => { buffer += chunk; if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { socket.destroy(); reject(new Error('Tool response exceeds 2 MiB. Read bounded artifacts.')); } });
    socket.once('end', () => { try { const result = JSON.parse(buffer); result.error ? reject(new Error(result.error)) : resolve(result.result); } catch (error) { reject(error); } });
  });
}
export async function serveTaskBridge(socket, token) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line); if (request.id == null) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bzzy-tasks', version: '0.2.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools: await bridgeRequest(socket, token, { method: 'list' }) };
      else if (request.method === 'tools/call') {
        const data = await bridgeRequest(socket, token, { method: 'call', name: request.params.name, arguments: request.params.arguments });
        result = { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
      } else throw new Error('Unknown MCP method.');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch (error) { if (request?.id != null) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } }) + '\n'); }
  }
}
