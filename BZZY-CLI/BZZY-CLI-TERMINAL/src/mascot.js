import fs from 'node:fs';
import { inflateSync } from 'node:zlib';
import { palette, createTerminalTheme } from './terminal-theme.js';

// Cyan light samples from the user's new-eyes.jpeg, rather than a substitute face.
// Each Braille cell holds a 2×4 pixel grid, keeping the antennae and compound-eye texture.
const reference = JSON.parse(fs.readFileSync(new URL('../assets/bzzy-eyes.json', import.meta.url), 'utf8'));
const pixels = inflateSync(Buffer.from(reference.cyan, 'base64'));
const dots = [[0, 0, 1], [0, 1, 2], [0, 2, 4], [1, 0, 8], [1, 1, 16], [1, 2, 32], [0, 3, 64], [1, 3, 128]];
const channels = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
const dark = channels(palette.border), bright = channels(palette.accent);
const tones = Array.from({ length: 9 }, (_, index) => '#' + bright.map((channel, axis) => Math.round(dark[axis] + (channel - dark[axis]) * index / 8).toString(16).padStart(2, '0')).join(''));

function sample(x, y) {
  const px = x * (reference.width - 1), py = y * (reference.height - 1), left = Math.floor(px), top = Math.floor(py);
  if (left < 0 || top < 0 || left >= reference.width - 1 || top >= reference.height - 1) return 0;
  const ax = px - left, ay = py - top, index = top * reference.width + left;
  return (pixels[index] * (1 - ax) + pixels[index + 1] * ax) * (1 - ay) + (pixels[index + reference.width] * (1 - ax) + pixels[index + reference.width + 1] * ax) * ay;
}

export function eyeMotion(seconds = 0) {
  const phase = seconds % 7;
  const blink = phase > 6.55 && phase < 6.95 ? Math.sin((phase - 6.55) / 0.4 * Math.PI) ** 2 : 0;
  return { x: Math.sin(seconds * 0.8) * 0.13, y: Math.sin(seconds * 0.47) * 0.04, open: 1 - blink * 0.94 };
}

function light(x, y, motion) {
  for (const cx of [0.322, 0.679]) {
    const u = (x - cx) / 0.151, v = (y - 0.567) / 0.273;
    if (Math.abs(u) > 1.12 || Math.abs(v) > 1.12) continue;
    if (Math.abs(v) > motion.open * 1.12) return 0;
    const weight = Math.max(0, 1 - u * u - v * v);
    return sample(x - motion.x * 0.151 * weight, 0.567 + (y - 0.567) / motion.open - motion.y * 0.273 * weight);
  }
  return sample(x, y);
}

// Motion uses elapsed seconds so a slow terminal skips frames without changing its speed.
export function mascotCells(seconds = 0, { columns = 44, rows = 12, compact = false } = {}) {
  const motion = eyeMotion(seconds), lines = [];
  if (compact) motion.open = Math.max(rows >= 5 ? 0.1 : 0.24, motion.open);
  const crop = compact ? { x: 0.18, y: 0.10, width: 0.64, height: 0.79 } : { x: 0, y: 0, width: 1, height: 1 };
  for (let row = 0; row < rows; row++) {
    const line = [];
    for (let column = 0; column < columns; column++) {
      let mask = 0, brightness = 0, count = 0;
      for (const [dx, dy, bit] of dots) {
        const x = crop.x + (column * 2 + dx + 0.5) / (columns * 2) * crop.width;
        const y = crop.y + (row * 4 + dy + 0.5) / (rows * 4) * crop.height;
        const value = light(x, y, motion);
        if (value > 24) { mask |= bit; brightness += value; count++; }
      }
      if (!mask) { line.push({ text: ' ', tone: null }); continue; }
      const tone = tones[Math.min(tones.length - 1, Math.floor(brightness / count / 256 * tones.length))];
      line.push({ text: String.fromCodePoint(0x2800 + mask), tone });
    }
    lines.push(line);
  }
  return lines;
}

export function mascotLine(cells, theme = createTerminalTheme()) {
  let line = '', previousTone = null;
  for (const cell of cells) {
    if (cell.tone != null && cell.tone !== previousTone) { line += theme.foreground(cell.tone); previousTone = cell.tone; }
    line += cell.text;
  }
  return line + theme.foreground(palette.text);
}

export function mascot(seconds = 0, options = {}) {
  const theme = options.theme || createTerminalTheme();
  return mascotCells(seconds, options).map(cells => mascotLine(cells, theme)).join('\n');
}

export class Pet {
  constructor(ui, enabled = true) { this.ui = ui; this.enabled = enabled && ui.interactive; this.timer = null; this.frame = 0; }
  greet() { if (this.enabled && !this.ui.tui) this.ui.output.write(`\n${mascot(0, { theme: createTerminalTheme(this.ui.output) })}\n\n`); }
  start() {
    if (!this.enabled || this.timer || this.ui.tui) return;
    const tick = () => this.ui.error.write(`\r\x1b[2K${['◖◈◗ ◖◈◗', '◖◉◗ ◖◉◗', '◖─◗ ◖─◗', '◖◉◗ ◖◉◗'][this.frame++ % 4]} buzzing…`);
    tick();
    this.timer = setInterval(tick, 180);
    this.timer.unref();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; this.ui.error.write('\r\x1b[2K'); } }
}
