export const transports = new Map();
export function registerTransport(name, transport) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name) || !transport?.send || !transport?.enabled) throw new Error('A notification transport needs a name, enabled(config), and send(event, context).');
  transports.set(name, transport);
}
export function destinationSnapshot(config) {
  const result = {};
  for (const [name, adapter] of transports) {
    try { if (adapter.enabled(config)) result[name] = { status: 'pending', attempts: 0 }; }
    catch { result[name] = { status: 'failed', attempts: 0, error: 'Notification destination configuration could not be read.' }; }
  }
  return result;
}
