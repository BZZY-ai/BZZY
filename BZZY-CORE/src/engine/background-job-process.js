import { spawn } from 'node:child_process';

// An inert process-group leader. The supervisor records this process's verified
// identity before granting permission to spawn the script. IPC loss kills the
// whole group, including descendants, if the supervisor itself crashes.
const killGroup = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
process.once('disconnect', killGroup);
process.on('SIGTERM', () => {}); // Remain group leader until the kill deadline.
const timer = setTimeout(killGroup, 15_000);
process.once('message', message => {
  if (message?.type !== 'go') return killGroup();
  clearTimeout(timer);
  const child = spawn(message.command[0], [...message.command.slice(1), ...message.args], {
    cwd: message.cwd, env: process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  let finished = false;
  const finish = result => {
    if (finished) return; finished = true;
    if (process.connected) process.send({ type: 'result', ...result }, () => setTimeout(killGroup, 30));
    else killGroup();
  };
  child.once('error', () => finish({ exitCode: null, code: 'JOB_START_FAILED' }));
  child.once('exit', (exitCode, signal) => finish({ exitCode, signal }));
});
process.send?.({ type: 'ready' });
