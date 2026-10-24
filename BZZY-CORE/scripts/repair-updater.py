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
        if '# bzzy-managed launcher' in body or source.name not in ('bzzy.js', 'bzzy-core.js'):
            try:
                # Shell continuations join physical lines before tokenization.
                # shlex.split on an isolated `exec \` line raises ValueError.
                logical = re.sub(r'\\\r?\n', '', body)
                entries = [shlex.split(line) for line in logical.splitlines() if line.lstrip().startswith('exec ')]
            except ValueError:
                raise RuntimeError('REPAIR_LAUNCHER_FORMAT: The launcher command could not be parsed. Use --installation and --node explicitly.')
            if len(entries) != 1 or len(entries[0]) != 4 or entries[0][-1] != '$@':
                raise RuntimeError('Unrecognized launcher. Use --installation and --node explicitly.')
            node = node or Path(entries[0][1])
            directory = Path(entries[0][2]).parent.parent
            launcher_bin = launcher.parent
        else:
            directory = source.parent.parent
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
            raise RuntimeError('Could not download the official BZZY repair. Check GitHub access and Git authentication.')
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
