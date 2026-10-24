import { clip, cellWidth, clean, wrap } from './terminal-format.js';
import { palette } from './terminal-theme.js';
import { replaceCells, fillSurface, sliceCells } from './terminal-surface.js';
import { isStalledGoal } from '@bzzy/core/engine/goal-state.js';

const coats = ['#76b8ae', '#9b9acb', '#d5a179', '#8faed0', '#b7bf83', '#c68eaa', '#87b8cd', '#c9aa79', '#a9b5d3', '#a7bc9c', '#c59f94', '#b6a5ce'];
const rgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
const hex = values => '#' + values.map(value => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((value, i) => value * (1 - t) + b[i] * t);
const ease = value => value * value * (3 - 2 * value);

// Original procedural sprites: supersampled organic silhouettes, lit coats and
// separate eye/pupil geometry. No image protocols, font ligatures or network
// assets are required. Color conversion belongs to the terminal theme.
export function characterSprite(appearance, state, seconds, theme, { width = 22, height = 10, animate = true } = {}) {
  const seed = Math.abs(appearance || 0) % coats.length, base = rgb(coats[seed]);
  const background = rgb(theme.name === 'white' ? '#FFFFFF' : theme.name === 'black' ? '#000000' : palette.background);
  const moving = animate && ['working', 'speaking'].includes(state), time = animate ? seconds : 0;
  const bob = moving ? Math.sin(time * 2.2 + seed) * .035 : Math.sin(time * 1.1 + seed) * .008;
  const blink = animate && (time + seed * 1.37) % 6.7 > 6.52;
  const eyes = state === 'paused' ? .045 : state === 'achieved' ? .065 : blink ? .025 : .15;
  const gaze = state === 'speaking' ? .045 : moving ? Math.sin(time * .8) * .027 : 0;
  function sample(px, py) {
    let x = (px / width - .5) * 2.6, y = (py / (height * 2) - .5) * 2.35 - bob;
    const lean = seed % 3 === 0 ? .09 : seed % 3 === 1 ? -.07 : 0;
    x += y * lean;
    const angle = Math.atan2(y, x), radius = .82 + .04 * Math.cos(angle * (3 + seed % 3) + seed);
    let distance = Math.hypot(x * (1 + .10 * Math.sin(y * 2 + seed)), y * (seed % 4 === 0 ? 1.1 : .97)) - radius;
    if (seed % 4 === 1) distance = Math.min(distance, Math.hypot(x + .45, y + .64) - .23);
    if (seed % 4 === 2) distance = Math.min(distance, Math.hypot(x - .41, y + .61) - .24);
    const coverage = ease(Math.max(0, Math.min(1, .5 - distance * width * .7)));
    if (!coverage) return background;
    const light = Math.max(0, Math.min(1, .48 - x * .23 - y * .24));
    let color = mix(base.map(value => value * .54), mix(base, [255, 255, 255], .30), light);
    const shine = Math.exp(-((x + .33) ** 2 / .09 + (y + .48) ** 2 / .035));
    color = mix(color, [255, 255, 255], shine * .26);
    for (const ex of [-.245, .245]) {
      const eye = ((x - ex) / .135) ** 2 + ((y + .07) / eyes) ** 2;
      if (eye < 1) color = [238, 247, 248];
      if (!blink && eyes > .07 && ((x - ex - gaze) / .047) ** 2 + ((y + .055) / .083) ** 2 < 1) color = [27, 41, 56];
      if (state === 'achieved' && Math.abs(y + .06 + .09 * (1 - Math.abs((x - ex) / .14))) < .022 && Math.abs(x - ex) < .14) color = base;
    }
    if (state === 'speaking' && Math.hypot(x * 1.6, (y - .29) * (5 + Math.sin(time * 9) * 2)) < .10) color = [42, 54, 63];
    return mix(background, color, coverage);
  }
  const pixel = (x, y) => {
    let value = [0, 0, 0];
    for (const dx of [.25, .75]) for (const dy of [.25, .75]) value = value.map((v, i) => v + sample(x + dx, y + dy)[i] / 4);
    return hex(value);
  };
  return Array.from({ length: height }, (_, row) => {
    let line = '';
    for (let col = 0; col < width; col++) {
      if (theme.level < 2) {
        let mask = 0; const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
        for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) {
          const value = sample(col + (x + .5) / 2, row * 2 + (y + .5) / 2);
          if (value.some((v, i) => Math.abs(v - background[i]) > 20) && Math.min(...value) < 230) mask |= bits[y][x];
        }
        const tone = [palette.accent, palette.agent, palette.warning, palette.user, palette.goalSuccess, palette.muted][seed % 6];
        line += theme.foreground(tone) + (mask ? String.fromCodePoint(0x2800 + mask) : ' ');
      } else line += theme.foreground(pixel(col, row * 2)) + theme.background(pixel(col, row * 2 + 1)) + '▀';
    }
    return line + '\x1b[0m' + theme.background(palette.background);
  });
}

