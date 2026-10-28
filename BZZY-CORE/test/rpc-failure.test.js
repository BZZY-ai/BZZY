import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Rpc } from '../src/engine/rpc.js';
import { rpcFailure } from '../src/engine/rpc-failure.js';
import { markBackendStartupFailure, backendStartupFailure } from '../src/engine/backend-startup.js';

function transport(t, source) {
  const child = spawn(process.execPath, ['-e', source], { detached: true, env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = new Rpc(child, async () => { throw new Error('The fixture requests no tools.'); });
  rpc.on('failure', () => {});
  t.after(() => rpc.close()); return rpc;
}

test('a native process exit retains only a trusted bounded exit code in the startup receipt', async t => {
  const rpc = transport(t, "process.stderr.write('SYNTHETIC_PRIVATE_STDERR_DETAIL'); process.exit(23)");
  await assert.rejects(rpc.request('initialize', {}, 5000), error => {
    assert.deepEqual(rpcFailure(error), { kind: 'process_exit', exitCode: 23 });
    const failure = backendStartupFailure(markBackendStartupFailure(error, 'initialize'));
    assert.deepEqual(failure, { version: 1, backend: 'codex', stage: 'initialize', modelRequestStarted: false,
      transportFailure: { kind: 'process_exit', exitCode: 23 } });
    assert.doesNotMatch(JSON.stringify(failure), /SYNTHETIC_PRIVATE|stderr|initialize.*arguments/);
    failure.transportFailure.exitCode = 99;
    assert.equal(backendStartupFailure(error).transportFailure.exitCode, 23, 'A returned copy cannot alter trusted transport authority'); return true;
  });
});

test('a native process signal is separately recorded without fabricating an exit code', async t => {
  const rpc = transport(t, "process.kill(process.pid, 'SIGTERM')");
  await assert.rejects(rpc.request('initialize', {}, 5000), error => {
    assert.deepEqual(rpcFailure(error), { kind: 'process_exit', signal: 'SIGTERM' });
    assert.deepEqual(backendStartupFailure(markBackendStartupFailure(error, 'initialize')).transportFailure,
      { kind: 'process_exit', signal: 'SIGTERM' }); return true;
  });
});

test('a host RPC deadline has an explicit timeout receipt rather than an indistinguishable handshake failure', async t => {
  const rpc = transport(t, 'process.stdin.resume(); setInterval(() => {}, 1000)');
  await assert.rejects(rpc.request('initialize', {}, 20), error => {
    assert.equal(error.code, 'ETIMEDOUT'); assert.deepEqual(rpcFailure(error), { kind: 'timeout' });
    const failure = backendStartupFailure(markBackendStartupFailure(error, 'initialize'));
    assert.equal(failure.systemCode, 'ETIMEDOUT'); assert.deepEqual(failure.transportFailure, { kind: 'timeout' }); return true;
  });
});

test('provider error properties cannot forge host transport metadata or startup authority', () => {
  const forged = Object.assign(new Error('SYNTHETIC_PRIVATE_PROVIDER_TEXT'), {
    transportFailure: { kind: 'process_exit', exitCode: 23, signal: 'SIGTERM' }, exitCode: 23,
  });
  assert.equal(rpcFailure(forged), null); assert.equal(backendStartupFailure(forged), null);
  const receipt = backendStartupFailure(markBackendStartupFailure(forged, 'initialize'));
  assert.equal(receipt.transportFailure, undefined); assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC_PRIVATE/);
});
