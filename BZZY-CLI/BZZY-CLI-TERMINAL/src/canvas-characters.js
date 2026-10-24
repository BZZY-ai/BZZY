import { palette } from './terminal-theme.js';

const coats = ['#8accc0', '#b2aadf', '#e5b58d', '#9fbbdf', '#c6ce99', '#dba9c3', '#9bcddd', '#dfbf94', '#bdc9e5', '#bdd2b1', '#ddbaaf', '#cbbbdf'];
const rgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
const hex = values => '#' + values.map(value => Math.max(0, Math.min(255, Math.round(value / 4) * 4)).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => a.map((value, i) => value * (1 - t) + b[i] * t);
const distance = (a, b) => a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0);
const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];
const caches = new WeakMap();

// Eight independently colored samples per cell replace the former two large
// half-block pixels. Two local color clusters preserve opaque coats, smooth
// contours and high-contrast eyes without an image protocol or bitmap assets.
function cell(pixels, theme, background, coat, base) {
  if (pixels.every(pixel => distance(pixel, background) < 20)) return theme.background(palette.background) + ' ';
  if (theme.level < 2) {
    let mask = 0;
    pixels.forEach((pixel, i) => { if (distance(pixel, background) > 450 && Math.min(...pixel) < 230) mask |= bits[Math.floor(i / 2)][i % 2]; });
    return theme.foreground(coat) + (mask ? String.fromCodePoint(0x2800 + mask) : ' ');
  }
  let a = pixels[0], b = a, farthest = 0;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    const delta = distance(pixels[i], pixels[j]);
    if (delta > farthest) { farthest = delta; a = pixels[i]; b = pixels[j]; }
  }
  if (farthest < 400) return theme.background(hex(pixels.reduce((sum, pixel) => sum.map((value, i) => value + pixel[i] / 8), [0, 0, 0]))) + ' ';
  for (let pass = 0; pass < 2; pass++) {
    const clusters = [[], []];
    for (const pixel of pixels) clusters[distance(pixel, a) <= distance(pixel, b) ? 0 : 1].push(pixel);
    const mean = (cluster, fallback) => cluster.length ? cluster.reduce((sum, pixel) => sum.map((value, i) => value + pixel[i] / cluster.length), [0, 0, 0]) : fallback;
    a = mean(clusters[0], a); b = mean(clusters[1], b);
  }
  if (distance(a, background) < 144 || distance(b, background) >= 144 && distance(a, base) < distance(b, base)) [a, b] = [b, a];
  let mask = 0;
  pixels.forEach((pixel, i) => { if (distance(pixel, a) <= distance(pixel, b)) mask |= bits[Math.floor(i / 2)][i % 2]; });
  return theme.foreground(hex(a)) + theme.background(distance(b, background) < 144 ? palette.background : hex(b)) + String.fromCodePoint(0x2800 + mask);
}

function characterSampler(seed, state, time, theme, width, height, animate, pose) {
  const base = rgb(coats[seed]), background = rgb(theme.palette.background);
  const moving = animate && ['working', 'speaking'].includes(state);
  const bob = pose ? 0 : moving ? Math.sin(time * 1.8 + seed) * .022 : Math.sin(time + seed) * .006;
  const blink = pose?.blink ?? (animate && (time + seed * 1.37) % 6.7 > 6.52);
  const eyeHeight = state === 'paused' || blink ? .025 : .175;
  const gaze = pose?.gaze ?? (state === 'speaking' ? .025 : moving ? Math.sin(time * .7) * .018 : 0);
  function sample(px, py) {
    let x = (px / width - .5) * 2.35, y = (py / (height * 4) - .5) * 2.2 - bob;
    x += y * (seed % 3 === 0 ? .055 : seed % 3 === 1 ? -.045 : 0);
    const angle = Math.atan2(y, x), radius = .84 + .025 * Math.cos(angle * (3 + seed % 3) + seed);
    let edge = Math.hypot(x * (1 + .065 * Math.sin(y * 2 + seed)), y * (seed % 4 === 0 ? 1.06 : .98)) - radius;
    if (seed % 4 === 1) edge = Math.min(edge, Math.hypot(x + .43, y + .65) - .22);
    if (seed % 4 === 2) edge = Math.min(edge, Math.hypot(x - .40, y + .64) - .23);
    const coverage = Math.max(0, Math.min(1, .5 - edge * width * 1.4));
    if (!coverage) return background;
    const light = Math.max(0, Math.min(1, .58 - x * .2 - y * .2));
    let color = mix(base.map(value => value * .66), mix(base, [255, 255, 255], .23), light);
    color = mix(color, [255, 255, 255], Math.exp(-((x + .29) ** 2 / .10 + (y + .43) ** 2 / .05)) * .13);
    for (const ex of [-.265, .265]) {
      const happy = state === 'achieved', dy = y + .065;
      if (happy) {
        if (Math.abs(dy + .075 * (1 - ((x - ex) / .16) ** 2)) < .022 && Math.abs(x - ex) < .16) color = [247, 253, 253];
      } else {
        if (((x - ex) / .16) ** 2 + (dy / eyeHeight) ** 2 < 1) color = [248, 253, 253];
        if (!blink && eyeHeight > .05 && ((x - ex - gaze) / .058) ** 2 + ((dy - .01) / .102) ** 2 < 1) color = [21, 39, 52];
      }
    }
    if (state === 'speaking' && Math.hypot(x * 1.8, (y - .30) * (pose ? pose.mouthOpen ? 4 : 9 : 5 + Math.sin(time * 7))) < .095) color = [41, 58, 68];
    return mix(background, color, coverage);
  }
  return { sample, base, background };
}

export function characterSprite(appearance, state, seconds, theme, { width = 28, height = 12, animate = true } = {}) {
  const seed = Math.abs(appearance || 0) % coats.length;
  const time = animate ? Math.floor(seconds * 10) / 10 : 0;
  const key = `${seed}:${state}:${time}:${width}:${height}`;
  let cache = caches.get(theme); if (!cache) { cache = new Map(); caches.set(theme, cache); }
  if (cache.has(key)) return cache.get(key);
  const { sample, base, background } = characterSampler(seed, state, time, theme, width, height, animate);
  const coat = [palette.accent, palette.agent, palette.warning, palette.user, palette.goalSuccess, palette.muted][seed % 6];
  const lines = Array.from({ length: height }, (_, row) => {
    let line = theme.background(palette.background);
    for (let col = 0; col < width; col++) {
      const pixels = [];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 2; x++) pixels.push(sample(col + (x + .5) / 2, row * 4 + y + .5));
      line += cell(pixels, theme, background, coat, base);
    }
    return line + '\x1b[0m' + theme.background(palette.background);
  });
  cache.set(key, lines); if (cache.size > 64) cache.delete(cache.keys().next().value);
  return lines;
}

export function characterRaster(appearance, state, theme, { width = 224, height = 192, blink = false, gaze = 0, mouthOpen = false } = {}) {
  const seed = Math.abs(appearance || 0) % coats.length;
  const { sample } = characterSampler(seed, state, 0, theme, width, height / 4, false, { blink, gaze, mouthOpen });
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = sample(x + .5, y + .5), offset = (y * width + x) * 3;
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.max(0, Math.min(255, Math.round(color[channel])));
  }
  return { pixels, width, height };
}
