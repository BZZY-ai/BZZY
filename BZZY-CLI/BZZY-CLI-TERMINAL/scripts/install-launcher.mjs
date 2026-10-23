import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const [binDir, node, updatePath] = process.argv.slice(2);
const root = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const marker = '# bzzy-managed launcher';
// Check both names before replacing either managed launcher.
for (const name of ['bzzy', 'bzzy-core']) {
  const target = path.join(binDir, name);
  if (fs.existsSync(target) && !fs.readFileSync(target, 'utf8').includes(marker)) throw new Error(`Refusing to overwrite unrelated executable ${target}. Choose BZZY_BIN_DIR.`);
}
for (const name of ['bzzy', 'bzzy-core']) {
  const target = path.join(binDir, name);
  fs.writeFileSync(target, `#!/bin/sh\n${marker}\nexport PATH=${quote(path.dirname(node))}:"$PATH"\nexport BZZY_LAUNCHER_BIN_DIR=${quote(binDir)}\nexec ${quote(node)} ${quote(path.join(root, 'bin', name === 'bzzy' ? 'bzzy.js' : 'bzzy-core.js'))} "$@"\n`, { mode: 0o755 });
  fs.chmodSync(target, 0o755);
}
if (updatePath === '--path') {
  const shell = path.basename(process.env.SHELL || 'bash');
  if (!['bash', 'zsh', 'sh'].includes(shell)) {
    console.log('Add the printed PATH command to your shell configuration.');
  } else {
    const files = shell === 'zsh' ? ['.zshrc', '.zprofile'] : shell === 'bash' ? ['.bashrc', '.profile', ...(fs.existsSync(path.join(os.homedir(), '.bash_profile')) ? ['.bash_profile'] : [])] : ['.profile'];
    const line = `export PATH=${quote(binDir)}:"$PATH" # bzzy PATH`;
    for (const name of files) {
      const file = path.join(os.homedir(), name);
      const contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (!contents.includes(line)) fs.appendFileSync(file, `\n${line}\n`);
    }
  }
}
