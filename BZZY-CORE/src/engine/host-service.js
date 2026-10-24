// Local-owner installation only. Nothing here is exposed through Relay or tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { home } from './files.js';
import { canonicalPath } from '../paths.js';
import { setTimeout as delay } from 'node:timers/promises';
import { beginCoreMaintenance, assertCoreAvailable } from './maintenance.js';
export { beginCoreMaintenance } from './maintenance.js';

const marker = 'BZZY managed host service v1';
const contextPaths = ['BZZY_CODEX_HOME', 'CODEX_HOME', 'BZZY_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR', 'BZZY_CODEX_BIN', 'BZZY_CLAUDE_BIN'];
const failure = (code, message) => Object.assign(new Error(message), { code });
const safe = value => {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw failure('SERVICE_PATH_INVALID', 'Service paths must be nonempty and contain no control characters.');
  return value;
};
const absolute = value => {
  safe(value);
  if (!path.isAbsolute(value)) throw failure('SERVICE_PATH_INVALID', 'Service paths must be absolute.');
  return path.resolve(value);
};
const xml = value => safe(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unit = (value, command = false) => '"' + safe(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => command ? '$$' : '$') + '"';
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const real = canonicalPath;

export function servicePlan({ platform = process.platform, userHome = os.homedir(), coreHome = home(), node = process.execPath,
  entry = fileURLToPath(new URL('../../bin/bzzy-core.js', import.meta.url)), env = process.env, uid = process.getuid?.() } = {}) {
  if (!['linux', 'darwin'].includes(platform)) throw failure('SERVICE_PLATFORM_UNSUPPORTED', 'Managed services support Linux systemd and macOS launchd.');
  if (!Number.isSafeInteger(uid) || uid < 0 || uid === 0 && platform !== 'linux') throw failure('SERVICE_NON_ROOT_REQUIRED', 'macOS Core supervision requires an ordinary graphical user account.');
  userHome = absolute(real(absolute(userHome))); coreHome = absolute(real(absolute(coreHome)));
  node = absolute(real(absolute(node))); entry = absolute(real(absolute(entry)));
  if (coreHome === userHome || coreHome === path.parse(coreHome).root) throw failure('SERVICE_PATH_INVALID', 'Choose a separate private BZZY_HOME.');
  const id = createHash('sha256').update(coreHome).digest('hex').slice(0, 16), label = `app.bzzy.core.${id}`;
  const environment = { HOME: userHome, BZZY_HOME: coreHome,
    PATH: safe([path.dirname(node), ...(env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)].filter((item, index, list) => item && list.indexOf(item) === index).join(path.delimiter)) };
  for (const name of contextPaths) if (env[name]) environment[name] = absolute(env[name]);
  const logPath = path.join(coreHome, 'runtime', 'host-service.log');
  if (platform === 'darwin') {
    const file = path.join(userHome, 'Library', 'LaunchAgents', `${label}.plist`);
    const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- ${marker} ${id} -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string><string>serve</string></array>\n<key>WorkingDirectory</key><string>${xml(coreHome)}</string>\n<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>\n<key>RunAtLoad</key><true/>\n<key>Disabled</key><true/>\n<key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>Umask</key><integer>63</integer>\n<key>AbandonProcessGroup</key><true/>\n<key>StandardOutPath</key><string>${xml(logPath)}</string>\n<key>StandardErrorPath</key><string>${xml(logPath)}</string>\n</dict></plist>\n`;
    return { version: 1, platform, manager: '/bin/launchctl', uid, label, id, coreHome, userHome, node, entry, file, logPath, environment, manifest, startup: 'At this user’s graphical login; the Mac must remain awake.' };
  }
  const scope = uid === 0 ? 'system' : 'user', name = `bzzy-core-${id}.service`;
  const file = scope === 'system' ? path.join('/etc/systemd/system', name) : path.join(userHome, '.config', 'systemd', 'user', name);
  const manifest = `# ${marker} ${id}\n[Unit]\nDescription=BZZY Core private host\nAfter=network-online.target\n\n[Service]\nType=simple\n${scope === 'system' ? 'User=root\n' : ''}ExecStart=${unit(node, true)} ${unit(entry, true)} serve\nWorkingDirectory=${unit(coreHome)}\n${Object.entries(environment).map(([key, value]) => `Environment=${unit(`${key}=${value}`)}`).join('\n')}\nUMask=0077\nRestart=always\nRestartSec=5\nTimeoutStopSec=20\nKillMode=process\nStandardOutput=journal\nStandardError=inherit\n\n[Install]\nWantedBy=${scope === 'system' ? 'multi-user.target' : 'default.target'}\n`;
  return { version: 1, platform, manager: fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl', uid, scope, label: name, id,
    coreHome, userHome, node, entry, file, logPath, environment, manifest, startup: scope === 'system' ? 'At boot when explicitly enabled; runs as the root installation account.' : 'At this user’s login; boot without login requires administrator-enabled systemd lingering.' };
}

function ownerOnly(file, { directory = false, privateMode = false, uid = process.getuid?.() } = {}) {
  const info = exists(file);
  if (!info || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.uid !== uid ||
    info.mode & (privateMode ? 0o077 : 0o022)) throw failure('SERVICE_PRIVATE_PATH_REQUIRED', 'Use owned, non-writable-by-others service files and a private BZZY_HOME (mode 700).');
  return info;
}
function context(plan, create) {
  if (create) fs.mkdirSync(plan.coreHome, { recursive: true, mode: 0o700 });
  ownerOnly(plan.coreHome, { directory: true, privateMode: true, uid: plan.uid });
  if (create) {
    const directory = path.dirname(plan.logPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); ownerOnly(directory, { directory: true, privateMode: true, uid: plan.uid });
    const descriptor = fs.openSync(plan.logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(descriptor); ownerOnly(plan.logPath, { privateMode: true, uid: plan.uid });
  }
}
function runtimeManifest(value, platform) {
  // PATH is deliberately captured at installation. A later terminal's PATH
  // must not prevent controlling that same service or silently replace it.
  // All other generated fields, including executable/account-directory paths,
  // remain exact. Require one unambiguous managed PATH entry.
  const pattern = platform === 'darwin' ? /<key>PATH<\/key><string>[^<]*<\/string>/g
    : /^Environment="PATH=(?:[^"\\\n]|\\.)*"$/gm;
  const matches = value.match(pattern);
  if (matches?.length !== 1) return null;
  return value.replace(pattern, 'BZZY_PATH_CAPTURED_AT_INSTALL');
}
function installed(plan, { exact = false } = {}) {
  if (!exists(plan.file)) return false;
  const info = ownerOnly(plan.file, { uid: plan.uid });
  const saved = info.size <= 65536 ? fs.readFileSync(plan.file, 'utf8') : '';
  if (!saved.includes(`${marker} ${plan.id}`)) throw failure('SERVICE_FILE_CONFLICT', 'An unrelated service file already exists.');
  if (exact && (runtimeManifest(saved, plan.platform) === null || runtimeManifest(saved, plan.platform) !== runtimeManifest(plan.manifest, plan.platform))) {
    throw failure('SERVICE_OUTDATED', 'Service paths/settings changed. Review service plan, then run service install before starting.');
  }
  return true;
}
// Filesystem-only discovery for the engine's no-detached-fallback boundary.
export function preparedServiceInstalled() {
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(process.getuid?.()) || process.platform === 'darwin' && process.getuid() === 0) return false;
  return installed(servicePlan());
}
const systemdArgs = (plan, args) => plan.scope === 'system' ? args : ['--user', ...args];
const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
const invoke = (run, plan, args, optional = false) => {
  const result = run(plan.manager, args);
  if (!optional && (result?.error || result?.status !== 0)) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'The Core service manager could not complete the operation. Check systemd/launchd status and the installation account.');
  return result;
};

