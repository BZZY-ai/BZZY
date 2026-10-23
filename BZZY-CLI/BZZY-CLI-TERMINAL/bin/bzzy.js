#!/usr/bin/env node
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error(`Node.js 24 or newer is required (found ${process.versions.node}). Run ./install.sh to install the supported runtime.`);
  const { main } = await import('../src/cli.js');
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`bzzy: ${error.message}\n`);
  if (process.env.BZZY_DEBUG) process.stderr.write(`${error.stack}\n`);
  process.exitCode = error.exitCode ?? 1;
}
