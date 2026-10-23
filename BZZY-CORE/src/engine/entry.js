// Private process entry points for the shared engine. No terminal client is
// imported by a daemon, execution runner, assignment worker, or MCP bridge.
export const BACKEND_COMMANDS = Object.freeze([
  'internal-service', 'internal-execution', 'internal-assignment',
  'internal-tools', 'internal-mcp',
]);

export async function backendCommand(argv) {
  const [command, ...args] = argv;
  if (command === 'internal-service') {
    if (args.length) throw new Error('The Core service accepts no arguments.');
    await (await import('./migrations.js')).retireTelegram();
    return (await import('./runtime.js')).serveRuntime();
  }
  if (command === 'internal-execution') {
    if (args.length !== 1) throw new Error('An execution ID is required.');
    return (await import('./runtime.js')).executeJob(args[0]);
  }
  if (command === 'internal-assignment') {
    if (args.length !== 2 || !/^[1-9]\d*$/.test(args[1])) throw new Error('An assignment ID and round are required.');
    return (await import('./delegation.js')).runAssignment(args[0], Number(args[1]));
  }
  if (command === 'internal-tools') {
    if (args.length !== 2) throw new Error('The private tool bridge requires its socket and token.');
    await (await import('./tools.js')).serveTaskBridge(args[0], args[1]);
    return 0;
  }
  if (command === 'internal-mcp') {
    if (args.length !== 2) throw new Error('The goal bridge requires its session and nonce.');
    await (await import('./mcp.js')).serveGoalTools(args[0], args[1]);
    return 0;
  }
  throw new Error('Unknown internal Core command.');
}
