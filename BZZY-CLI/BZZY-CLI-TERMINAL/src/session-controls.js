// VIEW describes the current input lease, not the owner's permission to claim
// it. Explicit --view has no acquire callback; normal attachment does. Core
// remains responsible for accepting the claim and every subsequent mutation.
export function canControlSession(ui) {
  return ui.sessionMode !== 'VIEW' || typeof ui.permissionConnection?.acquire === 'function';
}