export function installService(plan, { run = defaultRun } = {}) {
  if (installed(plan)) {
    if (fs.readFileSync(plan.file, 'utf8') === plan.manifest) return { installed: true, changed: false, file: plan.file };
    if (serviceStatus(plan, { run }).running) throw failure('SERVICE_RUNNING', 'Stop Core before replacing its active service manifest.');
  }
  ownerOnly(plan.node, { uid: fs.statSync(plan.node).uid });
  ownerOnly(plan.entry, { uid: fs.statSync(plan.entry).uid });
  context(plan, true);
  const parent = path.dirname(plan.file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); ownerOnly(parent, { directory: true, uid: plan.uid });
  const temporary = `${plan.file}.${randomUUID()}.tmp`;
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, plan.manifest); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, plan.file);
  } finally { fs.rmSync(temporary, { force: true }); }
  return { installed: true, changed: true, file: plan.file };
}

export function serviceStatus(plan, { run = defaultRun } = {}) {
  const present = installed(plan);
  if (!present) return { installed: false, running: false, state: 'not-installed', file: plan.file };
  const args = plan.platform === 'darwin' ? ['print', `gui/${plan.uid}/${plan.label}`]
    : systemdArgs(plan, ['show', plan.label, '--property=LoadState,ActiveState,SubState,MainPID,UnitFileState', '--no-pager']);
  const result = invoke(run, plan, args, true), output = result?.stdout || '';
  if (result?.error || result?.status !== 0) return { installed: true, running: false, state: 'not-loaded-or-manager-unavailable', file: plan.file };
  if (plan.platform === 'darwin') {
    const pid = Number(/^\s*pid = (\d+)$/m.exec(output)?.[1]) || null;
    return { installed: true, running: Boolean(pid), state: /^\s*state = ([a-z-]+)$/m.exec(output)?.[1] || 'loaded', pid, file: plan.file };
  }
  const values = Object.fromEntries(output.split('\n').filter(line => line.includes('=')).map(line => line.split('=')));
  const pid = Number(values.MainPID) || null;
  return { installed: true, running: values.ActiveState === 'active' && Boolean(pid), state: /^[a-z-]+$/.test(values.ActiveState) ? values.ActiveState : 'unknown',
    enabled: values.UnitFileState === 'enabled', pid, file: plan.file };
}

