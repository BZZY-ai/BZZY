import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { home, writeJson } from './files.js';
import { lockFile } from './store.js';
import { toolEnvironment } from './execution-environment.js';

const accountKey = '__gmail__'; // Provider IDs cannot begin with an underscore.
const helperPath = fileURLToPath(new URL('./gmail-imap.py', import.meta.url));
const timeoutMs = 30_000, maxBuffer = 512 * 1024;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const messages = Object.freeze({
  GMAIL_SETTINGS_INVALID: 'The private Gmail settings are unavailable or invalid. Check the mailbox address and app password in Core settings.',
  GMAIL_SETTINGS_STALE: 'The Gmail account changed. Reopen its settings before replacing it.',
  GMAIL_NOT_CONFIGURED: 'Authorize a Gmail mailbox and app password in Core settings before reading email.',
  GMAIL_ACCOUNT_CHANGED: 'The Gmail authorization changed during this request. Its result was withheld.',
  GMAIL_INVALID_REQUEST: 'The Gmail request is invalid.',
  GMAIL_AUTH_FAILED: 'Gmail rejected the account or app password.',
  GMAIL_FOLDER_UNAVAILABLE: 'The requested Gmail folder is unavailable.',
  GMAIL_UIDVALIDITY_CHANGED: 'The folder changed. List its messages again before reading one.',
  GMAIL_MESSAGE_NOT_FOUND: 'The requested message is unavailable in this folder.',
  GMAIL_MESSAGE_TOO_LARGE: 'This message exceeds the read-only Gmail size limit.',
  GMAIL_RECIPIENT_NOT_ALLOWED: 'This message is outside the approved recipient aliases.',
  GMAIL_CONNECTION_FAILED: 'The read-only Gmail connection failed.',
  GMAIL_TIMEOUT: 'The read-only Gmail request timed out.',
  GMAIL_PROTOCOL_ERROR: 'Gmail returned an unsupported response.',
  GMAIL_RESPONSE_TOO_LARGE: 'The Gmail response exceeds the read-only size limit.',
  GMAIL_HELPER_UNAVAILABLE: 'The private Gmail helper could not start. Check that Python 3 is installed.',
  GMAIL_CANCELLED: 'The Gmail request was cancelled.',
});
function failure(code) { return Object.assign(new Error(messages[code]), { code, ...(code === 'GMAIL_CANCELLED' ? { name: 'AbortError' } : {}) }); }
function fail(code = 'GMAIL_SETTINGS_INVALID') { throw failure(code); }
const email = value => typeof value === 'string' && value.length <= 254 && value.indexOf('@') <= 64
  && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
  && !value.startsWith('.') && !value.includes('..') && !value.includes('.@') && value.split('@')[1].split('.').every(label => label.length <= 63);
function password(value) {
  if (typeof value !== 'string' || value.length > 128 || /[^\x20-\x7e]/.test(value)) fail();
  const result = value.replaceAll(' ', '');
  if (!result) fail();
  return result;
}
const vaultFile = () => path.join(home(), 'credentials.json');
function readVault() {
  let descriptor;
  try {
    descriptor = fs.openSync(vaultFile(), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o777) !== 0o600
      || process.getuid && stat.uid !== process.getuid()) fail();
    const value = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (!plain(value)) fail();
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    fail(); // Never include parse fragments, credentials, or private file paths.
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function account(vault) {
  if (!Object.hasOwn(vault, accountKey)) return null;
  const value = vault[accountKey];
  if (!exact(value, ['version', 'address', 'appPassword', 'revision', 'enabled']) || value.version !== 1
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.enabled !== 'boolean') fail();
  if (!value.enabled && value.address === '' && value.appPassword === undefined) return value;
  if (!email(value.address) || password(value.appPassword) !== value.appPassword) fail();
  return value;
}
const metadata = value => ({ configured: Boolean(value?.enabled), address: value?.enabled ? value.address : '', revision: value?.revision || 0 });
function checkRevision(value, expectedRevision) {
  if (expectedRevision === undefined) return;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== (value?.revision || 0)) fail('GMAIL_SETTINGS_STALE');
}
function privateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) { if (error.code !== 'EEXIST') fail(); }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || process.getuid && stat.uid !== process.getuid()) fail();
  return directory;
}
function editAccount(create, options) {
  if (!exact(options, ['expectedRevision'])) fail();
  let release;
  try {
    // A Core private home is an existing owner directory or a new private one.
    // No state or lock is written beside a project or a helper script.
    fs.mkdirSync(path.dirname(home()), { recursive: true });
    privateDirectory(home());
    release = lockFile(path.join(home(), 'credentials.json.lock'));
    const vault = readVault(), previous = account(vault);
    checkRevision(previous, options.expectedRevision);
    const revision = (previous?.revision || 0) + 1;
    if (!Number.isSafeInteger(revision)) fail();
    const next = { version: 1, ...create(), revision };
    writeJson(vaultFile(), { ...vault, [accountKey]: next });
    return metadata(next);
  } catch (error) {
    if (error.code === 'GMAIL_SETTINGS_STALE') throw failure(error.code);
    fail();
  } finally {
    if (release) {
      try { release(); } catch { fail(); }
    }
  }
}

