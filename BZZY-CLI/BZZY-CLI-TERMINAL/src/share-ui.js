import { canControlSession } from './session-controls.js';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { home } from '@bzzy/core/engine/files.js';
import { listRecords } from '@bzzy/core/engine/database.js';
import { copyText } from './clipboard.js';

const fingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const terminalCode = value => typeof value === 'string' && /^BZZY-TERMINAL-[A-Za-z0-9_-]{43}$/.test(value);
const libraryCode = value => typeof value === 'string' && /^BZZY-LIBRARY-2(?:\.[A-Za-z0-9_-]{43}){4}$/.test(value);
const finished = state => ['complete', 'revoked', 'expired'].includes(state);

export function relayImportArgument(value) { return typeof value === 'string' && /^BZZY(?:-|:)/i.test(value.trim()); }

// Commands typed directly into the chat composer are private client actions.
// Hidden /import entry is preferred; remove legacy/queued composer copies too.
export function forgetPrivateImportInput(ui, value) {
  if (!/^\/(?:import|library\s+import)(?:\s|$)/.test(String(value).trim())) return;
  const tui = ui.tui;
  if (tui) {
    tui.history = (tui.history || []).filter(item => item !== value && item.trim() !== String(value).trim());
    tui.historyIndex = tui.history.length;
    for (const draft of tui.drafts?.values() || []) if (draft.value?.trim() === String(value).trim()) { draft.value = ''; draft.cursor = 0; }
  }
}