export async function startService(plan, { run = defaultRun, runtimeRunning = async () => false } = {}) {
  if (!installed(plan, { exact: true })) throw failure('SERVICE_NOT_INSTALLED', 'Run service install first.');
  context(plan, false);
  const status = serviceStatus(plan, { run });
  if (status.running) return status;
  if (await runtimeRunning()) throw failure('CORE_ALREADY_RUNNING', 'An unsupervised Core is already running. Stop it before starting the managed service.');
  if (plan.platform === 'darwin') {
    invoke(run, plan, ['enable', `gui/${plan.uid}/${plan.label}`]);
    if (status.state === 'not-loaded-or-manager-unavailable') invoke(run, plan, ['bootstrap', `gui/${plan.uid}`, plan.file]);
    invoke(run, plan, ['kickstart', `gui/${plan.uid}/${plan.label}`]);
  } else {
    invoke(run, plan, systemdArgs(plan, ['daemon-reload']));
    invoke(run, plan, systemdArgs(plan, ['enable', '--now', plan.label]));
  }
  return { ...serviceStatus(plan, { run }), requested: 'start' };
}
export function stopService(plan, { run = defaultRun } = {}) {
  if (!installed(plan)) return { installed: false, running: false, state: 'not-installed' };
  if (plan.platform === 'darwin') {
    invoke(run, plan, ['disable', `gui/${plan.uid}/${plan.label}`]);
    const status = serviceStatus(plan, { run });
    if (status.state !== 'not-loaded-or-manager-unavailable') invoke(run, plan, ['bootout', `gui/${plan.uid}/${plan.label}`]);
  } else invoke(run, plan, systemdArgs(plan, ['disable', '--now', plan.label]));
  return { installed: true, running: false, state: 'stopped', file: plan.file };
}
export function uninstallService(plan, options = {}) {
  if (!installed(plan)) return { installed: false, removed: false };
  stopService(plan, options); fs.unlinkSync(plan.file);
  if (plan.platform === 'linux') invoke(options.run || defaultRun, plan, systemdArgs(plan, ['daemon-reload']));
  return { installed: false, removed: true, preservedPrivateData: true };
}