export function canvasStatus(snapshot, binding) {
  if (binding?.stale) return { label: 'Link changed · unlink to repair', state: 'paused', tone: palette.warning };
  if (!snapshot) return { label: 'Ready · awaiting assignment', state: 'idle', tone: palette.muted };
  const session = snapshot.session || snapshot, goal = session.goal, active = ['queued', 'launching', 'running'].includes(snapshot.execution?.state);
  if (snapshot.questions?.length || session.executionState === 'waiting_for_input') return { label: 'Needs your input', state: 'waiting', tone: palette.warning };
  if (active) return { label: 'Working', state: 'working', tone: palette.accent };
  if (binding?.groupStalled) return { label: 'Group needs review', state: 'stalled', tone: palette.danger };
  if (binding?.groupGoalStatus === 'complete' && !['BRAIN', 'HANDS'].includes(binding.role)) return { label: 'Goal achieved', state: 'achieved', tone: palette.goalSuccess };
  if (binding?.assignment?.outcome === 'accepted') return { label: 'Work accepted', state: 'achieved', tone: palette.goalSuccess };
  if (binding?.assignment?.state === 'awaiting_review') return { label: 'Reported · awaiting review', state: 'waiting', tone: palette.warning };
  if (goal?.status === 'complete') return { label: 'Goal achieved', state: 'achieved', tone: palette.goalSuccess };
  if (isStalledGoal(goal) || ['stalled', 'failed'].includes(goal?.status) || session.executionState === 'failed') return { label: 'Needs review · ' + (goal?.status || 'failed'), state: 'stalled', tone: palette.danger };
  if (session.executionState === 'paused' || goal?.status === 'paused') return { label: 'Paused', state: 'paused', tone: palette.warning };
  return { label: goal?.status === 'cancelled' ? 'Cancelled' : 'Ready', state: 'idle', tone: palette.muted };
}

function curve(points, width, height) {
  const dots = new Map(), masks = [[1, 8], [2, 16], [4, 32], [64, 128]];
  for (let step = 0; step <= 180; step++) {
    const t = step / 180, u = 1 - t;
    const x = Math.round((u ** 3 * points[0][0] + 3 * u * u * t * points[1][0] + 3 * u * t * t * points[2][0] + t ** 3 * points[3][0]) * 2);
    const y = Math.round((u ** 3 * points[0][1] + 3 * u * u * t * points[1][1] + 3 * u * t * t * points[2][1] + t ** 3 * points[3][1]) * 4);
    const col = Math.floor(x / 2), row = Math.floor(y / 4);
    if (col < 0 || row < 0 || col >= width || row >= height) continue;
    const key = `${col}:${row}`; dots.set(key, (dots.get(key) || 0) | masks[y % 4][x % 2]);
  }
  return dots;
}