function privateTerminal(ui) {
  if (!ui.interactive || ui.json || ui.input?.isTTY === false || ui.output?.isTTY === false) {
    throw new Error('Terminal sharing and code import require a private interactive terminal; JSON and redirected output are unavailable.');
  }
  ui.openTerminal?.();
}
function safeFailure(error, library = false) {
  const messages = {
    INVITE_EXPIRED: 'The import code expired. Ask the sender for a new one.',
    INVITE_UNAVAILABLE: 'The import code is unavailable or already used. Ask the sender for a new one.',
    WRONG_PURPOSE: 'Use a BZZY-TERMINAL code for a terminal import.',
    HOST_MISMATCH: 'Sender identity does not match the fingerprint you confirmed.',
    UNTRUSTED_PEER: 'Sender identity could not be verified.',
    FORBIDDEN: 'This action is not authorized by the host.',
    HOST_OFFLINE: 'The sender host is offline. It must remain online for the transfer.',
    PEER_OFFLINE: 'The sender host is offline. It must remain online for the transfer.',
    HOST_ENROLLMENT_REQUIRED: 'The source host must be enrolled with Relay before sharing.',
    UNCERTAIN: 'Transfer status is uncertain. Check the sender before redeeming another code.',
    SHARE_TOO_LARGE: 'The selected project exceeds the sharing transfer limit.',
    SECRET_DETECTED: 'Export blocked because selected content may contain credentials. Review the project before sharing.',
    SHARE_SECRET_DETECTED: 'Export blocked because selected content may contain credentials. Review the project before sharing.',
    EXPORT_ACTIVE: 'Pause the project’s active executions before sharing a complete copy.',
    EXPORT_INVALID: 'The project could not pass the complete-context export checks.',
    IMPORT_CONFLICT: 'The destination has conflicting files. Choose an empty directory; nothing will be overwritten.',
    IMPORT_ACTIVE: 'Pause the imported chat before merging newer history.',
    IMPORT_CONTEXT_CHANGED: 'The terminal, project or Core host changed. Reopen /import before receiving a copy.',
    IMPORT_DESTINATION: 'Choose a real destination directory without symbolic links or conflicting files.',
    IMPORT_INVALID: 'The received project failed archive, integrity or private-state validation.',
    PROVIDER_UNAVAILABLE: 'Configure the project’s provider on this host before importing. Sender account settings are not transferred.',
    CONFIRMATION_REQUIRED: 'Compare and confirm the complete fingerprint on the other device before approving.',
    SHARE_CONTEXT_INCOMPLETE: 'The selected project has incomplete saved context. Check it on the source host before sharing.',
    LIBRARY_RELAY_UNSUPPORTED: 'This Relay does not support Library codes yet. Update BZZY Relay, then create a new code.',
    RELAY_UPGRADE_REQUIRED: 'This Relay does not support Library codes yet. Update BZZY Relay, then create a new code.',
    LIBRARY_IMPORT_INVALID: 'The received Library failed its package or integrity checks. Nothing was installed.',
    STALE_REVIEW: 'The Library changed. Review it again before sharing or installing.',
  };
  return new Error(error?.name === 'AbortError' ? 'Terminal import cancelled; no execution was started.'
    : messages[error?.code] || `${library ? 'Library' : 'Terminal'} sharing failed. Check Core/Relay, source approval, destination conflicts and the project security checks.`);
}
function changeView(ui, view, fields) {
  if (ui.privateView !== view) return;
  Object.assign(view, fields); ui.tui?.schedule();
}
async function privateView(ui, title, action) {
  privateTerminal(ui);
  const previous = ui.privateView, view = { title, lines: [], qr: [], onCancel: null };
  if (ui.tui) { ui.tui.textSelection = null; if (ui.tui.copyMode) ui.tui.setCopyMode(false); }
  ui.privateView = view; ui.tui?.schedule();
  try { return await action(view); }
  finally {
    view.lines = []; view.qr = []; view.code = ''; view.actions = []; view.actionMode = false; view.progress = null; view.onCancel = null;
    if (ui.privateView === view) ui.privateView = previous;
    if (ui.tui) { ui.tui.lastFrame = []; ui.tui.schedule(); }
  }
}
export async function enterShareCode(ui) {
  return privateView(ui, 'ENTER CODE', () => ui.secret('ENTER CODE · Enter continues · Esc back'));
}
function qrLines(value) {
  if (typeof value !== 'string' || value.length > 32_768) return [];
  const lines = value.split('\n').filter(line => line.replace(/\x1b\[(?:0|30|37|40|47)m/g, '').length);
  return lines.every(line => /^[ █▄▀]*$/.test(line.replace(/\x1b\[(?:0|30|37|40|47)m/g, ''))) ? lines : [];
}

export function shareTerminal(session, ui, options) { return sharePortable(session, ui, options); }

export function shareLibraryBundle(cwd, review, ui, options = {}) {
  return sharePortable({ cwd }, ui, { ...options, library: review });
}

async function sharePortable(session, ui, { relayLoader = () => import('@bzzy/core/relay'), copy = copyText, library, compact = false, assertContext = () => {} } = {}) {
  privateTerminal(ui);
  assertContext();
  const label = library ? compact && library.kinds?.length === 1
    ? { skill: 'skills', agent: 'agents', workflow: 'workflows', goal: 'goals', extension: 'extensions' }[library.kinds[0]] || 'Library' : 'Library' : 'terminal';
  if (!canControlSession(ui)) throw new Error('Attach with control before sharing this terminal.');
  if ((!library && !session?.id) || !path.isAbsolute(session.cwd || '')) throw new Error('Choose an existing terminal project before sharing.');
  let service, share, state, cancelled = false;
  try {
    return await privateView(ui, compact ? `Export ${label}` : `Share ${label}`, async view => {
      changeView(ui, view, { lines: compact ? [`${library.entries.length} ${label === 'Library' ? 'Library entries' : label} selected. Preparing your code…`] : [
        `Project: ${session.cwd}`,
        library ? 'Reviewed skills, specialist agents, workflows and saved goal text.' : 'Includes project files, full chats, .bzzy notes, memory and related execution/evidence context.',
        'Credentials, account bindings, device identities and live permissions are excluded.',
        library ? 'The recipient installs missing entries only and uses their own accounts and models.' : 'The recipient gets an independent paused copy and uses their own accounts.',
      ] });
      if (!library && !/^share$/i.test((await ui.ask('Type SHARE to prepare this complete terminal copy · Esc cancels › '))?.trim() || '')) return null;
      const module = await relayLoader();
      assertContext();
      service = new module.CoreTerminalSharing();
      await service.start();
      assertContext();
      share = library ? await service.createLibraryShare({ cwd: session.cwd, expectedDigest: library.sourceDigest,
        ...(library.kinds ? { kinds: library.kinds } : {}),
        ...(library.excludeEntries?.length ? { excludeEntries: library.excludeEntries } : {}),
        ...(library.excludeGoalIds?.length ? { excludeGoalIds: library.excludeGoalIds } : {}), approval: 'code', ttlSeconds: 600 })
        : await service.createShare({ sessionId: session.id, ttlSeconds: 600 });
      assertContext();
      if (!(library ? libraryCode : terminalCode)(share?.code) || !fingerprint(share?.senderFingerprint) || !Number.isSafeInteger(share?.expiresAt) || share.expiresAt <= Date.now()) {
        throw new Error('Invalid private invitation');
      }
      let qr = qrLines(share.terminalQR || (typeof share.renderQR === 'function' ? await share.renderQR() : ''));
      let showQR = false, showVerification = false, polling = false, closed = false;
      view.onCancel = () => { closed = true; ui.reader?.close(); };
      const refresh = async () => {
        assertContext();
        if (polling) return;
        polling = true;
        try {
          state = await service.status(share.shareId);
          // A consumed code and its approved transfer have separate deadlines.
          // Large copies can outlive the invitation's ten-minute lifetime.
          if (state.state !== 'approved' && !finished(state.state) && Date.now() >= share.expiresAt) {
            state = { state: 'expired', pending: [] };
            changeView(ui, view, { code: '', actions: [], lines: [`This ${label} share expired. Generate a new code to share again.`], qr: [] });
            ui.reader?.close(); return;
          }
          const available = !finished(state.state) && state.state !== 'approved';
          const automatic = library && share.approval === 'code';
          const privateLines = automatic ? [] : showVerification ? [`Sender fingerprint: ${share.senderFingerprint}`,
            `Expires: ${new Date(share.expiresAt).toLocaleTimeString()}`] : [];
          if (!automatic && state.pending?.length) privateLines.push('A recipient is waiting. Choose Approve recipient.');
          if (!automatic && showVerification) for (const request of state.pending || []) if (fingerprint(request.fingerprint)) privateLines.push(`Recipient fingerprint: ${request.fingerprint}`);
          const actions = available ? [{ value: 'c', label: 'Copy code' }, ...(automatic ? [{ value: '/cancel', label: 'Revoke code' }]
            : [{ value: 'v', label: 'Verification' }, { value: 'q', label: 'QR' }, ...(state.pending?.length ? [{ value: 'a', label: 'Approve recipient' }] : [])])]
            : state.state === 'approved' ? [{ value: '/cancel', label: 'Cancel transfer' }] : [];
          changeView(ui, view, { title: 'EXPORT CODE', code: available ? share.code : '', actions,
            progress: state.state === 'approved' ? { label: 'Sending encrypted transfer…' } : null,
            lines: privateLines, qr: showQR && available ? qr : [] });
          if (finished(state.state)) ui.reader?.close();
        } finally { polling = false; }
      };
      await refresh();
      while (!closed && !finished(state?.state)) {
        const timer = setInterval(() => { void refresh().catch(() => changeView(ui, view, { notice: 'Status unavailable; the code retains its expiration.' })); }, 1500);
        timer.unref?.();
        let action;
        try { view.actionMode = true; ui.tui?.schedule(); action = (await ui.ask(library ? 'Copy code · Paste on the other BZZY · Esc back' : 'Click an action · C copies · V verification · Q QR · Esc back'))?.trim().toLowerCase(); }
        finally { view.actionMode = false; clearInterval(timer); }
        if (finished(state?.state)) break;
        if (action == null) break;
        if (action === '/cancel') { cancelled = true; break; }
        assertContext();
        if (action === 'c' && state.state !== 'approved' && Date.now() < share.expiresAt) {
          let result;
          try { result = await copy(share.code, ui.output); } catch { result = { copied: false }; }
          const notice = result?.copied ? result.method === 'osc52' ? 'Copy request sent. Allow clipboard access in your terminal.' : 'Code copied.'
            : 'Could not copy. Enable clipboard access or use your terminal’s Copy command on the displayed code.';
          changeView(ui, view, { notice, noticeTone: result?.copied ? 'success' : 'warning' });
        }
        else if (action === 'v') showVerification = !showVerification;
        else if (action === 'q') showQR = !showQR;
        else if (action === 'a') {
          showVerification = true;
          await refresh();
          const confirmed = (await ui.ask('Enter the full recipient fingerprint from their device · Esc cancels › '))?.trim();
          if (confirmed) {
            const request = state.pending?.find(item => item.fingerprint === confirmed);
            if (!fingerprint(confirmed) || !request) changeView(ui, view, { notice: 'Fingerprint does not match a pending recipient. Nothing was approved.' });
            else await service.approveShare({ shareId: share.shareId, claimId: request.claimId, confirmedFingerprint: confirmed });
          }
        }
        await refresh();
      }
      qr = [];
      return { state: cancelled ? 'cancelled' : state?.state || 'cancelled' };
    });
  } catch (error) { throw safeFailure(error, Boolean(library)); }
  finally {
    if (service && share && state?.state !== 'complete' && (cancelled || share.approval !== 'code' && state?.state !== 'approved')) await service.revokeShare(share.shareId).catch(() => {});
    await Promise.resolve(service?.close()).catch(() => {});
  }
}

function destinationFailure() { throw Object.assign(new Error('The import destination is unavailable.'), { code: 'IMPORT_DESTINATION' }); }
const directoryPin = directory => {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) destinationFailure();
  return { directory, dev: stat.dev, ino: stat.ino };
};
function sameDirectory(pin) {
  try { const current = directoryPin(pin.directory); return current.dev === pin.dev && current.ino === pin.ino; }
  catch { return false; }
}
function destinationChain(destination) {
  const root = path.parse(destination).root, pins = [], missing = [];
  let current = root, absent = false;
  pins.push(directoryPin(root));
  for (const part of path.relative(root, destination).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!absent) {
      try { pins.push(directoryPin(current)); continue; }
      catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; }
    }
    missing.push(current);
  }
  return { pins, missing };
}
function createDestination(destination, created) {
  const plan = destinationChain(destination);
  for (const directory of plan.missing) {
    if (!plan.pins.every(sameDirectory)) destinationFailure();
    fs.mkdirSync(directory, { mode: 0o700 });
    const pin = directoryPin(directory); created.push({ ...pin, parents: [...plan.pins] });
    if (!plan.pins.every(sameDirectory)) destinationFailure();
    plan.pins.push(pin);
  }
  if (!plan.pins.every(sameDirectory)) destinationFailure();
  return fs.realpathSync(destination);
}
function importContext(cwd, ui) {
  const original = path.resolve(cwd), source = fs.realpathSync(original), pin = directoryPin(source), coreHome = home();
  const visible = [ui.sessionId, ui.activeTab, ui.nextSession?.id];
  const check = () => {
    if (home() !== coreHome || ui.closed || ui.coreLifecycleInterrupted || !sameDirectory(pin) || fs.realpathSync(original) !== source ||
      [ui.sessionId, ui.activeTab, ui.nextSession?.id].some((value, index) => value !== visible[index])) {
      throw Object.assign(new Error('The import context changed.'), { code: 'IMPORT_CONTEXT_CHANGED' });
    }
  };
  const location = `${pin.dev}:${pin.ino}`;
  // This journal is a local UI hint only; Core rechecks ownership and import
  // identity before accepting an incremental update or writing project files.
  const previous = ['project-import-source', 'project-import-pending'].some(kind => listRecords(kind).some(row => row.root === source && row.location === location));
  const initialized = fs.existsSync(path.join(source, '.bzzy', 'project.json'));
  return { check, source, suggested: initialized && !previous ? path.join(source, `imported-session-${Date.now()}-${randomUUID().slice(0, 8)}`) : source };
}