export function installationDoctor({ env = process.env, platform = process.platform, nodeVersion = process.versions.node } = {}) {
  const major = Number(nodeVersion.split('.')[0]);
  const python = spawnSync('python3', ['-c', 'import sys; print("%d.%d" % sys.version_info[:2]); sys.exit(0 if sys.version_info >= (3, 9) else 1)'],
    { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 });
  const pythonReady = !python.error && python.status === 0;
  let contextReady = true;
  const directory = real(home()), info = exists(directory);
  if (info) contextReady = info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && !(info.mode & 0o077);
  const manager = platform === 'darwin' ? '/bin/launchctl' : platform === 'linux' ? fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl' : null;
  const managerReady = Boolean(manager && fs.existsSync(manager));
  return { ready: major >= 24 && pythonReady && contextReady && managerReady,
    checks: { node: { ready: major >= 24, version: nodeVersion, executable: process.execPath, required: '24+' },
      python: { ready: pythonReady, version: pythonReady ? python.stdout.trim() : null, required: '3.9+', purpose: 'Project ZIP sharing/import' },
      privateContext: { ready: contextReady, directory, exists: Boolean(info), required: 'Owned private directory (mode 700)' },
      userService: { ready: managerReady, manager, required: platform === 'linux' && process.getuid?.() === 0 ? 'Linux systemd system manager for the root installation account' : 'macOS graphical user login or Linux systemd user manager' } },
    next: 'Configure provider accounts privately on this host, set the workspace root and explicitly install/start Core. Its public Relay identity registers automatically. No model is required for pairing/settings.' };
}

async function lifecycleRuntime() {
  const runtime = await import('./runtime.js');
  const { identityAlive } = await import('./process-identity.js');
  const current = () => {
    const info = runtime.runtimeInfo(); return info && identityAlive(info.identity) ? info : null;
  };
  return {
    controlAlive: () => Boolean(current()),
    clearStop: runtime.clearOperatorStopIntent,
    persistStop: runtime.persistOperatorStopIntent,
    stopped: runtime.operatorStopRequested,
    async status() {
      const info = current();
      if (!info) return { running: false };
      try {
        const health = await runtime.runtimeRequest(info, 'GET', '/health');
        const identity = health.identity;
        if (!identity || identity.pid !== info.identity.pid || identity.start !== info.identity.start ||
          identity.boot !== info.identity.boot || !identityAlive(identity)) return { running: false };
        return { running: true, pid: identity.pid, version: health.version, apiVersion: health.apiVersion };
      } catch { return { running: false }; }
    },
    async quiesce(managed) {
      const info = current();
      if (info) return runtime.runtimeRequest(info, 'POST', '/v1/operator-stop', { shutdown: !managed });
      const result = await runtime.pauseRuntimeExecutions();
      return { quiesced: true, ...result, runningAgentsContinue: false };
    },
    async shutdown() {
      const info = current();
      return info ? runtime.runtimeRequest(info, 'POST', '/shutdown', {}) : { stopped: true, runningAgentsContinue: true };
    },
  };
}

export async function coreHostStatus({ plan = servicePlan(), runtime, run = defaultRun } = {}) {
  runtime ||= await lifecycleRuntime();
  const engine = await runtime.status(), service = serviceStatus(plan, { run });
  return { ...engine, engine, service, managed: sameManagedProcess(engine, service), operatorStopped: runtime.stopped() };
}
const sameManagedProcess = (engine, manager) => engine.running === true && manager.running === true &&
  Number.isSafeInteger(engine.pid) && engine.pid > 0 && engine.pid === manager.pid;

