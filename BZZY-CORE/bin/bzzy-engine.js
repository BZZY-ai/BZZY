#!/usr/bin/env node
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('BZZY Core requires Node.js 24 or newer.');
  const { backendCommand } = await import('../src/engine/entry.js');
  process.exitCode = await backendCommand(process.argv.slice(2));
} catch (error) {
  // Detailed runner failures belong to the private execution log. Never dump
  // process environments, request bodies, credentials or authentication headers.
  const { diagnosticError } = await import('../src/engine/diagnostic-error.js');
  process.stderr.write(`bzzy-core: ${diagnosticError(error)}\n`);
  process.exitCode = error.exitCode ?? 1;
}