export async function importTerminal(value, cwd, ui, { relayLoader = () => import('@bzzy/core/relay'), chooseDestination = false } = {}) {
  privateTerminal(ui);
  let code = String(value || '').trim(), destination = path.resolve(cwd), context, completed = false;
  const created = [];
  try {
    if (chooseDestination) context = importContext(cwd, ui);
    const check = () => context?.check();
    const result = await privateView(ui, 'ENTER CODE', async view => {
      if (!code) code = (await ui.secret('ENTER CODE · Enter continues · Esc back'))?.trim() || '';
      check();
      if (!code) return null;
      if (!terminalCode(code) && !code.startsWith('BZZY:INVITE:1:')) throw Object.assign(new Error(), { code: 'WRONG_PURPOSE' });
      changeView(ui, view, { title: 'Import terminal', lines: [
        `Destination: ${path.resolve(cwd)}`,
        'Import the complete project and conversation into this directory. Existing files will not be overwritten.',
        'The copy stays paused. Scripts, hooks, goals and agents are not started by import.',
      ] });
      if (context) {
        const selected = await ui.ask('Destination folder · new folder for first import; previous import folder for updates · Esc cancels › ', { initialValue: context.suggested });
        check(); if (selected == null) return null;
        const entered = selected.trim() || context.suggested;
        if (entered.length > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(entered)) destinationFailure();
        destination = path.resolve(context.source, entered);
        destinationChain(destination);
        changeView(ui, view, { lines: [`Destination: ${destination}`, 'New imports use this folder. Updates preserve existing local work and add missing history.', 'Nothing runs automatically; existing files are never overwritten.'] });
      }
      const sender = (await ui.ask('Enter the full sender fingerprint from their BZZY share screen › '))?.trim();
      check();
      if (!sender) return null;
      if (!fingerprint(sender)) throw Object.assign(new Error(), { code: 'HOST_MISMATCH' });
      const confirmed = await ui.ask('Type IMPORT to receive this private project into the destination above › ');
      check(); if (!/^import$/i.test(confirmed?.trim() || '')) return null;
      const abort = new AbortController();
      view.onCancel = () => abort.abort();
      changeView(ui, view, { progress: { label: 'Connecting to Relay…' } });
      const module = await relayLoader();
      check(); abort.signal.throwIfAborted();
      if (typeof module.importTerminalShare !== 'function') throw new Error('Terminal importer unavailable.');
      if (context) destination = createDestination(destination, created);
      const monitor = context ? setInterval(() => { try { check(); } catch { abort.abort(); } }, 50) : null;
      monitor?.unref();
      try { return await module.importTerminalShare({ code, cwd: destination, expectedSenderFingerprint: sender, signal: abort.signal,
        onIdentity: ({ recipientFingerprint }) => {
          check();
          if (!fingerprint(recipientFingerprint)) { abort.abort(); return; }
          changeView(ui, view, { lines: [`Destination: ${destination}`, `Verified sender: ${sender}`,
            `Your recipient fingerprint: ${recipientFingerprint}`, 'Give this full fingerprint to the sender for approval.'], progress: { label: 'Waiting for sender approval…' } });
        },
        onPhase: phase => {
          const labels = { connecting: 'Connecting to Relay…', downloading: 'Downloading encrypted project…', checking: 'Checking package integrity…', installing: 'Installing project…' };
          if (labels[phase] && !abort.signal.aborted) changeView(ui, view, { progress: { label: labels[phase] } });
        },
        onProgress: ({ received, total }) => {
          check();
          if (Number.isSafeInteger(received) && Number.isSafeInteger(total) && received >= 0 && total >= received) {
            changeView(ui, view, { progress: { label: 'Downloading encrypted project…', received, total } });
          }
        },
      }); } finally { clearInterval(monitor); }
    });
    if (result) {
      completed = true;
      const id = result.primarySession?.id;
      const message = result.alreadyImported ? `Already imported into ${destination}. No duplicate history was created.`
        : result.added && result.preserved > 0 ? `Terminal updated in ${destination}. Added ${result.added.sessions || 0} chats, ${result.added.events || 0} history events and ${result.added.records || 0} records. Existing local work was retained.`
          : `Terminal imported into ${destination}. Execution remains paused.`;
      ui.event('info', { message: `${message}${id ? `\nAttach when ready: bzzy --attach ${id}` : ''}` });
    }
    return result;
  } catch (error) { throw safeFailure(error); }
  finally {
    code = '';
    if (!completed) for (const pin of created.reverse()) {
      try { if (sameDirectory(pin) && pin.parents.every(sameDirectory) && fs.readdirSync(pin.directory).length === 0) fs.rmdirSync(pin.directory); }
      catch { /* Keep changed directories or any data written during import. */ }
    }
  }
}
