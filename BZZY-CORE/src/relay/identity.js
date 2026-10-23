import fs from 'node:fs';
import path from 'node:path';
import { home, requireNode } from '../engine.js';
import { fail } from '../validation.js';
import { createIdentity, loadIdentity, saveIdentity } from './sdk.js';

export const DEFAULT_RELAY_URL = 'wss://190.114.255.214/v1/socket';
export const relayDirectory = () => path.join(home(), 'relay');

export function privateRelayDirectory() {
  for (const directory of [home(), relayDirectory()]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('PRIVATE_DIRECTORY_REQUIRED', 'Relay host storage must be a private directory.');
  }
  return relayDirectory();
}

export function initializeRelayIdentity() {
  requireNode();
  const file = path.join(privateRelayDirectory(), 'host.identity.json');
  if (!fs.existsSync(file)) {
    try { saveIdentity(file, createIdentity()); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return structuredClone(loadIdentity(file).certificate);
}

export function loadRelayIdentity() {
  requireNode();
  return loadIdentity(path.join(privateRelayDirectory(), 'host.identity.json'));
}
