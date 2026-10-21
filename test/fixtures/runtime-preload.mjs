import fs from 'node:fs';
if (process.argv.includes('internal-execution')) {
  const mode = fs.readFileSync(process.env.BZZY_TEST_BOOT_FILE, 'utf8');
  if (mode === 'exit') { process.stderr.write('Fixture runner startup failed. Bearer hidden-fixture-token\n'); process.exit(23); }
  if (mode === 'block') {
    process.on('SIGTERM', () => {});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    process.exit(24);
  }
}
