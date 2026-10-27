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
import { processIdentity, identityAlive } from './process-identity.js';
import { rootExecutionAllowed, assertRootExecutable } from './root-execution.js';
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
// WorkingDirectory is a literal single path, not an ExecStart/Environment word.
// Quotes/backslash escapes are not removed by systemd's path parser. /.
// preserves a final space or backslash through unit-file trimming/continuations.
const unitDirectory = value => safe(value).replaceAll('%', '%%') + '/.';
const exists = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const real = canonicalPath;
const manifestSnapshots = new Map();

export function servicePlan({ platform = process.platform, userHome = os.homedir(), coreHome = home(), node = process.execPath,
  entry = fileURLToPath(new URL('../../bin/bzzy-core.js', import.meta.url)), env = process.env, uid = process.getuid?.(),
  rootExecution = rootExecutionAllowed({ platform, uid, coreHome }) } = {}) {
  if (!['linux', 'darwin'].includes(platform)) throw failure('SERVICE_PLATFORM_UNSUPPORTED', 'Managed services support Linux systemd and macOS launchd.');
  if (!Number.isSafeInteger(uid) || uid < 0 || uid === 0 && (platform !== 'linux' || rootExecution !== true)) throw failure('SERVICE_NON_ROOT_REQUIRED', 'Use an ordinary user, or explicitly install Linux root execution with install.sh --allow-root.');
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
  const scope = uid === 0 ? 'system' : 'user';
  const name = `bzzy-core-${id}.service`, file = scope === 'system' ? path.join('/etc/systemd/system', name) : path.join(userHome, '.config', 'systemd', 'user', name);
  const manifest = `# ${marker} ${id}\n[Unit]\nDescription=BZZY Core private host\nAfter=network-online.target\n\n[Service]\n${scope === 'system' ? 'User=root\n' : ''}Type=simple\nExecStart=${unit(node, true)} ${unit(entry, true)} serve\nWorkingDirectory=${unitDirectory(coreHome)}\n${Object.entries(environment).map(([key, value]) => `Environment=${unit(`${key}=${value}`)}`).join('\n')}\nUMask=0077\nRestart=always\nRestartSec=5\nTimeoutStopSec=20\nKillMode=process\nStandardOutput=journal\nStandardError=inherit\n\n[Install]\nWantedBy=${scope === 'system' ? 'multi-user' : 'default'}.target\n`;
  return { version: 1, platform, manager: fs.existsSync('/usr/bin/systemctl') ? '/usr/bin/systemctl' : '/bin/systemctl', uid, label: name, id,
    scope, coreHome, userHome, node, entry, file, logPath, environment, manifest, startup: scope === 'system' ? 'Linux system service running as root; enabled on an explicit start.' : 'At this user’s login; boot without login requires administrator-enabled systemd lingering.' };
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
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(process.getuid?.())) return false;
  if (process.getuid() === 0 && !rootExecutionAllowed()) return false;
  return installed(servicePlan());
}
const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
const systemctl = (plan, ...args) => [plan.scope === 'system' ? '--system' : '--user', ...args];
const invoke = (run, plan, args, optional = false) => {
  const result = run(plan.manager, args);
  if (!optional && (result?.error || result?.status !== 0)) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'The user service manager could not complete the operation. Check service status and user login.');
  return result;
};

