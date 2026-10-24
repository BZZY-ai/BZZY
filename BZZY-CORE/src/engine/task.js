import fs from 'node:fs';
import path from 'node:path';
import { normalizeContract, loadContract, validateContractPaths } from './contracts.js';
import { readJson, saveSession } from './store.js';
import { agentChoice } from './delegation.js';
import { childPolicy } from './policy.js';
import { codexHome, claudeAuthHomes } from './auth.js';
import { configuredParallel } from './parallel-setup.js';
import { projectIdentityForSession } from './project-identity.js';

export function readContextFile(file, cwd) {
  const resolved = path.resolve(cwd, file);
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('expected a regular text file');
    if (stat.size > 1024 * 1024) throw new Error('file exceeds 1 MiB; nothing was truncated');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 1024 * 1024) throw new Error('file exceeds 1 MiB; nothing was truncated');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.trim()) throw new Error('file is empty');
    if (text.includes('\0')) throw new Error('expected UTF-8 text without NUL characters');
    return text;
  } catch (error) {
    throw new Error(`Cannot load --context-file ${resolved}: ${error.message}`);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

export function prepareTask(session, options, objective, { persist = true } = {}) {
  const existingProject = projectIdentityForSession(session);
  const project = existingProject.root;
  const persistent = readJson(path.join(project, '.bzzy', 'constraints.json'), {});
  const provided = options.contract ? loadContract(path.resolve(options.contract), objective) : normalizeContract({}, objective);
  const initialContext = typeof options.initialContext === 'string' ? options.initialContext.trim() : '';
  const requestedPolicy = options.readOnly ? { ...(options.contract ? provided.policy : persistent.policy || provided.policy), mode: 'read-only', writablePaths: [] }
    : options.contract ? provided.policy : undefined;
  const context = [provided.context, options.contextFileText,
    initialContext && `Initial instruction supplied before this goal:\n${initialContext}`].filter(Boolean).join('\n\n');
  const contract = normalizeContract({ ...provided,
    context,
    constraints: [...new Set([...(persistent.constraints || []), ...provided.constraints])],
    scope: { ...(persistent.scope || {}), ...provided.scope },
    policy: persistent.policy ? childPolicy(persistent.policy, requestedPolicy) : requestedPolicy || provided.policy,
    limits: { ...provided.limits, ...(options.runtimeSeconds ? { runtimeSeconds: options.runtimeSeconds } : {}), ...(options.tokenBudget ? { tokenBudget: options.tokenBudget } : {}),
      ...(options.maxRetries != null ? { maxRetries: options.maxRetries } : {}), ...(options.concurrency ? { concurrency: options.concurrency } : {}) } }, objective);
  validateContractPaths(contract, session.cwd);
  session.contract = contract; session.policy = contract.policy;
  session.backendHomes ||= { codex: codexHome(), codexApi: codexHome({ auth: 'api-key' }), ...claudeAuthHomes() };
  session.strictPolicy = Boolean(options.contract || options.readOnly || persistent.policy);
  const identity = projectIdentityForSession({ ...session, projectRoot: project }, {
    create: contract.policy.mode !== 'read-only' && !['executor', 'reviewer', 'learning-review', 'skill-writer', 'knowledge-review'].includes(session.role),
  });
  session.mode = options.mode || session.mode || 'solo'; session.projectRoot = identity.root; session.projectId = identity.id;
  if (session.mode === 'delegate') {
    const previous = session.executor;
    const selected = options.executor ? agentChoice(options.executor, options.executorModel)
      : agentChoice(previous?.provider || 'deepseek', options.executorModel || previous?.model);
    session.executor = { ...(selected.provider === previous?.provider && selected.model === previous?.model ? previous : {}), ...selected };
  }
  if (session.mode === 'besties') {
    session.besties = options.besties || options.bestiesSelection || session.besties || (options.agents || 'codex,claude').split(',').map(value => agentChoice(value.trim()));
    if (!Array.isArray(session.besties) || (session.besties.length < 2 || session.besties.length > 3)) throw new Error('Besties requires 2 or 3 peer provider/model selections.');
    for (const peer of session.besties) agentChoice(peer.provider, peer.model);
  }
  if (session.mode === 'debate' && options.debateAgents) session.debateAgents = options.debateAgents;
  if (session.mode === 'parallel') {
    session.parallelAgents = configuredParallel({ ...options, parallelAgents: options.parallelAgents || session.parallelAgents });
  }
  if (options.yolo && contract.policy.mode === 'read-only') throw new Error('--yolo conflicts with the contract’s enforced read-only policy.');
  if (persist) saveSession(session); return session;
}
