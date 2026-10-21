import path from 'node:path';
import { normalizeContract, loadContract, validateContractPaths } from './contracts.js';
import { readJson, saveSession } from './store.js';
import { agentChoice } from './delegation.js';
import { childPolicy } from './policy.js';
import { codexHome, claudeHome } from './auth.js';
import { configuredParallel } from './parallel-setup.js';

export function prepareTask(session, options, objective, { persist = true } = {}) {
  const project = session.projectRoot || session.cwd;
  const persistent = readJson(path.join(project, '.bzzy', 'constraints.json'), {});
  const provided = options.contract ? loadContract(path.resolve(options.contract), objective) : normalizeContract({}, objective);
  const initialContext = typeof options.initialContext === 'string' ? options.initialContext.trim() : '';
  const context = [provided.context, initialContext && `Initial instruction supplied before this goal:\n${initialContext}`].filter(Boolean).join('\n\n');
  const contract = normalizeContract({ ...provided,
    context,
    constraints: [...new Set([...(persistent.constraints || []), ...provided.constraints])],
    scope: { ...(persistent.scope || {}), ...provided.scope },
    policy: persistent.policy ? childPolicy(persistent.policy, options.readOnly ? { ...provided.policy, mode: 'read-only' } : provided.policy) : options.readOnly ? { mode: 'read-only' } : provided.policy,
    limits: { ...provided.limits, ...(options.runtimeSeconds ? { runtimeSeconds: options.runtimeSeconds } : {}), ...(options.tokenBudget ? { tokenBudget: options.tokenBudget } : {}),
      ...(options.maxRetries != null ? { maxRetries: options.maxRetries } : {}), ...(options.concurrency ? { concurrency: options.concurrency } : {}) } }, objective);
  validateContractPaths(contract, session.cwd);
  session.contract = contract; session.policy = contract.policy;
  session.backendHomes ||= { codex: codexHome(), codexApi: codexHome({ auth: 'api-key' }),
    ...(process.env.BZZY_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: claudeHome() } : {}) };
  session.strictPolicy = Boolean(options.contract || options.readOnly || persistent.policy);
  session.mode = options.mode || session.mode || 'solo'; session.projectRoot = project;
  if (session.mode === 'delegate') {
    const previous = session.executor;
    const selected = options.executor ? agentChoice(options.executor, options.executorModel)
      : agentChoice(previous?.provider || 'deepseek', options.executorModel || previous?.model);
    session.executor = { ...(selected.provider === previous?.provider && selected.model === previous?.model ? previous : {}), ...selected };
  }
  if (session.mode === 'besties') {
    session.besties = options.besties || options.bestiesSelection || session.besties || (options.agents || 'codex,claude').split(',').map(value => agentChoice(value.trim()));
    if (!Array.isArray(session.besties) || session.besties.length !== 2) throw new Error('Besties requires exactly two peer provider/model selections.');
    for (const peer of session.besties) agentChoice(peer.provider, peer.model);
  }
  if (session.mode === 'parallel') {
    session.parallelAgents = configuredParallel({ ...options, parallelAgents: options.parallelAgents || session.parallelAgents });
  }
  if (options.yolo && contract.policy.mode === 'read-only') throw new Error('--yolo conflicts with the contract’s enforced read-only policy.');
  if (persist) saveSession(session); return session;
}
