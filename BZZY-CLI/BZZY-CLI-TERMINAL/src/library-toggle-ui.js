import { cellWidth, clip } from './terminal-format.js';

// Put availability first so a narrow terminal never clips the switch away.
// The name stays a separate action: opening an entry does not change its state.
export function libraryToggleRow({ name, scope, enabled, suffix = '', viewAction, toggleAction }, columns = 80) {
  const state = enabled ? '[ ON ]' : '[OFF ]', label = `${name}${suffix}`, scopeLabel = ` · ${scope}`;
  const available = Math.max(1, columns - 1 - cellWidth('  ' + state + ' ' + scopeLabel));
  const shown = clip(label, available) + scopeLabel;
  return { text: `  ${state} ${label}${scopeLabel}`, action: viewAction, toggleAction, segments: [
    { text: '  ' }, { text: state, tone: enabled ? 'accent' : 'muted', action: toggleAction },
    { text: ' ' }, { text: shown, tone: 'accent', action: viewAction },
  ] };
}