export function renderCanvas(tui, width, height) {
  const view = tui.ui.canvasView, theme = tui.theme, color = theme.color;
  tui.dashboardActive = false; tui.dashboardRendering = false; tui.composerLeft = 0; tui.eyeRegion = null;
  tui.hitTargets = []; tui.textRegion = null; tui.scrollbar = null;
  const header = tui.persistentHeader(width, height, { compact: true });
  const title = view.alias || (view.canvas ? 'New chat' : 'BZZY workspace'), titleRow = header.length;
  header.push(color(' '.repeat(Math.max(0, Math.floor((width - cellWidth(title)) / 2))) + clip(title, width - 4), palette.text, true));
  tui.hitTargets.push({ type: 'canvas-title', row: titleRow + 1, left: 1, right: width });
  header.push(color('─'.repeat(width), palette.border));
  const lines = [...header, ...Array.from({ length: Math.max(0, height - header.length) }, () => '')];
  const put = (x, y, text) => { if (y >= header.length && y < height - 2) lines[y] = replaceCells(lines[y] || '', Math.max(0, x), text, width, theme, palette.background); };
  const top = header.length, available = height - top - 3, cardWidth = Math.min(30, width - 2);
  const nodes = view.canvas?.nodes || [], columns = Math.max(1, Math.min(nodes.length || 1, Math.floor(width / cardWidth))), cardHeight = available >= 16 ? 16 : 13;
  const capacity = Math.max(1, columns * Math.max(1, Math.floor(available / cardHeight)));
  const focused = Math.max(0, nodes.findIndex(node => node.id === view.focus));
  const page = Math.floor(focused / capacity), visible = nodes.slice(page * capacity, (page + 1) * capacity), layout = new Map();
  tui.canvasGeometry = { width, top, available, cardWidth, cardHeight };
  const hierarchy = nodes.length === 2 && view.canvas.groups.length === 1 && view.canvas.groups[0].mode === 'delegate' && available >= 30 && !nodes.some(node => node.position);
  const showHeight = hierarchy ? 8 : Math.max(4, Math.min(10, available - 5));
  for (const [i, node] of visible.entries()) {
    let x = Math.floor((width / columns) * (i % columns) + (width / columns - cardWidth) / 2), y = top + 1 + Math.floor(i / columns) * cardHeight;
    if (hierarchy) { const lead = view.canvas.groups[0].lead === node.id; x = Math.floor(width * (lead ? .36 : .64) - cardWidth / 2); y = top + 1 + (lead ? 0 : 15); }
    if (node.position && available >= 16) { x = Math.round(node.position[0] * Math.max(0, width - cardWidth)); y = top + Math.round(node.position[1] * Math.max(0, available - cardHeight)); }
    layout.set(node.id, { x, y, cx: x + Math.floor(cardWidth / 2), cy: y + 3 + Math.floor(showHeight / 2) });
  }
  // Directed, curved routes are painted underneath the cast and bubbles. A
  // travelling highlight only exists for a newly observed real exchange.
  for (const group of view.canvas?.groups || []) {
    const a = layout.get(group.lead); if (!a) continue;
    for (const target of group.members.filter(id => id !== group.lead)) {
      const b = layout.get(target); if (!b) continue;
      const vertical = Math.abs(a.cy - b.cy) > 6;
      const bend = Math.min(4, Math.max(2, Math.abs(a.cx - b.cx) / 6)), points = vertical ? [[a.cx, a.cy], [a.cx + 20, a.cy], [b.cx + 20, b.cy], [b.cx, b.cy]] : [[a.cx, a.cy], [a.cx, a.cy - bend], [b.cx, b.cy - bend], [b.cx, b.cy]];
      const pulse = view.exchanges?.get(group.id), live = pulse && Date.now() - pulse.at < 2400;
      for (const [key, mask] of curve(points, width, height)) { const [x, y] = key.split(':').map(Number); put(x, y, color(String.fromCodePoint(0x2800 + mask), live ? palette.accent : palette.border)); }
      const label = group.mode === 'delegate' ? vertical ? 'BRAIN ↓ HANDS' : 'BRAIN → HANDS' : group.mode.toUpperCase();
      put(Math.max(0, Math.round((a.cx + b.cx - label.length) / 2) + (vertical ? 8 : 0)), Math.max(top, vertical ? Math.floor((a.cy + b.cy) / 2) : Math.min(a.cy, b.cy) - bend), color(' ' + label + ' ', live ? palette.accent : palette.muted));
      if (live && tui.ui.pet !== false) {
        const t = Math.max(0, Math.min(1, (Date.now() - pulse.at) / 2400)), direction = pulse.reverse ? 1 - t : t, v = 1 - direction;
        const x = v ** 3 * points[0][0] + 3 * v * v * direction * points[1][0] + 3 * v * direction ** 2 * points[2][0] + direction ** 3 * points[3][0];
        const y = v ** 3 * points[0][1] + 3 * v * v * direction * points[1][1] + 3 * v * direction ** 2 * points[2][1] + direction ** 3 * points[3][1];
        put(Math.round(x), Math.round(y), color('•', palette.accent, true));
      }
    }
  }
  for (const node of visible) {
    const { x, y } = layout.get(node.id), binding = view.bindings?.get(node.id), snapshot = view.snapshots?.get(binding?.sessionId);
    const status = canvasStatus(snapshot, binding), speech = view.bubbles?.get(node.id), speaking = speech && Date.now() - speech.at < 6500;
    const selection = binding?.selection || (snapshot?.session && !binding?.groupId ? { model: snapshot.session.resolvedModel || snapshot.session.model || node.selection.model, effort: snapshot.session.selectedEffort || node.selection.effort } : node.selection);
    const center = text => ' '.repeat(Math.max(0, Math.floor((cardWidth - cellWidth(text)) / 2))) + text;
    const focused = view.focus === node.id;
    put(x, y, color(center(clip((focused ? '› ' : '') + (binding?.role || 'SOLO') + (focused ? ' ‹' : ''), cardWidth)), focused ? palette.accent : palette.muted, focused));
    if (available < 13 || width < 38) {
      put(x, y + 1, color(center(clip((selection?.model || 'default') + ' · ' + (selection?.effort || 'default'), cardWidth)), palette.text, true));
      put(x, y + 2, color(center(clip(status.label, cardWidth)), status.tone));
      for (let row = y; row <= y + 2; row++) tui.hitTargets.push({ type: 'canvas-node', id: node.id, row: row + 1, left: x + 1, right: Math.min(width, x + cardWidth) });
      continue;
    }
    if (speaking) wrap(clean(speech.text).replace(/\s+/g, ' '), cardWidth - 4, 2, true).slice(0, 2).forEach((line, i) => put(x + 1, y + 1 + i, fillSurface(' ' + clip(line, cardWidth - 4) + ' ', cardWidth - 2, theme, palette.surface, palette.text)));
    const sprite = characterSprite(node.appearance, speaking && status.state === 'working' ? 'speaking' : status.state, tui.animationTime, theme,
      { width: Math.min(22, cardWidth - 2), height: showHeight, animate: tui.ui.pet !== false && !tui.renderingPicker });
    sprite.forEach((line, row) => put(x + Math.floor((cardWidth - Math.min(22, cardWidth - 2)) / 2), y + 3 + row, line));
    put(x, y + 3 + showHeight, color(center(clip((selection?.model || 'provider default') + ' · ' + (selection?.effort || 'default'), cardWidth)), palette.text, true));
    put(x, y + 4 + showHeight, color(center(clip(status.label, cardWidth)), status.tone));
    const goal = snapshot?.session?.goal?.objective;
    if (goal && available >= 17) put(x, y + 5 + showHeight, color(center(clip(goal, cardWidth - 2)), palette.muted));
    for (let row = y; row <= Math.min(height - 4, y + 4 + showHeight); row++) tui.hitTargets.push({ type: 'canvas-node', id: node.id, row: row + 1, left: x + 1, right: Math.min(width, x + cardWidth) });
  }
  if (!nodes.length) {
    const text = view.canvas ? 'Insert a BZZY to begin' : 'A place for your next goal';
    put(Math.max(1, Math.floor((width - text.length) / 2)), top + Math.max(0, Math.floor(available / 2) - 1), color(text, palette.text, true));
    const hint = 'Right-click anywhere · F10 opens the menu';
    put(Math.max(1, Math.floor((width - hint.length) / 2)), top + Math.max(1, Math.floor(available / 2) + 1), color(clip(hint, width - 2), palette.muted));
  }
  const footer = view.offline ? 'Core offline · controls locked · work is retained' : view.moveNode ? 'Click a new position · Esc cancels' : view.linkFrom ? 'Choose the other character · Esc cancels'
    : `Right-click / F10 menu · Tab select · Enter chat${nodes.length > capacity ? ` · ${page + 1}/${Math.ceil(nodes.length / capacity)} pages` : ''}`;
  lines[height - 2] = color('─'.repeat(width), palette.border);
  lines[height - 1] = color(' ' + clip(footer, width - 2), view.offline ? palette.warning : palette.muted);
  tui.composerRow = height; tui.sceneHeaderLength = top; tui.lastFrame = lines.map(line => sliceCells(line, 0, width));
}
