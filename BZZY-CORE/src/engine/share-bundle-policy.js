import fs from 'node:fs';
import path from 'node:path';
import { getProvider } from './providers.js';
import { home } from './files.js';

export const sharedKinds = new Set(['session', 'acceptance', 'activity', 'artifact', 'artifact-import', 'artifact-read',
  'assessment', 'assignment', 'assignment-apply', 'besties', 'besties-result', 'checkpoint', 'conversation-debate',
  'debate', 'debate-investigation', 'debate-opening', 'debate-round', 'execution', 'goal-event', 'goal-history',
  'issue', 'memory', 'operation', 'parallel', 'parallel-result', 'peer-cursor', 'peer-message', 'peer-review',
  'question', 'recovery', 'review', 'round', 'run', 'skill', 'snapshot', 'traffic', 'worker-report',
  'core.memory.revision', 'core.issue.revision', 'core.checkpoint.revision']);
const privateField = /^(?:token|nonce|accessToken|refreshToken|ownerToken|apiKey|password|authorization|cookie|set-cookie|credentials|privateKey|signingSecret|boxSecret|environment|backendHomes|engineHome|backendProcess|runner|launcher|notifications|notificationDestinations|inputOwner|coreGrantId|accountBinding|accountBindings|privateContext)$/i;
const privateSuffix = /(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)$/;
const workflowAuthorityField = /^(?:workflowAdmission|workflowSelection|workflowBinding|goalWorkflow|workflowReceipt|workflowPin|subagentRouting)$/i;
// These snapshots belong to the sender's native process and event sequence.
// They are rebuilt locally, never resumed from a project/Library package.
const nativeRuntimeAuthorityField = /^(?:nativeContext|nativeContextBudget|nativeBackendReadiness|contextEfficiency|coreSkillsProtocol|sessionMemoryRefresh|sessionMemorySeen|workerBudgetPolicy|workerBudget|workerBudgetSettings)$/i;
const secretPattern = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[a-zA-Z0-9_-]{16,}|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;
export const SHARE_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, fileBytes: 64 * 1024 * 1024, entries: 50000, records: 50000, events: 100000 });

export function sharedSecrets() {
  const found = Object.entries(process.env).filter(([key]) => /(?:API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)).map(([, value]) => value);
  const file = path.join(home(), 'credentials.json');
  if (fs.existsSync(file)) {
    const values = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(values) : [];
    found.push(...values(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  return [...new Set(found.filter(value => typeof value === 'string' && value.length >= 12))];
}
export function assertShareText(value, secrets = []) {
  if (secretPattern.test(value) || secrets.some(secret => value.includes(secret))) throw new Error('Sharing blocked: selected context contains a credential. Remove it from project/history before sharing.');
}

// Kept under its original public name for bundle compatibility. Workflow text
// and diagnostic events may remain history; host admission and native process
// state cannot travel with a project or acquire recipient runtime authority.
export function stripWorkflowAuthority(value) {
  if (Array.isArray(value)) return value.map(stripWorkflowAuthority);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !workflowAuthorityField.test(key) && !nativeRuntimeAuthorityField.test(key))
    .map(([key, item]) => [key, stripWorkflowAuthority(item)]));
}
export function portableState(state) {
  if (state.records.length > SHARE_LIMITS.records || state.events.length > SHARE_LIMITS.events) throw new Error('The selected project context exceeds sharing limits.');
  const clean = value => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key) && !privateSuffix.test(key) && !workflowAuthorityField.test(key) && !nativeRuntimeAuthorityField.test(key)).map(([key, item]) => [key, clean(item)]));
  };
  const result = clean({ records: state.records.filter(row => sharedKinds.has(row.kind)), events: state.events });
  // Imported history is data; never transfer executable host authority.
  for (const row of result.records) if (row.kind === 'session') {
    delete row.data.backendHomes; delete row.data.engineHome;
    delete row.data.yolo; delete row.data.policy; delete row.data.toolBindings;
    if (row.data.contract) delete row.data.contract.policy;
    row.data.importedUntrusted = true;
  }
  return result;
}

export function validateSharedManifest(manifest, { kind = 'TERMINAL' } = {}) {
  if (manifest?.sharing?.version !== 1 || manifest.format !== 'bzzy-project' || manifest.version !== 1 ||
    !Array.isArray(manifest.records) || !Array.isArray(manifest.events) || manifest.records.length > SHARE_LIMITS.records || manifest.events.length > SHARE_LIMITS.events) throw new Error('Not a supported complete-context BZZY share.');
  if ((manifest.sharing.kind || 'TERMINAL') !== kind || !['TERMINAL', 'AGENT'].includes(kind)) throw new Error('The shared package has the wrong product kind.');
  if (kind === 'AGENT') {
    const agent = manifest.agent;
    if (!agent || Object.keys(agent).some(key => !['id', 'name', 'instructions'].includes(key)) ||
      !/^[a-f0-9-]{36}$/.test(agent.id) || typeof agent.name !== 'string' || !agent.name.trim() || Buffer.byteLength(agent.name) > 120 || /[\r\n\t\x00-\x1f\x7f-\x9f]/u.test(agent.name) ||
      typeof agent.instructions !== 'string' || !agent.instructions.trim() || Buffer.byteLength(agent.instructions) > 16000 || /[\x00\x7f-\x9f]/u.test(agent.instructions)) throw new Error('Invalid portable agent definition.');
  } else if (manifest.agent !== undefined) throw new Error('A terminal package cannot install an agent.');
  for (const row of manifest.records) {
    if (!sharedKinds.has(row.kind) || !row.data || typeof row.data !== 'object' || Array.isArray(row.data)) throw new Error('Shared project contains unsupported host state.');
    if (row.kind === 'session' && kind === 'TERMINAL') {
      let provider;
      try { provider = getProvider(row.data.provider); } catch { /* never install sender provider endpoints */ }
      if (!provider || provider.backend !== row.data.backend) throw new Error('Configure the shared project’s provider locally before importing. Provider accounts/settings are never imported.');
    }
  }
  const cleaned = portableState(manifest);
  if (JSON.stringify(cleaned.records) !== JSON.stringify(manifest.records) || JSON.stringify(cleaned.events) !== JSON.stringify(manifest.events)) throw new Error('Shared project contains private authentication or runtime authority.');
  if (manifest.providers && Object.keys(manifest.providers).length) throw new Error('Shared projects cannot install provider endpoints or account configuration.');
  assertShareText(JSON.stringify([manifest.records, manifest.events]));
}
