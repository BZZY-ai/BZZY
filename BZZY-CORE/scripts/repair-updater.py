#!/usr/bin/env python3
"""Bootstrap official release staging when an older updater blocks local files."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

REPOSITORY = 'https://github.com/BZZY-ai/BZZY.git'
WRAPPER_ENVIRONMENT = frozenset(('HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
                                 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'BZZY_HOME', 'BZZY_LAUNCHER_BIN_DIR'))


def launcher_environment(value, environment):
    """Expand only ordinary environment references; never evaluate shell code."""
    pattern = r'\$(?:\{([A-Za-z_]\w*)(?:(:-|-)([^{}$`]*))?\}|([A-Za-z_]\w*))'
    def replace(match):
        name, operator, default, simple = match.groups()
        name = name or simple
        if name not in WRAPPER_ENVIRONMENT:
            raise RuntimeError('REPAIR_WRAPPER_ENVIRONMENT: Unsupported launcher environment reference. No values were displayed or changed.')
        existing = environment.get(name)
        return (default or '') if existing is None or operator == ':-' and not existing else existing
    expanded = re.sub(pattern, replace, value)
    if '$' in expanded or '`' in expanded:
        raise RuntimeError('REPAIR_WRAPPER_ENVIRONMENT: Shell evaluation in the launcher is unsupported. No command was executed.')
    return expanded


def inspect_launcher(launcher, environment, seen=()):
    """Read wrappers as data, including an existing runuser/sudo account boundary."""
    launcher = Path(launcher)
    try:
        source = launcher.resolve(strict=True)
        body = source.read_text()
    except FileNotFoundError:
        raise RuntimeError('REPAIR_LAUNCHER_MISSING: The BZZY launcher points to a missing file. Use --installation with the current CLI or Core package path.')
    except PermissionError:
        raise RuntimeError('REPAIR_LAUNCHER_PERMISSION: Run the repair as the account that owns the BZZY installation.')
    except UnicodeError:
        raise RuntimeError('REPAIR_LAUNCHER_FORMAT: This launcher is not a text script. Use --installation and --node with the installed paths.')
    if source in seen or len(seen) >= 4:
        raise RuntimeError('REPAIR_LAUNCHER_LOOP: The launcher chain is cyclic or too long. No launcher was executed.')
    if source.name in ('bzzy.js', 'bzzy-core.js'):
        return source.parent.parent, None, None, None
    try:
        logical = re.sub(r'\\\r?\n', '', body)
        entries = [shlex.split(line, comments=True) for line in logical.splitlines() if line.lstrip().startswith('exec ')]
    except ValueError:
        raise RuntimeError('REPAIR_LAUNCHER_FORMAT: The launcher command could not be parsed. Use --installation and --node explicitly.')
    if len(entries) != 1 or not entries[0] or entries[0][-1] != '$@':
        raise RuntimeError('Unrecognized launcher. Use --installation and --node explicitly.')
    command = entries[0]
    if len(command) >= 8 and Path(command[1]).name in ('runuser', 'sudo') and command[2] == '-u' and command[4] == '--' and Path(command[5]).name == 'env':
        import pwd
        try:
            account = pwd.getpwnam(command[3])
        except KeyError:
            raise RuntimeError('REPAIR_WRAPPER_ACCOUNT: The existing launcher account does not exist. No account or permissions were changed.')
        if account.pw_uid <= 0:
            raise RuntimeError('REPAIR_WRAPPER_ACCOUNT: The wrapper must select an existing non-root BZZY account.')
        if os.geteuid() not in (0, account.pw_uid):
            raise RuntimeError('REPAIR_WRAPPER_ACCOUNT: Run the repair as the BZZY installation account or through its existing root wrapper.')
        selected = {'HOME': account.pw_dir, 'USER': account.pw_name, 'LOGNAME': account.pw_name,
                    'SHELL': account.pw_shell, 'PATH': '/usr/local/bin:/usr/bin:/bin'}
        arguments = command[6:-1]
        while arguments and re.match(r'^[A-Za-z_]\w*=', arguments[0]):
            name, value = arguments.pop(0).split('=', 1)
            if name not in WRAPPER_ENVIRONMENT:
                raise RuntimeError('REPAIR_WRAPPER_ENVIRONMENT: Unsupported launcher environment assignment. No values were displayed or changed.')
            selected[name] = launcher_environment(value, environment)
        if len(arguments) != 1 or not Path(arguments[0]).is_absolute() or selected['HOME'] != account.pw_dir:
            raise RuntimeError('REPAIR_WRAPPER_FORMAT: Expected the existing account home and one absolute inner launcher path. No command was executed.')
        directory, node, launcher_bin, nested = inspect_launcher(arguments[0], selected, (*seen, source))
        if nested:
            raise RuntimeError('REPAIR_WRAPPER_FORMAT: Multiple account switches are unsupported. No command was executed.')
        return directory, node, launcher_bin, (account, selected)
    if len(command) != 4 or not Path(command[1]).is_absolute() or not Path(command[2]).is_absolute():
        raise RuntimeError('Unrecognized launcher. Use --installation and --node explicitly.')
    return Path(command[2]).parent.parent, Path(command[1]), launcher.parent, None


def repair_as_account(account, environment, directory, node, launcher_bin):
    """Drop to the wrapper's existing owner before running Node, Git or installers."""
    if not sys.platform.startswith('linux'):
        raise RuntimeError('REPAIR_WRAPPER_ACCOUNT: Run the repair directly as the BZZY installation account on this platform.')
    environment = dict(environment)
    if launcher_bin:
        environment['BZZY_LAUNCHER_BIN_DIR'] = str(launcher_bin)
    arguments = [sys.executable, '-I', '-', '--installation', str(directory)]
    if node:
        arguments.extend(('--node', str(node)))
    print('Repairing as the existing non-root BZZY account. Root wrappers and private state are retained.', flush=True)
    result = subprocess.run(arguments, input=Path(__file__).read_text(), text=True, env=environment, cwd=account.pw_dir,
                            user=account.pw_uid, group=account.pw_gid,
                            extra_groups=os.getgrouplist(account.pw_name, account.pw_gid), umask=0o077)
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description='Repair an older BZZY updater without modifying the original installation or private state. Run as your usual BZZY user.')
    parser.add_argument('--installation', type=Path, help='CLI or standalone Core package directory, if no BZZY launcher is on PATH')
    parser.add_argument('--node', type=Path, help='Node.js 24+ executable, if the installed launcher cannot supply it')
    args = parser.parse_args()
    directory, node, launcher_bin = args.installation, args.node, None
    if directory is None:
        launcher = shutil.which('bzzy') or shutil.which('bzzy-core')
        if not launcher:
            raise RuntimeError('BZZY is not on PATH. Use --installation and --node for its installed paths.')
        directory, detected_node, launcher_bin, wrapper = inspect_launcher(launcher, os.environ)
        node = node or detected_node
        if wrapper:
            account, selected = wrapper
            if os.geteuid() != account.pw_uid:
                sys.exit(repair_as_account(account, selected, directory, node, launcher_bin))
            os.environ.update(selected)
    try:
        directory = directory.resolve(strict=True)
    except FileNotFoundError:
        raise RuntimeError('REPAIR_INSTALL_MISSING: The launcher refers to a missing installation directory. Use --installation with the current CLI or Core package path.')
    except PermissionError:
        raise RuntimeError('REPAIR_INSTALL_PERMISSION: Run the repair as the account that owns the BZZY installation.')
    try:
        package = json.loads((directory / 'package.json').read_text())
    except FileNotFoundError:
        raise RuntimeError('REPAIR_PACKAGE_MISSING: No package.json exists at the detected installation. Use --installation with the CLI or Core package directory, not its launcher folder.')
    except PermissionError:
        raise RuntimeError('REPAIR_PACKAGE_PERMISSION: The installed package metadata is unreadable. Run as the BZZY installation account.')
    except (ValueError, UnicodeError):
        raise RuntimeError('REPAIR_PACKAGE_INVALID: The detected package.json is invalid. Its contents were not displayed or changed.')
    if not isinstance(package, dict):
        raise RuntimeError('REPAIR_PACKAGE_INVALID: The detected package.json must contain a package object. Its contents were not displayed or changed.')
    if package.get('name') not in ('bzzy-cli', '@bzzy/core'):
        raise RuntimeError('Choose the installed BZZY CLI or Core package directory.')
    node = str(node or shutil.which('node') or '')
    if not node:
        raise RuntimeError('Node.js 24+ is required. Use --node with the installed Node executable.')
    try:
        result = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        raise RuntimeError('REPAIR_NODE_MISSING: The launcher’s Node executable no longer exists. Use --node with a working Node.js 24+ executable.')
    except PermissionError:
        raise RuntimeError('REPAIR_NODE_PERMISSION: The selected Node executable cannot be run by this account.')
    except OSError:
        raise RuntimeError('REPAIR_NODE_START_FAILED: The selected Node executable could not start. Check its platform and executable format.')
    except subprocess.TimeoutExpired:
        raise RuntimeError('REPAIR_NODE_TIMEOUT: The selected Node executable did not answer --version.')
    if result.returncode:
        raise RuntimeError('REPAIR_NODE_FAILED: The selected Node executable failed --version. Use --node with a working Node.js 24+ executable.')
    version = result.stdout.strip()
    if not re.fullmatch(r'v\d+\.\d+\.\d+', version) or int(version[1:].split('.')[0]) < 24:
        raise RuntimeError('Node.js 24+ is required. Use --node with the installed Node executable.')
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'Never'}
    if launcher_bin:
        env['BZZY_LAUNCHER_BIN_DIR'] = str(launcher_bin)
    def git(*command, cwd=None):
        result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', *command], cwd=cwd, env=env,
                                capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise RuntimeError('Could not download the official BZZY repair. Check GitHub access and Git authentication for the BZZY installation account.')
        return result.stdout.strip()
    head = git('ls-remote', '--symref', REPOSITORY, 'HEAD')
    match = re.search(r'^([a-f0-9]{40,64})\s+HEAD$', head, re.MULTILINE)
    if not match:
        raise RuntimeError('GitHub did not return a valid BZZY revision.')
    target = match.group(1)
    print('Preparing the official updater. The existing installation and local files will be retained.', flush=True)
    with tempfile.TemporaryDirectory(prefix='bzzy-updater-repair-') as temporary:
        source = Path(temporary) / 'source'
        git('clone', '--no-checkout', '--origin', 'origin', REPOSITORY, str(source))
        git('fetch', '--no-tags', 'origin', target, cwd=source)
        git('checkout', '--detach', target, cwd=source)
        if git('rev-parse', 'HEAD', cwd=source) != target:
            raise RuntimeError('The downloaded repair revision could not be verified.')
        helper = source / 'BZZY-CORE/src/engine/installation-update.js'
        code = "import { pathToFileURL } from 'node:url'; const { updateRepositoryInstallation } = await import(pathToFileURL(process.argv[1]).href); await updateRepositoryInstallation(process.argv[2], { expectedCommit: process.argv[3] });"
        result = subprocess.run([node, '--input-type=module', '-e', code, str(helper), str(directory), target], env=env)
        if result.returncode:
            raise RuntimeError('Update repair did not finish. The original installation is retained; check the reported installation error before retrying.')
    print('BZZY updater repaired and CLI/Core updated. Reopen BZZY; future updates use bzzy --update.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        # Do not forward subprocess output, key material or private config data.
        message = str(error) if isinstance(error, RuntimeError) else 'Could not inspect or update BZZY. Check the installed paths, permissions and Node.js 24+.'
        print(message, file=sys.stderr)
        sys.exit(1)
