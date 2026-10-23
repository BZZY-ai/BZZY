import path from 'node:path';
import { copyText } from './clipboard.js';

const fingerprint = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const terminalCode = value => typeof value === 'string' && /^BZZY-TERMINAL-[A-Za-z0-9_-]{43}$/.test(value);
const finished = state => ['complete', 'revoked', 'expired'].includes(state);

export function relayImportArgument(value) { return typeof value === 'string' && /^BZZY(?:-|:)/i.test(value.trim()); }

// Commands typed directly into the chat composer are private client actions.
// Hidden /import entry is preferred; remove legacy/queued composer copies too.
export function forgetPrivateImportInput(ui, value) {
  if (!/^\/import(?:\s|$)/.test(String(value).trim())) return;
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
function safeFailure(error) {
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
    IMPORT_INVALID: 'The received project failed archive, integrity or private-state validation.',
    PROVIDER_UNAVAILABLE: 'Configure the project’s provider on this host before importing. Sender account settings are not transferred.',
    CONFIRMATION_REQUIRED: 'Compare and confirm the complete fingerprint on the other device before approving.',
    SHARE_CONTEXT_INCOMPLETE: 'The selected project has incomplete saved context. Check it on the source host before sharing.',
  };
  return new Error(error?.name === 'AbortError' ? 'Terminal import cancelled; no execution was started.'
    : messages[error?.code] || 'Terminal sharing failed. Check Core/Relay, source approval, destination conflicts and the project security checks.');
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
    view.lines = []; view.qr = []; view.onCancel = null;
    if (ui.privateView === view) ui.privateView = previous;
    if (ui.tui) { ui.tui.lastFrame = []; ui.tui.schedule(); }
  }
}
function qrLines(value) {
  if (typeof value !== 'string' || value.length > 32_768) return [];
  const lines = value.split('\n').filter(line => line.replace(/\x1b\[(?:0|30|37|40|47)m/g, '').length);
  return lines.every(line => /^[ █▄▀]*$/.test(line.replace(/\x1b\[(?:0|30|37|40|47)m/g, ''))) ? lines : [];
}

export async function shareTerminal(session, ui, { relayLoader = () => import('@bzzy/core/relay'), copy = copyText } = {}) {
  privateTerminal(ui);
  if (ui.sessionMode === 'VIEW') throw new Error('Attach with control before sharing this terminal.');
  if (!session?.id || !path.isAbsolute(session.cwd || '')) throw new Error('Choose an existing terminal session before sharing.');
  let service, share, state;
  try {
    return await privateView(ui, 'Share terminal', async view => {
      changeView(ui, view, { lines: [
        `Project: ${session.cwd}`,
        'Includes project files, full chats, .bzzy notes, memory and related execution/evidence context.',
        'Credentials, account bindings, device identities and live permissions are excluded.',
        'The recipient gets an independent paused copy and uses their own accounts.',
      ] });
      if (!/^share$/i.test((await ui.ask('Type SHARE to prepare this complete terminal copy · Esc cancels › '))?.trim() || '')) return null;
      const module = await relayLoader();
      service = new module.CoreTerminalSharing();
      await service.start();
      share = await service.createShare({ sessionId: session.id, ttlSeconds: 600 });
      if (!terminalCode(share?.code) || !fingerprint(share?.senderFingerprint) || !Number.isSafeInteger(share?.expiresAt) || share.expiresAt <= Date.now()) {
        throw new Error('Invalid private invitation');
      }
      let qr = qrLines(share.terminalQR || (typeof share.renderQR === 'function' ? await share.renderQR() : ''));
      let showQR = true, polling = false;
      const refresh = async () => {
        if (polling) return;
        if (Date.now() >= share.expiresAt) {
          state = { state: 'expired', pending: [] };
          changeView(ui, view, { lines: ['This terminal share expired. Generate a new code to share again.'], qr: [] });
          ui.reader?.close();
          return;
        }
        polling = true;
        try {
          state = await service.status(share.shareId);
          const privateLines = [
            `Project: ${session.cwd}`,
            `Sender fingerprint: ${share.senderFingerprint}`,
            `Expires: ${new Date(share.expiresAt).toLocaleTimeString()} · ${state.state}`,
          ];
          if (!finished(state.state)) privateLines.push(share.code);
          if (state.pending?.length) privateLines.push('A recipient is waiting. Compare the full fingerprint on their device before approving.');
          for (const request of state.pending || []) if (fingerprint(request.fingerprint)) privateLines.push(`Requesting recipient: ${request.fingerprint}`);
          changeView(ui, view, { lines: privateLines, qr: showQR && !finished(state.state) ? qr : [] });
          if (finished(state.state)) ui.reader?.close();
        } finally { polling = false; }
      };
      await refresh();
      while (!finished(state?.state)) {
        const timer = setInterval(() => { void refresh().catch(() => changeView(ui, view, { notice: 'Status unavailable; the code retains its expiration.' })); }, 1500);
        timer.unref?.();
        let action;
        try { action = (await ui.ask('Enter refresh · c copy code · q QR · a approve recipient · /cancel › '))?.trim().toLowerCase(); }
        finally { clearInterval(timer); }
        if (finished(state?.state)) break;
        if (action == null || action === '/cancel') break;
        if (action === 'c') { await copy(share.code); changeView(ui, view, { notice: 'Code copied. It expires automatically.' }); }
        else if (action === 'q') showQR = !showQR;
        else if (action === 'a') {
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
      return { state: state?.state || 'cancelled' };
    });
  } catch (error) { throw safeFailure(error); }
  finally {
    if (service && share && !['approved', 'complete'].includes(state?.state)) await service.revokeShare(share.shareId).catch(() => {});
    await Promise.resolve(service?.close()).catch(() => {});
  }
}

export async function importTerminal(value, cwd, ui, { relayLoader = () => import('@bzzy/core/relay') } = {}) {
  privateTerminal(ui);
  let code = String(value || '').trim();
  try {
    const result = await privateView(ui, 'Import terminal', async view => {
      changeView(ui, view, { lines: [
        `Destination: ${path.resolve(cwd)}`,
        'Import the complete project and conversation into this directory. Existing files will not be overwritten.',
        'The copy stays paused. Scripts, hooks, goals and agents are not started by import.',
      ] });
      if (!code) code = (await ui.secret('BZZY-TERMINAL code · hidden · Esc cancels › '))?.trim() || '';
      if (!code) return null;
      if (!terminalCode(code) && !code.startsWith('BZZY:INVITE:1:')) throw Object.assign(new Error(), { code: 'WRONG_PURPOSE' });
      const sender = (await ui.ask('Enter the full sender fingerprint from their BZZY share screen › '))?.trim();
      if (!sender) return null;
      if (!fingerprint(sender)) throw Object.assign(new Error(), { code: 'HOST_MISMATCH' });
      if (!/^import$/i.test((await ui.ask('Type IMPORT to receive this private project into the destination above › '))?.trim() || '')) return null;
      const abort = new AbortController();
      view.onCancel = () => abort.abort();
      const module = await relayLoader();
      return module.importTerminalShare({ code, cwd: path.resolve(cwd), expectedSenderFingerprint: sender, signal: abort.signal,
        onIdentity: ({ recipientFingerprint }) => {
          if (!fingerprint(recipientFingerprint)) { abort.abort(); return; }
          changeView(ui, view, { lines: [`Destination: ${path.resolve(cwd)}`, `Verified sender: ${sender}`,
            `Your recipient fingerprint: ${recipientFingerprint}`, 'Give this full fingerprint to the sender for approval. Waiting for the source host…', 'Esc cancels.'] });
        },
        onProgress: ({ received, total }) => {
          if (Number.isSafeInteger(received) && Number.isSafeInteger(total) && received >= 0 && total >= received) {
            changeView(ui, view, { notice: `Receiving encrypted project: ${received} / ${total} bytes` });
          }
        },
      });
    });
    if (result) {
      const id = result.primarySession?.id;
      ui.event('info', { message: `Terminal imported into ${path.resolve(cwd)}. Execution remains paused.${id ? `\nAttach when ready: bzzy --attach ${id}` : ''}` });
    }
    return result;
  } catch (error) { throw safeFailure(error); }
  finally { code = ''; }
}
