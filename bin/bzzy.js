#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`bzzy: ${error.message}\n`);
  if (process.env.BZZY_DEBUG) process.stderr.write(`${error.stack}\n`);
  process.exitCode = error.exitCode ?? 1;
}
