#!/usr/bin/env node
import { authoringHelp } from '../src/engine/authoring-guides.js';

async function runCommand() {
  const { requireNode } = await import('../src/engine.js');
  requireNode();
  const [command = 'help', ...extra] = process.argv.slice(2);
  if (command === 'relay') await (await import('../src/relay/cli.js')).relayCommand(extra);
  else if (command === 'extensions') (await import('../src/engine/extensions-cli.js')).extensionsCLI(extra);
  else if (command === 'assistant') (await import('../src/assistant-cli.js')).assistantCommand(extra);
  else if (command === 'workspace') (await import('../src/workspaces-cli.js')).workspaceCommand(extra);
  else if (command === 'service') await (await import('../src/host-service-cli.js')).hostServiceCommand(extra);
  else if (command === 'update') {
    if (extra.length) throw new Error('Unexpected update arguments.');
    try { await (await import('../src/engine/source-update.js')).updateCoreAndCLI(); }
    catch { console.error('BZZY update failed. Check GitHub access and installation status, then run bzzy --update to retry. Saved work remains paused if installation stopped Core.'); process.exitCode = 1; }
  }
  else if (command === 'doctor') (await import('../src/host-service-cli.js')).doctorCommand(extra);
  else if (['start', 'status', 'stop', 'restart'].includes(command)) await (await import('../src/host-service-cli.js')).coreLifecycleCommand(command, extra);
  else if (extra.length) throw new Error('Unexpected arguments. Run bzzy-core help.');
  else if (command === 'serve') await (await import('../src/engine/entry.js')).backendCommand(['internal-service']);
  else if (command === 'help') console.log('Usage: bzzy-core <start|status|stop|restart|update|doctor|service|serve|extensions|assistant|workspace|relay>\nstart prepares and starts the user service; stop pauses work; restart reopens Core without resuming models.\nupdate installs the checked GitHub revision of both CLI and Core.\nUses the existing BZZY engine and BZZY_HOME. Node.js >=24 is required.\nAPI reference: --help-api (local HTTP, events, jobs and host SDK).\nAuthoring references: --help-skills, --help-agents, --help-workflows, --help-goals, --help-extensions (plain Markdown; no service or model starts).\nRun doctor for installation prerequisites, service help for startup details, assistant help for the default AI, workspace help for the managed project root, or relay help for encrypted Relay connectivity.');
  else throw new Error('Unknown command. Run bzzy-core help.');
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('BZZY Core requires Node.js 24 or newer.');
  const guide = authoringHelp(process.argv.slice(2));
  if (guide !== null) process.stdout.write(guide);
  else await runCommand();
} catch (error) {
  const safeCodes = new Set(['HOST_ENROLLMENT_REQUIRED', 'PRIVATE_TERMINAL_REQUIRED', 'PRIVATE_DIRECTORY_REQUIRED', 'PRIVATE_FILE_REQUIRED',
    'NON_ROOT_REQUIRED', 'BZZY_LOCKED', 'INVALID_REQUEST', 'INVALID_IDENTITY', 'FORBIDDEN', 'TLS_REQUIRED', 'OFFLINE',
    'AUTHORIZATION_REQUIRED', 'DEVICE_CONNECTED', 'CONNECTION_FAILED', 'CONNECTION_CLOSED', 'GATEWAY_OFFLINE', 'CONFIRMATION_REQUIRED', 'UNCERTAIN',
    'ASSISTANT_SETUP_REQUIRED', 'PROVIDER_UNAVAILABLE', 'CONFLICT']);
  const serviceCodes = new Set(['SERVICE_USAGE', 'SERVICE_PATH_INVALID', 'SERVICE_PLATFORM_UNSUPPORTED', 'SERVICE_NON_ROOT_REQUIRED',
    'SERVICE_PRIVATE_PATH_REQUIRED', 'SERVICE_FILE_CONFLICT', 'SERVICE_OUTDATED', 'SERVICE_MANAGER_UNAVAILABLE', 'SERVICE_NOT_INSTALLED',
    'SERVICE_RUNNING', 'SERVICE_PREREQUISITES', 'SERVICE_START_FAILED', 'CORE_ALREADY_RUNNING']);
  console.error(error.code === 'CORE_STOPPED' ? 'Core was stopped. Run bzzy-core restart or open a new bzzy terminal to reactivate it.'
    : error.code === 'STOP_INCOMPLETE' ? 'Core could not verify that all work stopped. Its stop barrier remains active; retry bzzy-core stop.'
    : error.code === 'CORE_SERVICE_UNAVAILABLE' ? 'The prepared Core service is unavailable. Run bzzy-core start or inspect bzzy-core status; no detached fallback was started.'
    : serviceCodes.has(error.code) || error.code === 'AUTHORING_HELP_USAGE' ? error.message : error.code === 'HOST_ENROLLMENT_REQUIRED' ? 'This host needs Relay enrollment. Send only the public certificate from bzzy-core relay init to the Relay operator.' : safeCodes.has(error.code) ? `Core failed (${error.code}).` : 'Core could not start. Check Node.js >=24 and the local BZZY installation.');
  process.exitCode = 1;
}