export async function startCoreHost({ plan = servicePlan(), runtime, run = defaultRun, doctor = installationDoctor,
  prepare = true, readinessWaitMs = 8000 } = {}) {
  assertCoreAvailable(plan.coreHome);
  if (!Number.isSafeInteger(readinessWaitMs) || readinessWaitMs < 50 || readinessWaitMs > 15000) throw failure('SERVICE_USAGE', 'Service readiness wait must be 50–15000 milliseconds.');
  if (!runtime) (await import('../relay/service.js')).prepareRelayService();
  runtime ||= await lifecycleRuntime();
  const ready = doctor();
  if (!ready.ready) throw failure('SERVICE_PREREQUISITES', 'Run bzzy-core doctor and resolve Node/Python/private-directory prerequisites before starting.');
  if (!installed(plan)) {
    if (!prepare) return { managed: false };
    installService(plan, { run });
  }
  const manager = serviceStatus(plan, { run }), engine = await runtime.status();
  if (runtime.stopped() && (manager.running || engine.running)) {
    throw failure('CORE_STOPPED', 'Core is still quiescing. Run bzzy-core restart to finish the stop before reactivating it.');
  }
  if (engine.running && !sameManagedProcess(engine, manager)) throw failure('CORE_ALREADY_RUNNING', 'Core is running outside its managed service. Run bzzy-core restart to migrate it safely.');
  runtime.clearStop();
  try { await startService(plan, { run, runtimeRunning: async () => (await runtime.status()).running }); }
  catch (error) {
    // A concurrent explicit launcher may have loaded the same service first.
    // Otherwise preserve the operator gate: routine clients must not turn a
    // failed supervised start into an unsupervised fallback.
    if (!serviceStatus(plan, { run }).running) { runtime.persistStop(); throw error; }
  }
  const deadline = Date.now() + readinessWaitMs;
  let current, supervisor;
  do {
    current = await runtime.status(); supervisor = serviceStatus(plan, { run });
    if (sameManagedProcess(current, supervisor)) break;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (!sameManagedProcess(current, supervisor)) {
    runtime.persistStop();
    throw failure('SERVICE_START_FAILED', 'The Core service did not become ready. Check bzzy-core status and private supervisor logs.');
  }
  return { ...current, engine: current, service: supervisor, managed: true };
}

export async function stopCoreHost({ plan = servicePlan(), runtime, run = defaultRun } = {}) {
  runtime ||= await lifecycleRuntime();
  runtime.persistStop();
  const manager = serviceStatus(plan, { run });
  // The operator barrier rejects new work while every existing execution is
  // paused. Keep the supervisor loaded if verification fails.
  const result = await runtime.quiesce(manager.running);
  if (result.quiesced !== true && result.stopped !== true) throw failure('STOP_INCOMPLETE', 'Core could not verify that all work stopped.');
  if (manager.installed) stopService(plan, { run });
  const deadline = Date.now() + 8000;
  while (runtime.controlAlive ? await runtime.controlAlive() : (await runtime.status()).running) {
    if (Date.now() >= deadline) throw failure('STOP_INCOMPLETE', 'Core has not finished stopping; its stop intent remains active.');
    await delay(100);
  }
  return { running: false, stopped: true, pausedExecutions: result.pausedExecutions || 0, runningAgentsContinue: false,
    service: serviceStatus(plan, { run }) };
}

export async function suspendCoreHost({ plan = servicePlan(), runtime, run = defaultRun } = {}) {
  runtime ||= await lifecycleRuntime();
  const manager = serviceStatus(plan, { run });
  // Service manifests explicitly abandon descendants / use KillMode=process.
  // Unload only the control daemon; execution runners keep their identities.
  if (manager.installed) stopService(plan, { run });
  if ((await runtime.status()).running) {
    const result = await runtime.shutdown();
    if (result.runningAgentsContinue !== true) throw failure('RESTART_INCOMPLETE', 'Core could not confirm execution-preserving shutdown.');
  }
  const deadline = Date.now() + 8000;
  while (runtime.controlAlive ? await runtime.controlAlive() : (await runtime.status()).running) {
    if (Date.now() >= deadline) throw failure('RESTART_INCOMPLETE', 'Core control has not finished shutting down; active runners were not paused.');
    await delay(50);
  }
  return { running: false, runningAgentsContinue: true };
}

export async function restartCoreHost(options = {}) {
  const release = beginCoreMaintenance((options.plan || servicePlan()).coreHome);
  let runtime, wasStopped;
  try {
    runtime = options.runtime || await lifecycleRuntime(); wasStopped = runtime.stopped();
    // A previous explicit Stop must finish its pause barrier first.
    if (wasStopped) await stopCoreHost({ ...options, runtime });
    else await suspendCoreHost({ ...options, runtime });
  } finally { release(); }
  if (!wasStopped && runtime.stopped()) return { ...await coreHostStatus({ ...options, runtime }), runningAgentsContinue: false };
  return { ...await startCoreHost(options), runningAgentsContinue: true };
}

// Called only by a fresh terminal invocation, never by a status/metrics poll.
// Source/test contexts without a prepared manifest retain their existing engine
// path; a bundled installation uses exactly the installed user service.
export async function activateCLIHost({ plan, runtime, run = defaultRun, direct = process.env.BZZY_DIRECT === '1' } = {}) {
  assertCoreAvailable(plan?.coreHome);
  if (direct) return { managed: false, direct: true };
  plan ||= servicePlan();
  if (!runtime && installed(plan)) (await import('../relay/service.js')).prepareRelayService();
  runtime ||= await lifecycleRuntime();
  if (installed(plan)) return startCoreHost({ plan, runtime, run, prepare: false });
  runtime.clearStop(); return { managed: false };
}
