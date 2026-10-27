import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const marker = '# bzzy-managed launcher';
const statAt = file => { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

// Parse account wrappers as data. Commands and private environment values are
// never executed, copied into the new launcher or printed.
export function accountWrapper(body) {
  const code = String.raw`import json, pathlib, re, shlex, sys
try:
    lines = re.sub(r'\\\r?\n', '', sys.stdin.read()).splitlines()
    commands = [shlex.split(line, comments=True) for line in lines if line.lstrip().startswith('exec ')]
    command = commands[0] if len(commands) == 1 else []
    valid = len(command) >= 8 and command[0] == 'exec' and pathlib.Path(command[1]).is_absolute() and pathlib.Path(command[1]).name in ('runuser', 'sudo') and command[2] == '-u' and bool(command[3]) and command[4] == '--' and pathlib.Path(command[5]).name == 'env' and command[-1] == '$@'
    arguments = command[6:-1]
    while arguments and re.match(r'^[A-Za-z_]\w*=', arguments[0]):
        arguments.pop(0)
    print(json.dumps(bool(valid and len(arguments) == 1 and pathlib.Path(arguments[0]).is_absolute())))
except (ValueError, IndexError):
    print('false')`;
  const python = process.getuid?.() === 0 ? '/usr/bin/python3' : 'python3';
  const result = spawnSync(python, ['-I', '-c', code], { input: body, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 });
  return !result.error && result.status === 0 && result.stdout.trim() === 'true';
}

export function planLaunchers(binDir, node, options = {}) {
  const { replaceAccountWrapper = false, platform = process.platform, uid = process.getuid?.() } = options;
  if (replaceAccountWrapper && (platform !== 'linux' || uid !== 0)) throw new Error('--replace-account-wrapper requires an explicit Linux root installation.');
  node = fs.realpathSync(node);
  const directory = fs.lstatSync(binDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || directory.mode & 0o022) throw new Error('Use an owned launcher directory that other accounts cannot change.');
  const plan = ['bzzy', 'bzzy-core'].map(name => {
    const target = path.join(binDir, name), stat = statAt(target);
    let previous = null, backup = false;
    if (stat) {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || stat.mode & 0o022 || stat.size > 65536) throw new Error(`Refusing unsafe launcher ${target}.`);
      previous = fs.readFileSync(target, 'utf8');
      if (replaceAccountWrapper && accountWrapper(previous)) backup = true;
      else if (!previous.includes(marker)) throw new Error(`Refusing to overwrite unrelated executable ${target}. Choose BZZY_BIN_DIR.`);
    }
    const body = `#!/bin/sh\n${marker}\nexport PATH=${quote(path.dirname(node))}:"$PATH"\nexport BZZY_LAUNCHER_BIN_DIR=${quote(binDir)}\nexec ${quote(node)} ${quote(path.join(root, 'bin', name === 'bzzy' ? 'bzzy.js' : 'bzzy-core.js'))} "$@"\n`;
    return { target, body, previous, mode: stat?.mode & 0o777, backup };
  });
  if (plan.some(item => item.backup)) privateBackupDirectory(options, false);
  return plan;
}

function privateBackupDirectory({ backupDirectory, uid = process.getuid?.() }, create = true) {
  const coreHome = path.resolve(process.env.BZZY_HOME || path.join(os.homedir(), '.bzzy'));
  const destination = backupDirectory ? path.resolve(backupDirectory) : path.join(coreHome, 'runtime', 'launcher-backups');
  const directories = backupDirectory ? [path.dirname(destination), destination]
    : [coreHome, path.join(coreHome, 'runtime'), destination];
  for (const directory of directories) {
    let stat = statAt(directory);
    if (!stat) {
      if (!create) continue;
      fs.mkdirSync(directory, { mode: 0o700 }); stat = fs.lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & 0o077) throw new Error('Launcher backups require owned private directories (mode 700).');
  }
  return destination;
}

export function installLaunchers(binDir, node, options = {}) {
  // Validate both names before backing up or replacing either launcher.
  const plan = planLaunchers(binDir, node, options), changed = [], backups = [];
  const backupDirectory = plan.some(item => item.backup) ? privateBackupDirectory(options) : null;
  try {
    for (const item of plan) if (item.backup) {
      const file = path.join(backupDirectory, `${path.basename(item.target)}.before-root-${randomUUID()}`);
      fs.writeFileSync(file, item.previous, { mode: 0o600, flag: 'wx' }); backups.push(file);
    }
    for (const item of plan) {
      const temporary = `${item.target}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, item.body, { mode: 0o755, flag: 'wx' });
        fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, item.target); changed.push(item);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
  } catch (error) {
    for (const item of changed.reverse()) {
      if (item.previous === null) fs.rmSync(item.target, { force: true });
      else { fs.writeFileSync(item.target, item.previous, { mode: item.mode }); fs.chmodSync(item.target, item.mode); }
    }
    throw error;
  }
  return backups;
}

function updateShellPath(binDir) {
  const shell = path.basename(process.env.SHELL || 'bash');
  if (!['bash', 'zsh', 'sh'].includes(shell)) { console.log('Add the printed PATH command to your shell configuration.'); return; }
  const files = shell === 'zsh' ? ['.zshrc', '.zprofile'] : shell === 'bash' ? ['.bashrc', '.profile', ...(fs.existsSync(path.join(os.homedir(), '.bash_profile')) ? ['.bash_profile'] : [])] : ['.profile'];
  const line = `export PATH=${quote(binDir)}:"$PATH" # bzzy PATH`;
  for (const name of files) {
    const file = path.join(os.homedir(), name), contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (!contents.includes(line)) fs.appendFileSync(file, `\n${line}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [binDir, node, ...flags] = process.argv.slice(2);
  if (!binDir || !node || flags.some(flag => !['--path', '--check', '--replace-account-wrapper'].includes(flag))) throw new Error('Invalid launcher installation arguments.');
  const options = { replaceAccountWrapper: flags.includes('--replace-account-wrapper') };
  if (flags.includes('--check')) planLaunchers(binDir, node, options);
  else if (flags.includes('--path')) updateShellPath(binDir);
  else for (const backup of installLaunchers(binDir, node, options)) console.log(`Previous account-switching launcher retained at ${backup}`);
}
