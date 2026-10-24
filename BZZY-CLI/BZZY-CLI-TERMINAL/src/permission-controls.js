import { randomUUID } from 'node:crypto';
import { ensureRuntime, runtimeRequest, requireOwner } from './runtime.js';
import { setTerminalYolo, terminalYolo } from '@bzzy/core/engine/terminal-permissions.js';
export { terminalYolo };

export async function changeTerminalYolo(ui, enabled) {
  const sessionId = ui.sessionId, connection = ui.permissionConnection;
  const info = connection?.info || await ensureRuntime(), owner = connection?.owner || randomUUID();
  const api = (action, body) => runtimeRequest(info, 'POST', `/sessions/${sessionId}/${action}`, { owner, ...body });
  if (connection?.acquire) await connection.acquire();
  try {
    return await runtimeRequest(info, 'POST', `/sessions/${sessionId}/input`, {
      owner, operation: 'permissions', enabled,
      ...(enabled && ui.tui?.pendingApproval ? { questionId: ui.tui.pendingApproval.id } : {}),
    }, randomUUID());
  } finally { if (!connection) await api('release', {}).catch(() => {}); }
}

export function initializeLaunchYolo(ui, sessionId, owner) {
  const initialized = ui.yoloLaunchInitialized ||= new Set();
  if (ui.launchYolo !== true || initialized.has(sessionId)) return;
  setTerminalYolo(sessionId, { enabled: true }, randomUUID(), { authorize: () => requireOwner(sessionId, owner) });
  initialized.add(sessionId);
}
