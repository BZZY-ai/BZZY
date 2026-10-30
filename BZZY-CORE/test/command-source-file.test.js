import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchedSourceFile } from '../src/engine/command-source-file.js';
import { createSourceObserver } from '../src/engine/source-preview.js';

test('direct interpreter launches identify explicit source paths without shell expansion or execution', () => {
  for (const [command, expected] of [
    ["/bin/bash -c 'python3 recon/new-sqli/probe.py --host example.test'", 'recon/new-sqli/probe.py'],
    [['/bin/bash', '-lc', 'python3 -u "recon/my probe.py"'], 'recon/my probe.py'],
    [['python3', '-I', '-X', 'utf8', '/tmp/actual.py'], '/tmp/actual.py'],
    ['env EXAMPLE=1 node --enable-source-maps scripts/probe.js', 'scripts/probe.js'],
    ['exec /usr/bin/python3 -B ./probe.py', './probe.py'],
    ['bash -eu scripts/test.sh', 'scripts/test.sh'],
    ['python3 recon/probe.py --url https://example.test?q=1', 'recon/probe.py'],
    ["/bin/bash -c 'python3 recon/probe.py > logs/output.txt'", 'recon/probe.py'],
  ]) assert.equal(launchedSourceFile(command), expected);
  for (const command of [
    'python3 -c "print(1)"', 'python3 -m requests', 'node --eval "run()"', 'cat probe.py',
    'python3 "$SCRIPT"', 'python3 $(find .)', 'cd recon && python3 probe.py',
    'python3 *.py', 'echo python3 probe.py', 'python3 --unknown maybe.py',
    'python3 - <<PY\nprint(1)\nPY', "python3 'unfinished", 'python3 --',
  ]) assert.equal(launchedSourceFile(command), null, String(command));
});
test('CODE receives actual file contents immediately at native command start, with completion and private-path guards', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bzzy-script-source-')), cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const events = [], observe = createSourceObserver({ id: 'source-fixture', cwd }, (type, data) => events.push({ type, data }));
  const launch = command => observe({ method: 'item/started', params: { item: { id: 'launch', type: 'commandExecution', command, cwd } } });
  try {
    fs.mkdirSync(path.join(cwd, 'recon')); fs.writeFileSync(path.join(cwd, 'recon', 'probe.py'), 'import requests\nprint("actual script")\n');
    launch(['/bin/bash', '-c', 'python3 recon/probe.py']);
    assert.equal(events.at(-1).data.sourceKind, 'executed-file'); assert.equal(events.at(-1).data.phase, 'running');
    assert.equal(events.at(-1).data.path, 'recon/probe.py'); assert.equal(events.at(-1).data.language, 'py');
    assert.equal(events.at(-1).data.content, 'import requests\nprint("actual script")\n');
    fs.writeFileSync(path.join(cwd, 'recon', 'probe.py'), 'print("actual final source")');
    observe({ method: 'item/completed', params: { item: { id: 'launch', type: 'commandExecution', command: 'python3 recon/probe.py', status: 'completed' } } });
    assert.equal(events.at(-1).data.phase, 'completed'); assert.equal(events.at(-1).data.content, 'print("actual final source")');
    observe({ method: 'item/started', params: { item: { id: 'relative-launch', type: 'commandExecution', command: ['python3', 'probe.py'], cwd: 'recon' } } });
    assert.equal(events.at(-1).data.path, 'recon/probe.py');
    observe({ method: 'item/completed', params: { item: { id: 'relative-launch', type: 'commandExecution', status: 'completed' } } });
    assert.equal(events.at(-1).data.path, 'recon/probe.py'); assert.equal(events.at(-1).data.phase, 'completed');
    fs.writeFileSync(path.join(directory, 'outside.py'), 'PRIVATE_OUTSIDE_CONTENT');
    fs.writeFileSync(path.join(cwd, '.env.py'), 'PRIVATE_ENV_CONTENT');
    fs.mkdirSync(path.join(cwd, '.git', 'hooks'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.git', 'hooks', 'secret.py'), 'PRIVATE_GIT_CONTENT');
    for (const file of ['../outside.py', '.env.py', '.git/hooks/secret.py']) {
      const before = events.filter(row => row.data.sourceKind === 'executed-file').length;
      launch(['python3', file]); assert.equal(events.filter(row => row.data.sourceKind === 'executed-file').length, before);
    }
    fs.writeFileSync(path.join(directory, 'outside.py'), 'PRIVATE_OUTSIDE_CONTENT');
    fs.symlinkSync(path.join(directory, 'outside.py'), path.join(cwd, 'link.py')); launch(['python3', 'link.py']);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_OUTSIDE_CONTENT/);
    const before = events.length; launch(['python3', 'missing.py']);
    assert.deepEqual(events.slice(before).map(row => row.type), ['command.observed', 'source.changed'], 'missing scripts retain only actual command input, without fabricated file contents');
    observe({ method: 'tool.started', params: { id: 'claude-launch', name: 'Bash', input: { command: 'python3 recon/probe.py' } } });
    assert.equal(events.at(-1).data.provenance, 'native-script-launch');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