// Trusted local-owner settings only. Saving authorizes bounded read-only mail
// access; it performs no network request and returns no credential material.
export function getGmailSettings() { return metadata(account(readVault())); }
export function setGmailSettings(input, options = {}) {
  if (!exact(input, ['address', 'appPassword']) || typeof input.address !== 'string') fail();
  const address = input.address.trim(), appPassword = password(input.appPassword);
  if (!email(address)) fail();
  return editAccount(() => ({ address, appPassword, enabled: true }), options);
}
export function clearGmailSettings(options = {}) {
  return editAccount(() => ({ address: '', enabled: false }), options);
}

const textLength = value => [...value].length;
const boundedText = (value, maximum, empty = false) => typeof value === 'string' && textLength(value) <= maximum
  && (empty || value.length > 0) && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
const uid = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 4294967295;
function request(input, check = false) {
  if (!plain(input)) fail('GMAIL_INVALID_REQUEST');
  const operation = check ? 'check' : input.operation;
  if (!['list', 'read', ...(check ? ['check'] : [])].includes(operation)) fail('GMAIL_INVALID_REQUEST');
  const keys = ['operation', 'folder', ...(operation === 'list' ? ['last', 'search'] : operation === 'read' ? ['uid', 'uidValidity', 'maxChars'] : [])];
  if (!exact(input, keys)) fail('GMAIL_INVALID_REQUEST');
  const folder = input.folder ?? 'INBOX';
  if (!boundedText(folder, 240)) fail('GMAIL_INVALID_REQUEST');
  const result = { operation, folder };
  if (operation === 'list') {
    const last = input.last ?? 10, search = input.search ?? '';
    if (!Number.isInteger(last) || last < 1 || last > 25 || !boundedText(search, 1000, true)) fail('GMAIL_INVALID_REQUEST');
    Object.assign(result, { last, search });
  } else if (operation === 'read') {
    const maxChars = input.maxChars ?? 12000;
    if (!uid(input.uid) || !uid(input.uidValidity) || !Number.isInteger(maxChars) || maxChars < 1 || maxChars > 16000) fail('GMAIL_INVALID_REQUEST');
    Object.assign(result, { uid: input.uid, uidValidity: input.uidValidity, maxChars });
  }
  return result;
}
function internalOptions(options) {
  if (!exact(options, ['signal', 'run', 'recipientAliases']) || options.signal !== undefined && !(options.signal instanceof AbortSignal)
    || options.run !== undefined && typeof options.run !== 'function') fail('GMAIL_INVALID_REQUEST');
  if (options.recipientAliases !== undefined && (!Array.isArray(options.recipientAliases) || options.recipientAliases.length > 32
    || [...options.recipientAliases].some(value => !email(value)) || new Set(options.recipientAliases.map(value => value.toLowerCase())).size !== options.recipientAliases.length)) fail('GMAIL_INVALID_REQUEST');
  return options;
}
function environment() {
  // Even owner-declared extra environment names are unnecessary for this fixed
  // stdlib transport. In particular Python hooks, provider keys and account
  // passwords are never inherited by the helper.
  const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot', 'WINDIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR']);
  const result = Object.fromEntries(Object.entries(toolEnvironment()).filter(([key]) => allowed.has(key)));
  return result;
}
function runHelper(executable, args, options) {
  return new Promise((resolve, reject) => {
    let child, bytes = 0, settled = false;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error && child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* Never expose process errors or leave a helper after stdin failure. */ }
      }
      if (error) reject(error); else resolve(value);
    };
    try {
      child = spawn(executable, args, { cwd: options.cwd, env: options.env, signal: options.signal,
        killSignal: 'SIGKILL', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.on('error', () => finish(failure('GMAIL_HELPER_UNAVAILABLE')));
      child.stdin.on('error', () => finish(failure('GMAIL_CONNECTION_FAILED')));
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > options.maxBuffer) {
          finish(failure('GMAIL_RESPONSE_TOO_LARGE'));
        } else chunks.push(chunk);
      });
      child.on('close', code => code === 0 ? finish(null, { stdout: Buffer.concat(chunks).toString('utf8') }) : finish(failure('GMAIL_CONNECTION_FAILED')));
      child.stdin.end(options.input);
    } catch { finish(failure('GMAIL_HELPER_UNAVAILABLE')); }
  });
}
function resultFrom(stdout, input, secret) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > maxBuffer) fail('GMAIL_RESPONSE_TOO_LARGE');
  let response;
  try { response = JSON.parse(stdout); } catch { fail('GMAIL_PROTOCOL_ERROR'); }
  if (!plain(response) || typeof response.ok !== 'boolean') fail('GMAIL_PROTOCOL_ERROR');
  if (!response.ok) {
    if (!exact(response, ['ok', 'error']) || !exact(response.error, ['code', 'message'])
      || typeof response.error.code !== 'string' || !Object.hasOwn(messages, `GMAIL_${response.error.code}`)
      || ['HELPER_UNAVAILABLE', 'CANCELLED', 'ACCOUNT_CHANGED', 'NOT_CONFIGURED', 'SETTINGS_INVALID', 'SETTINGS_STALE'].includes(response.error.code)) fail('GMAIL_PROTOCOL_ERROR');
    fail(`GMAIL_${response.error.code}`); // Only our fixed messages cross the boundary.
  }
  if (!exact(response, ['ok', 'result'])) fail('GMAIL_PROTOCOL_ERROR');
  const result = response.result, headerKeys = ['uid', 'from', 'to', 'subject', 'date', 'messageId'];
  const header = value => exact(value, headerKeys) && uid(value.uid)
    && ['from', 'to', 'subject'].every(key => typeof value[key] === 'string' && textLength(value[key]) <= 2048)
    && typeof value.date === 'string' && textLength(value.date) <= 128 && typeof value.messageId === 'string' && textLength(value.messageId) <= 512;
  const base = ['folder', 'uidValidity', 'readOnly'];
  const keys = input.operation === 'list' ? [...base, 'messages'] : input.operation === 'read'
    ? [...base, ...headerKeys, 'body', 'bodyTruncated', 'links', 'attachments'] : base;
  if (!exact(result, keys) || result.folder !== input.folder || !uid(result.uidValidity) || result.readOnly !== true) fail('GMAIL_PROTOCOL_ERROR');
  if (input.operation === 'list') {
    if (!Array.isArray(result.messages) || result.messages.length > input.last || result.messages.some(value => !header(value))
      || new Set(result.messages.map(value => value.uid)).size !== result.messages.length) fail('GMAIL_PROTOCOL_ERROR');
  } else if (input.operation === 'read') {
    const headers = Object.fromEntries(headerKeys.map(key => [key, result[key]]));
    if (!header(headers) || result.uid !== input.uid || result.uidValidity !== input.uidValidity
      || typeof result.body !== 'string' || textLength(result.body) > input.maxChars || typeof result.bodyTruncated !== 'boolean'
      || !Array.isArray(result.links) || result.links.length > 16 || result.links.some(value => !exact(value, ['text', 'url'])
        || typeof value.text !== 'string' || textLength(value.text) > 256 || !boundedText(value.url, 2048) || !/^https?:\/\//i.test(value.url))
      || !Array.isArray(result.attachments) || result.attachments.length > 32 || result.attachments.some(value => !exact(value, ['filename', 'contentType'])
        || typeof value.filename !== 'string' || textLength(value.filename) > 256 || typeof value.contentType !== 'string' || textLength(value.contentType) > 128)) fail('GMAIL_PROTOCOL_ERROR');
  }
  const replacement = secret.length >= 12 ? '[REDACTED]' : '•'.repeat(Math.min(secret.length, 4));
  const scrub = value => typeof value === 'string' ? value.replaceAll(secret, replacement) : Array.isArray(value)
    ? value.map(scrub) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
  return scrub(result);
}
function stillAuthorized(saved) {
  const current = account(readVault());
  if (!current?.enabled || current.revision !== saved.revision || current.address !== saved.address || current.appPassword !== saved.appPassword) fail('GMAIL_ACCOUNT_CHANGED');
}
async function execute(input, options) {
  internalOptions(options);
  if (options.signal?.aborted) fail('GMAIL_CANCELLED');
  const saved = account(readVault());
  if (!saved?.enabled) fail('GMAIL_NOT_CONFIGURED');
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const abortError = () => failure(options.signal?.aborted ? 'GMAIL_CANCELLED' : 'GMAIL_TIMEOUT');
  let listener;
  try {
    const runtime = privateDirectory(path.join(home(), 'runtime'));
    const cwd = privateDirectory(path.join(runtime, 'gmail'));
    const env = environment();
    const payload = { ...input, address: saved.address, appPassword: saved.appPassword,
      ...(options.recipientAliases === undefined ? {} : { recipientAliases: [...options.recipientAliases] }) };
    const aborted = new Promise((_, reject) => { listener = () => reject(abortError()); signal.addEventListener('abort', listener, { once: true }); });
    const output = await Promise.race([Promise.resolve().then(() => {
      if (signal.aborted) throw abortError();
      stillAuthorized(saved);
      return (options.run || runHelper)('python3', ['-I', '-B', helperPath], { input: JSON.stringify(payload), env, cwd, signal, timeout: timeoutMs, maxBuffer });
    }), aborted]);
    if (signal.aborted) throw abortError();
    stillAuthorized(saved);
    return resultFrom(output?.stdout, input, saved.appPassword);
  } catch (error) {
    if (signal.aborted) throw abortError();
    if (Object.hasOwn(messages, error?.code)) throw failure(error.code);
    fail('GMAIL_CONNECTION_FAILED');
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}

// The caller must enforce the live session/account policy before invoking this
// transport. Models supply read arguments only; private scope is a host option.
export async function readGmail(input, options = {}) { return execute(request(input), options); }
export async function checkGmailConnection(options = {}) { return execute(request({}, true), options); }
