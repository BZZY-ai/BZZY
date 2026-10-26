import { randomUUID } from 'node:crypto';
import { ensureRuntime, runtimeRequest, requireOwner } from './runtime.js';
import { setTerminalYolo, terminalYolo, enableAttachedTerminalYolo } from '@bzzy/core/engine/terminal-permissions.js';
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

export function initializeLaunchYolo(ui, sessionId, owner, { attached = false } = {}) {
  const initialized = ui.yoloLaunchInitialized ||= new Set();
  if (ui.launchYolo !== true || initialized.has(sessionId)) return;
  const authorization = { authorize: () => requireOwner(sessionId, owner) };
  const result = attached ? enableAttachedTerminalYolo(sessionId, randomUUID(), authorization)
    : setTerminalYolo(sessionId, { enabled: true }, randomUUID(), authorization);
  ui.sessionPermissionStates?.set(sessionId, true);
  if (result.policyUpgraded) ui.event('info', { message: 'YOLO on · this saved parent now permits workspace writes. Network restrictions and isolated worker/review policies are retained.' });
  initialized.add(sessionId);
}