export function installService(plan, { run = defaultRun } = {}) {
  if (plan.uid === 0) { assertRootExecutable(plan.node); assertRootExecutable(plan.entry); }
  if (installed(plan)) {
    if (fs.readFileSync(plan.file, 'utf8') === plan.manifest) return { installed: true, changed: false, file: plan.file };
    const manager = serviceStatus(plan, { run });
    if (!manager.available) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'Core could not verify that its user service is unloaded. Check service status and user login.');
    if (manager.running || plan.platform === 'darwin' && manager.loaded) throw failure('SERVICE_RUNNING', 'Suspend Core control before replacing its loaded service manifest. Existing runners can continue.');
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

// These opaque receipts stay in the updater's trusted module instance. They
// restore exact reviewed bytes, rather than rebuilding an old plan from the
// updater's possibly different Node executable or terminal environment.
export function snapshotCoreServiceManifest({ plan = servicePlan() } = {}) {
  const present = installed(plan); let manifest = null, mode = 0o600;
  if (present) {
    const descriptor = fs.openSync(plan.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.uid !== plan.uid || stat.mode & 0o022 || stat.size > 65536) throw failure('SERVICE_PRIVATE_PATH_REQUIRED', 'The service manifest is not a bounded owned managed file.');
      manifest = fs.readFileSync(descriptor, 'utf8'); mode = stat.mode & 0o777;
      if (!manifest.includes(`${marker} ${plan.id}`)) throw failure('SERVICE_FILE_CONFLICT', 'An unrelated service file already exists.');
    } finally { fs.closeSync(descriptor); }
  }
  const receipt = { version: 1, id: randomUUID(), file: plan.file, present, sha256: manifest == null ? null : createHash('sha256').update(manifest).digest('hex') };
  if (manifestSnapshots.size >= 16) manifestSnapshots.delete(manifestSnapshots.keys().next().value);
  manifestSnapshots.set(receipt.id, { receipt: { ...receipt }, plan: { ...plan, environment: { ...plan.environment } }, manifest, mode, restored: false }); return receipt;
}
export function restoreCoreServiceManifest(receipt, { plan = servicePlan(), run = defaultRun } = {}) {
  const saved = receipt?.id && manifestSnapshots.get(receipt.id);
  if (!saved || JSON.stringify(saved.receipt) !== JSON.stringify(receipt) || saved.plan.id !== plan.id || saved.plan.file !== plan.file ||
      saved.plan.coreHome !== plan.coreHome || saved.plan.uid !== plan.uid) throw failure('SERVICE_SNAPSHOT_STALE', 'The service rollback receipt changed or belongs to another private context.');
  const current = installed(plan), manager = serviceStatus(plan, { run, inspectMissing: true });
  if (!manager.available) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'Core could not verify its unloaded service before restoring the previous manifest.');
  if (!nativeStopped(plan, manager)) throw failure('SERVICE_RUNNING', 'Suspend Core control before restoring its service manifest.');
  if (!receipt.present) {
    if (current) fs.unlinkSync(plan.file);
  } else {
    if (createHash('sha256').update(saved.manifest).digest('hex') !== receipt.sha256) throw failure('SERVICE_SNAPSHOT_STALE', 'The service rollback snapshot failed its integrity check.');
    const parent = path.dirname(plan.file); ownerOnly(parent, { directory: true, uid: plan.uid });
    const temporary = `${plan.file}.${randomUUID()}.rollback`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', saved.mode);
      try { fs.writeFileSync(descriptor, saved.manifest); fs.fchmodSync(descriptor, saved.mode); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, plan.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  saved.restored = true;
  return { restored: true, installed: receipt.present, file: plan.file };
}
export async function startRestoredCoreService(receipt, { attemptId, respectStop = true, runtime, run = defaultRun,
  doctor = installationDoctor, readinessWaitMs = 15000, plan = servicePlan() } = {}) {
  const saved = receipt?.id && manifestSnapshots.get(receipt.id), current = plan;
  if (!saved || !saved.restored || JSON.stringify(saved.receipt) !== JSON.stringify(receipt) || saved.plan.id !== current.id ||
      saved.plan.file !== current.file || saved.plan.coreHome !== current.coreHome || saved.plan.uid !== current.uid) throw failure('SERVICE_SNAPSHOT_STALE', 'Restore this private context’s service snapshot before starting it.');
  if (!saved.receipt.present) throw failure('SERVICE_NOT_INSTALLED', 'The previous installation had no managed service manifest. Start Core explicitly after inspecting its restored installation.');
  installed(saved.plan);
  if (createHash('sha256').update(fs.readFileSync(saved.plan.file)).digest('hex') !== saved.receipt.sha256) throw failure('SERVICE_SNAPSHOT_STALE', 'The restored service manifest changed before recovery.');
  runtime ||= await lifecycleRuntime();
  const result = await startCoreHost({ plan: { ...saved.plan, manifest: saved.manifest }, runtime, run, doctor,
    readinessWaitMs, respectStop, ...(attemptId ? { attemptId } : {}), prepare: false });
  if (!result.managed) throw failure('SERVICE_START_FAILED', 'The restored managed service did not become ready.');
  manifestSnapshots.delete(receipt.id); return result;
}
export const captureCoreService = snapshotCoreServiceManifest;
export const restoreCoreService = restoreCoreServiceManifest;

export function serviceStatus(plan, { run = defaultRun, inspectMissing = false } = {}) {
  const present = installed(plan);
  if (!present && !inspectMissing) return { installed: false, running: false, loaded: false, available: true, state: 'not-installed', file: plan.file };
  const args = plan.platform === 'darwin' ? ['print', `gui/${plan.uid}/${plan.label}`]
    : systemctl(plan, 'show', plan.label, '--property=LoadState,ActiveState,SubState,MainPID,UnitFileState', '--no-pager');
  const result = invoke(run, plan, args, true), output = result?.stdout || '';
  if (result?.error || result?.status !== 0) {
    // A missing job and an inaccessible manager are different states. A
    // successful domain query proves that this owned label is not loaded.
    const domain = plan.platform === 'darwin' && !result?.error ? invoke(run, plan, ['print', `gui/${plan.uid}`], true) : null;
    const available = Boolean(domain && !domain.error && domain.status === 0);
    return { installed: present, running: false, loaded: available ? false : null, available,
      state: available ? 'not-loaded' : 'manager-unavailable', file: plan.file };
  }
  if (plan.platform === 'darwin') {
    const pid = Number(/^\s*pid = (\d+)$/m.exec(output)?.[1]) || null;
    return { installed: present, running: Boolean(pid), loaded: true, available: true,
      state: /^\s*state = ([a-z-]+)$/m.exec(output)?.[1] || 'loaded', pid, file: plan.file };
  }
  const values = Object.fromEntries(output.split('\n').filter(line => line.includes('=')).map(line => line.split('=')));
  const pid = Number(values.MainPID) || null;
  if (!values.LoadState || !values.ActiveState) return { installed: present, running: false, loaded: null, available: false, state: 'manager-unavailable', file: plan.file };
  return { installed: present, running: values.ActiveState === 'active' && Boolean(pid), loaded: values.LoadState === 'loaded', available: true,
    state: /^[a-z-]+$/.test(values.ActiveState) ? values.ActiveState : 'unknown',
    enabled: ['enabled', 'enabled-runtime'].includes(values.UnitFileState), pid, file: plan.file };
}

export async function startService(plan, { run = defaultRun, runtimeRunning = async () => false } = {}) {
  if (!installed(plan, { exact: true })) throw failure('SERVICE_NOT_INSTALLED', 'Run service install first.');
  context(plan, false);
  const status = serviceStatus(plan, { run });
  if (!status.available) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'The user service manager is unavailable. Check service status and user login.');
  if (status.running) return status;
  if (await runtimeRunning()) throw failure('CORE_ALREADY_RUNNING', 'An unsupervised Core is already running. Stop it before starting the managed service.');
  if (plan.platform === 'darwin') {
    invoke(run, plan, ['enable', `gui/${plan.uid}/${plan.label}`]);
    if (status.loaded === false) invoke(run, plan, ['bootstrap', `gui/${plan.uid}`, plan.file]);
    invoke(run, plan, ['kickstart', `gui/${plan.uid}/${plan.label}`]);
  } else {
    invoke(run, plan, systemctl(plan, 'daemon-reload'));
    invoke(run, plan, systemctl(plan, 'enable', '--now', plan.label));
  }
  return { ...serviceStatus(plan, { run }), requested: 'start' };
}
export function stopService(plan, { run = defaultRun, inspectMissing = false } = {}) {
  if (!installed(plan)) {
    if (!inspectMissing) return { installed: false, running: false, state: 'not-installed' };
    const manager = serviceStatus(plan, { run, inspectMissing: true });
    if (!manager.available) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'Core could not inspect its user service. Check service status and user login.');
    if (!manager.loaded) return { ...manager, state: 'stopped' };
    context(plan, false);
  }
  if (plan.platform === 'darwin') {
    invoke(run, plan, ['disable', `gui/${plan.uid}/${plan.label}`]);
    const removed = invoke(run, plan, ['bootout', `gui/${plan.uid}/${plan.label}`], true);
    if (removed?.error || removed?.status !== 0) {
      const status = serviceStatus(plan, { run, inspectMissing });
      if (!status.available || status.loaded !== false) throw failure('SERVICE_MANAGER_UNAVAILABLE', 'Core could not verify that its user service was unloaded. Check service status and user login.');
    }
  } else invoke(run, plan, systemctl(plan, 'disable', '--now', plan.label));
  const status = serviceStatus(plan, { run, inspectMissing });
  return { ...status, ...(nativeStopped(plan, status) ? { state: 'stopped' } : {}), requested: 'stop' };
}
const nativeStopped = (plan, status) => status.available === true &&
  (plan.platform === 'darwin' ? status.loaded === false : !status.running && ['inactive', 'failed'].includes(status.state));
