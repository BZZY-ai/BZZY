import fs from 'node:fs';
import path from 'node:path';
import { home, privateDir } from './files.js';
import { isolatedAgentCodexHome } from './agent-execution.js';

export const learningPermissionProfile = 'bzzy_learning_review_v1';
export const learningDisabledFeatures = ['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'view_image',
  'image_generation', 'apps', 'plugins', 'remote_plugin', 'hooks', 'skill_search', 'skill_mcp_dependency_install',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'code_mode_host', 'code_mode',
  'goals', 'memories', 'external_agent_memory_import'];

// A review's cwd contains no project content. Provider authentication is consumed
// by the official host process, outside the model's named permission profile.
export function learningWorkingDirectory(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid learning execution identity.');
  const directory = path.join(home(), 'runtime', 'learning', id, 'work');
  privateDir(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || fs.readdirSync(directory).length) {
    throw new Error('Learning requires an empty private working directory.');
  }
  return fs.realpathSync(directory);
}

export function learningCodexHome(provider, session) {
  if (fs.realpathSync(session.cwd) !== learningWorkingDirectory(session.id)) throw new Error('Learning cannot use a project working directory.');
  return isolatedAgentCodexHome(provider, session);
}

export function assertLearningWorkingDirectory(session) {
  if (fs.realpathSync(session.cwd) !== learningWorkingDirectory(session.id)) throw new Error('Learning cannot use a project working directory.');
}
