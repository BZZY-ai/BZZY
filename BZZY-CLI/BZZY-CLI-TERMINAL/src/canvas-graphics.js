import { deflateSync, crc32 } from 'node:zlib';
import { randomInt } from 'node:crypto';
import { characterRaster } from './canvas-characters.js';

// Direct PNG transport only: no terminal filesystem access, subprocesses,
// capability queries or response bytes that could enter the message composer.
// https://sw.kovidgoyal.net/kitty/graphics-protocol/
export function supportsCanvasGraphics(output, env = process.env) {
  if (!output?.isTTY || env.NO_COLOR || env.FORCE_COLOR === '0' || env.BZZY_CANVAS_GRAPHICS === 'off' || env.TMUX || /^(screen|tmux)/.test(env.TERM || '')) return false;
  if (env.KITTY_WINDOW_ID || /^(xterm-kitty|xterm-ghostty)$/.test(env.TERM || '') || /^(kitty|ghostty|WarpTerminal)$/i.test(env.TERM_PROGRAM || '')) return true;
  const [major, minor] = String(env.TERM_PROGRAM_VERSION || '').split('.').map(Number);
  return env.TERM_PROGRAM === 'iTerm.app' && (major > 3 || major === 3 && minor >= 6);
}

function chunk(type, data) {
  const tag = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([length, tag, data, checksum]);
}
export function characterPNG(appearance, state, theme, pose = {}) {
  const { pixels, width, height } = characterRaster(appearance, state, theme, pose);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const scan = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row++) pixels.copy(scan, row * (width * 3 + 1) + 1, row * width * 3, (row + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scan, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}
const command = (controls, payload = '') => `\x1b_G${controls};${payload}\x1b\\`;
const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
function visibleTiles(rect, blocked) {
  let tiles = [rect];
  for (const other of blocked) tiles = tiles.flatMap(tile => {
    if (!intersects(tile, other)) return [tile];
    const left = Math.max(tile.left, other.left), right = Math.min(tile.right, other.right), top = Math.max(tile.top, other.top), bottom = Math.min(tile.bottom, other.bottom);
    return [{ left: tile.left, right: tile.right, top: tile.top, bottom: top },
      { left: tile.left, right: tile.right, top: bottom, bottom: tile.bottom },
      { left: tile.left, right: left, top, bottom }, { left: right, right: tile.right, top, bottom }]
      .filter(part => part.right > part.left && part.bottom > part.top);
  });
  return tiles;
}

export class CanvasGraphics {
  constructor(output, env = process.env) {
    this.enabled = supportsCanvasGraphics(output, env); this.cache = new Map(); this.placements = new Map(); this.serial = randomInt(100000, 1000000000);
    this.output = output;
  }
  prepare(plans = [], blocked = [], { force = false } = {}) {
    if (!this.enabled) return { before: '', after: '' };
    let before = '', after = ''; const next = new Map();
    for (const plan of plans) {
      const rect = { left: plan.left, right: plan.left + plan.columns, top: plan.top, bottom: plan.top + plan.rows };
      if (rect.left < 0 || rect.top < 0 || rect.right >= (this.output.columns || 80) || rect.bottom > (this.output.rows || 24)) continue;
      const tiles = visibleTiles(rect, blocked); if (!tiles.length) continue;
      const time = plan.animate ? plan.seconds : 0, seed = Math.abs(plan.appearance || 0) % 12;
      const pose = { blink: plan.animate && (time + seed * 1.37) % 6.7 > 6.52,
        gaze: ['working', 'speaking'].includes(plan.state) && plan.animate ? Math.sin(time * .7) > 0 ? .018 : -.018 : 0,
        mouthOpen: plan.state === 'speaking' && Math.sin(time * 7) > 0 };
      const key = `${plan.appearance}:${plan.state}:${plan.theme.name}:${pose.blink}:${pose.gaze}:${pose.mouthOpen}`;
      let image = this.cache.get(key);
      if (!image) {
        image = { id: ++this.serial, data: characterPNG(plan.appearance, plan.state, plan.theme, pose).toString('base64') };
        this.cache.set(key, image);
        for (let offset = 0; offset < image.data.length; offset += 4096) {
          const payload = image.data.slice(offset, offset + 4096), more = offset + 4096 < image.data.length ? 1 : 0;
          after += command(offset ? `m=${more},q=2` : `a=t,f=100,t=d,i=${image.id},q=2,m=${more}`, payload);
        }
      }
      for (const [index, tile] of tiles.entries()) {
        const partial = tile.left !== rect.left || tile.right !== rect.right || tile.top !== rect.top || tile.bottom !== rect.bottom;
        const placementKey = partial ? `${plan.id}#${index}` : plan.id;
        const previous = this.placements.get(placementKey), placement = previous?.placement || ++this.serial;
        const columns = tile.right - tile.left, rows = tile.bottom - tile.top;
        const x = Math.round((tile.left - rect.left) * 224 / plan.columns), y = Math.round((tile.top - rect.top) * 192 / plan.rows);
        const w = Math.round((tile.right - rect.left) * 224 / plan.columns) - x, h = Math.round((tile.bottom - rect.top) * 192 / plan.rows) - y;
        const crop = partial ? `,x=${x},y=${y},w=${w},h=${h}` : '';
        const signature = `${image.id}:${tile.left}:${tile.top}:${columns}:${rows}${crop}`;
        next.set(placementKey, { imageId: image.id, placement, signature });
        if (force || previous?.signature !== signature) {
          if (previous) before += command(`a=d,d=i,i=${previous.imageId},p=${previous.placement},q=2`);
          after += `\x1b[${tile.top + 1};${tile.left + 1}H` + command(`a=p,i=${image.id},p=${placement},c=${columns},r=${rows}${crop},C=1,z=1,q=2`);
        }
      }
    }
    for (const [key, value] of this.placements) if (!next.has(key)) before += command(`a=d,d=i,i=${value.imageId},p=${value.placement},q=2`);
    this.placements = next;
    const used = new Set([...next.values()].map(value => value.imageId));
    for (const [key, value] of this.cache) if (this.cache.size > 48 && !used.has(value.id)) { after += command(`a=d,d=I,i=${value.id},q=2`); this.cache.delete(key); }
    return { before, after: after ? '\x1b7' + after + '\x1b8' : '' };
  }
  clear() {
    const result = this.enabled ? [...this.cache.values()].map(value => command(`a=d,d=I,i=${value.id},q=2`)).join('') : '';
    this.cache.clear(); this.placements.clear(); return result;
  }
}