export function uninstallService(plan, options = {}) {
  if (!installed(plan)) return { installed: false, removed: false };
  stopService(plan, options); fs.unlinkSync(plan.file);
  if (plan.platform === 'linux') invoke(options.run || defaultRun, plan, systemctl(plan, 'daemon-reload'));
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
  const scope = platform === 'linux' && process.getuid?.() === 0 && rootExecutionAllowed() ? 'system' : 'user';
  return { ready: major >= 24 && pythonReady && contextReady && managerReady,
    checks: { node: { ready: major >= 24, version: nodeVersion, executable: process.execPath, required: '24+' },
      python: { ready: pythonReady, version: pythonReady ? python.stdout.trim() : null, required: '3.9+', purpose: 'Project ZIP sharing/import' },
      privateContext: { ready: contextReady, directory, exists: Boolean(info), required: 'Owned private directory (mode 700)' },
      userService: { ready: managerReady, manager, scope, required: scope === 'system' ? 'Linux systemd system manager' : 'macOS graphical user login or Linux systemd user manager' } },
    next: 'Configure provider accounts privately on this host, set workspace root, enroll the public Relay identity, then explicitly install/start the Core service. No model is required for pairing/settings.' };
}

async function lifecycleRuntime() {
  const runtime = await import('./runtime.js');
  const current = () => {
    const info = runtime.runtimeInfo(); return info && identityAlive(info.identity) ? info : null;
  };
  return {
    controlIdentity: () => current()?.identity || null,
    controlAlive: identity => identity ? identityAlive(identity) : Boolean(current()),
    clearStop: runtime.clearOperatorStopIntent,
    persistStop: runtime.persistOperatorStopIntent,
    stopped: runtime.operatorStopRequested,
    stopIntent: runtime.operatorStopIntent,
    async status({ timeoutMs = 1000 } = {}) {
      const info = current();
      if (!info) return { running: false };
      try {
        const target = new URL(info.url);
        if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) return { running: false };
        const response = await fetch(info.url + '/health', { headers: { authorization: `Bearer ${info.token}` }, redirect: 'error',
          signal: AbortSignal.timeout(Math.max(1, Math.min(1000, timeoutMs))) });
        if (!response.ok) return { running: false };
        const health = await response.json();
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
  const engine = await runtime.status(), service = serviceStatus(plan, { run, inspectMissing: true });
  return { ...engine, engine, service, managed: sameManagedProcess(engine, service), operatorStopped: runtime.stopped(),
    operatorStopIntent: runtime.stopIntent?.() || null };
}
const sameManagedProcess = (engine, manager) => engine.running === true && manager.running === true &&
  Number.isSafeInteger(engine.pid) && engine.pid > 0 && engine.pid === manager.pid;

export async function startCoreHost({ plan = servicePlan(), runtime, run = defaultRun, doctor = installationDoctor,
  prepare = true, readinessWaitMs = 15000, attemptId = process.env.BZZY_CORE_START_ATTEMPT_ID || randomUUID(),
  respectStop = process.env.BZZY_CORE_RESPECT_STOP === '1' } = {}) {
  assertCoreAvailable(plan.coreHome);
  if (!Number.isSafeInteger(readinessWaitMs) || readinessWaitMs < 50 || readinessWaitMs > 15000) throw failure('SERVICE_USAGE', 'Service readiness wait must be 50–15000 milliseconds.');
  if (typeof respectStop !== 'boolean' || typeof attemptId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attemptId)) throw failure('SERVICE_USAGE', 'Supply a valid Core start attempt and stop policy.');
  if (!runtime) (await import('../relay/service.js')).prepareRelayService();
  runtime ||= await lifecycleRuntime();
  const ready = doctor();
  if (!ready.ready) throw failure('SERVICE_PREREQUISITES', 'Run bzzy-core doctor and resolve Node/Python/private-directory prerequisites before starting.');
  if (!installed(plan)) {
    if (!prepare) return { managed: false };
    installService(plan, { run });
  }
  // A configuration mismatch is never a concurrent-launch success. Validate
  // it before changing the operator gate or invoking the service manager.
  installed(plan, { exact: true });
  const manager = serviceStatus(plan, { run }), engine = await runtime.status();
  if (respectStop && runtime.stopped()) throw failure('CORE_STOPPED', 'Core was stopped by the local operator. The update did not reactivate it.');
  if (runtime.stopped() && (manager.running || engine.running)) {
    throw failure('CORE_STOPPED', 'Core is still quiescing. Run bzzy-core restart to finish the stop before reactivating it.');
  }
  if (engine.running && !sameManagedProcess(engine, manager)) throw failure('CORE_ALREADY_RUNNING', 'Core is running outside the user service. Run bzzy-core restart to migrate it safely.');
  if (!respectStop) runtime.clearStop();
  try { await startService(plan, { run, runtimeRunning: async () => (await runtime.status()).running }); }
  catch (error) {
    // A concurrent explicit launcher may have loaded the same service first.
    // Otherwise preserve the operator gate: routine clients must not turn a
    // failed supervised start into an unsupervised fallback.
    installed(plan, { exact: true });
    const current = serviceStatus(plan, { run });
    if (error.code !== 'SERVICE_MANAGER_UNAVAILABLE' || !current.available || !current.loaded) {
      runtime.persistStop({ source: 'service_start_failure', attemptId }); throw error;
    }
  }
  const deadline = Date.now() + readinessWaitMs;
  let current, supervisor;
  do {
    if (respectStop && runtime.stopped()) throw failure('CORE_STOPPED', 'Core was stopped by the local operator. The update did not reactivate it.');
    current = await runtime.status({ timeoutMs: Math.max(1, deadline - Date.now()) }); supervisor = serviceStatus(plan, { run });
    if (respectStop && runtime.stopped()) throw failure('CORE_STOPPED', 'Core was stopped by the local operator. The update did not reactivate it.');
    if (sameManagedProcess(current, supervisor)) break;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (!sameManagedProcess(current, supervisor)) {
    runtime.persistStop({ source: 'service_start_failure', attemptId });
    throw failure('SERVICE_START_FAILED', 'The user service did not become ready. Check bzzy-core status and private supervisor logs.');
  }
  return { ...current, engine: current, service: supervisor, managed: true };
}

export async function clearCoreStartFailure(attemptId, { runtime } = {}) {
  if (typeof attemptId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attemptId)) throw failure('SERVICE_USAGE', 'Supply the exact Core start attempt.');
  runtime ||= await lifecycleRuntime();
  return runtime.clearStop({ expectedSource: 'service_start_failure', expectedAttemptId: attemptId }) === true;
}

async function waitForStoppedControl(plan, runtime, run, identities, processes, code, supervisorExpected) {
  const deadline = Date.now() + 15000;
  do {
    const manager = serviceStatus(plan, { run, inspectMissing: true });
    supervisorExpected ||= manager.installed || manager.loaded === true;
    const alive = identities.some(identity => processes.alive(identity)) ||
      (runtime.controlAlive ? await runtime.controlAlive() : (await runtime.status()).running);
    // Source/programmatic contexts may never have prepared a user service.
    // Their authenticated daemon still must exit, but an unavailable manager
    // cannot prove a configured supervisor exists. Once one was configured or
    // observed, keep the strict native-unload barrier for the entire handoff.
    const nativeVerified = nativeStopped(plan, manager) || !supervisorExpected && !manager.installed && manager.loaded !== true;
    if (nativeVerified && !alive) return manager;
    if (Date.now() >= deadline) throw failure(code, 'Core control or its user service has not finished shutting down; existing runners were retained.');
    await delay(50);
  } while (true);
}

export async function stopCoreHost({ plan = servicePlan(), runtime, run = defaultRun,
  processes = { identity: processIdentity, alive: identityAlive } } = {}) {
  runtime ||= await lifecycleRuntime();
  runtime.persistStop();
  const manager = serviceStatus(plan, { run, inspectMissing: true });
  const identities = [runtime.controlIdentity?.(), manager.pid && processes.identity(manager.pid)].filter(Boolean);
  // The operator barrier rejects new work while every existing execution is
  // paused. Keep the supervisor loaded if verification fails.
  const result = await runtime.quiesce(manager.running);
  if (result.quiesced !== true && result.stopped !== true) throw failure('STOP_INCOMPLETE', 'Core could not verify that all work stopped.');
  if (manager.installed || manager.loaded) stopService(plan, { run, inspectMissing: true });
  await waitForStoppedControl(plan, runtime, run, identities, processes, 'STOP_INCOMPLETE', manager.installed || manager.loaded === true);
  return { running: false, stopped: true, pausedExecutions: result.pausedExecutions || 0, runningAgentsContinue: false,
    service: serviceStatus(plan, { run }) };
}

export async function suspendCoreHost({ plan = servicePlan(), runtime, run = defaultRun,
  processes = { identity: processIdentity, alive: identityAlive } } = {}) {
  runtime ||= await lifecycleRuntime();
  const manager = serviceStatus(plan, { run, inspectMissing: true });
  const identities = [runtime.controlIdentity?.(), manager.pid && processes.identity(manager.pid)].filter(Boolean);
  // Service manifests explicitly abandon descendants / use KillMode=process.
  // Unload only the control daemon; execution runners keep their identities.
  if (manager.installed || manager.loaded) stopService(plan, { run, inspectMissing: true });
  if ((await runtime.status()).running) {
    const result = await runtime.shutdown();
    if (result.runningAgentsContinue !== true) throw failure('RESTART_INCOMPLETE', 'Core could not confirm execution-preserving shutdown.');
  }
  await waitForStoppedControl(plan, runtime, run, identities, processes, 'RESTART_INCOMPLETE', manager.installed || manager.loaded === true);
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
