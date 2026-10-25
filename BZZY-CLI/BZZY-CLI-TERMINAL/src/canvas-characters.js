import { palette } from './terminal-theme.js';

const coats = ['#8accc0', '#b2aadf', '#e5b58d', '#9fbbdf', '#c6ce99', '#dba9c3', '#9bcddd', '#dfbf94', '#bdc9e5', '#bdd2b1', '#ddbaaf', '#cbbbdf'];
const basicCoats = [palette.user, palette.agent, palette.warning, palette.accent, palette.goalSuccess, palette.yolo];
const rgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
const caches = new WeakMap();

// One deliberately simple pixel character. All slots share its square outline
// and eyes; only the coat changes. Native images and terminal half-blocks sample
// the same grid, so an SSH fallback cannot turn it into a different dotted face.
function characterSampler(seed, state, time, animate, pose) {
  const moving = animate && ['working', 'speaking'].includes(state);
  const bob = moving && Math.sin(time * 2) > .6 ? 1 : 0;
  const blink = pose?.blink ?? (animate && (time + seed * 1.37) % 6.7 > 6.52);
  const gaze = Math.sign(pose?.gaze ?? (moving ? Math.sin(time * .7) * .018 : 0));
  return (px, py) => {
    const x = Math.floor(px * 24), y = Math.floor(py * 20) + bob;
    if (x < 4 || x > 19 || y < 2 || y > 17 || ([4, 19].includes(x) && [2, 17].includes(y))) return 'background';
    for (const ex of [8, 14]) {
      const dx = x - ex - gaze;
      if (state === 'achieved') {
        if (dx >= 0 && dx <= 2 && y === (dx === 1 ? 7 : 8)) return 'eyes';
      } else if (blink || state === 'paused') {
        if (dx >= 0 && dx <= 2 && y === 9) return 'eyes';
      } else if (dx >= 0 && dx <= 2 && y >= 7 && y <= 11) return 'eyes';
    }
    if (state === 'speaking' && x >= 11 && x <= 12 && y >= 14 && y <= (pose?.mouthOpen ? 15 : 14)) return 'mouth';
    return 'coat';
  };
}

export function characterSprite(appearance, state, seconds, theme, { width = 28, height = 12, animate = true } = {}) {
  const seed = Math.abs(appearance || 0) % coats.length, time = animate ? Math.floor(seconds * 10) / 10 : 0;
  const key = `${seed}:${state}:${time}:${width}:${height}:${animate}`;
  let cache = caches.get(theme); if (!cache) { cache = new Map(); caches.set(theme, cache); }
  if (cache.has(key)) return cache.get(key);
  const sample = characterSampler(seed, state, time, animate);
  const colors = { background: palette.background, coat: theme.level < 2 ? basicCoats[seed % basicCoats.length] : coats[seed], eyes: palette.text, mouth: palette.surface };
  const lines = Array.from({ length: height }, (_, row) => {
    let line = theme.background(palette.background);
    for (let col = 0; col < width; col++) {
      const top = sample((col + .5) / width, (row * 2 + .5) / (height * 2));
      const bottom = sample((col + .5) / width, (row * 2 + 1.5) / (height * 2));
      if (!theme.level) {
        const a = top === 'coat', b = bottom === 'coat';
        line += a && b ? '█' : a ? '▀' : b ? '▄' : ' ';
      } else line += top === bottom ? theme.background(colors[top]) + ' ' : theme.foreground(colors[top]) + theme.background(colors[bottom]) + '▀';
    }
    return line + '\x1b[0m' + theme.background(palette.background);
  });
  cache.set(key, lines); if (cache.size > 64) cache.delete(cache.keys().next().value);
  return lines;
}

export function characterRaster(appearance, state, theme, { width = 224, height = 192, blink = false, gaze = 0, mouthOpen = false } = {}) {
  const seed = Math.abs(appearance || 0) % coats.length;
  const sample = characterSampler(seed, state, 0, false, { blink, gaze, mouthOpen });
  const colors = { background: rgb(theme.palette.background), coat: rgb(coats[seed]), eyes: rgb(theme.palette.text), mouth: rgb(theme.palette.surface) };
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colors[sample((x + .5) / width, (y + .5) / height)], offset = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = color[channel];
  }
  return { pixels, width, height };
}
