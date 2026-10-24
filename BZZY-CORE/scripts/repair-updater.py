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
        source = launcher.resolve()
        body = source.read_text()
        if '# bzzy-managed launcher' in body:
            entries = [shlex.split(line) for line in body.splitlines() if line.startswith('exec ')]
            if len(entries) != 1 or len(entries[0]) != 4 or entries[0][-1] != '$@':
                raise RuntimeError('Unrecognized launcher. Use --installation and --node explicitly.')
            node = node or Path(entries[0][1])
            directory = Path(entries[0][2]).parent.parent
            launcher_bin = launcher.parent
        else:
            directory = source.parent.parent
    directory = directory.resolve(strict=True)
    package = json.loads((directory / 'package.json').read_text())
    if package.get('name') not in ('bzzy-cli', '@bzzy/core'):
        raise RuntimeError('Choose the installed BZZY CLI or Core package directory.')
    node = str(node or shutil.which('node') or '')
    if not node:
        raise RuntimeError('Node.js 24+ is required. Use --node with the installed Node executable.')
    version = subprocess.run([node, '--version'], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
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
