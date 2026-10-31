// Shared semantic colors keep every terminal screen on the same theme. The
// default "hive" values double as the tokens call sites pass; each theme maps a
// token to its own color by value, so every key keeps a distinct value here.
export const palette = Object.freeze({
  background: '#0A0D12', surface: '#0E1219', accent: '#FFB224',
  text: '#E6EAF0', muted: '#7D8899', border: '#5E4D2B', warning: '#FF9640',
  selection: '#2B200B', hover: '#3B2C0F',
  elevated: '#171E29', user: '#3CD3F0', userSurface: '#0B1A21', userText: '#E3F5FA',
  agent: '#B07CFF', agentSurface: '#140F1F', success: '#4ADE80',
  main: '#FF5BC9', tool: '#79B8FF',
  goalActive: '#5EEAD4', goalSuccess: '#34D399', danger: '#FF5470', yolo: '#FF4FA3',
});

const blue = Object.freeze({
  background: '#000000', surface: '#050508', accent: '#00D9FF',
  text: '#E2EEFF', muted: '#8297B3', border: '#18354A', warning: '#FFBF00',
  selection: '#082432', hover: '#102536',
  elevated: '#0B101A', user: '#00D9FF', userSurface: '#000001', userText: '#E2EEFF',
  agent: '#B45CFF', agentSurface: '#050509', success: '#00FF9C',
  main: '#FF1493', tool: '#FF9500',
  goalActive: '#00D9FF', goalSuccess: '#00FF9C', danger: '#FF365E', yolo: '#FF1493',
});

export const paletteNames = Object.freeze(['hive', 'blue', 'black', 'white']);
export const paletteChoice = 'Choose /color hive, /color blue, /color black or /color white.';

// Call sites pass semantic hive tokens. Resolve those tokens within each theme
// instance, keeping separate UI instances and rich-body colors safe.
export const palettes = Object.freeze({
  hive: palette,
  blue,
  black: Object.freeze({ ...blue,
    background: '#000000', surface: '#111111', elevated: '#1C1C1C',
    text: '#F2F2F2', muted: '#A3A3A3', border: '#414141', accent: '#E5E5E5',
    selection: '#292929', hover: '#383838', warning: '#E8B86B',
    user: '#8DD5AD', userSurface: '#10251A', userText: '#E0F5E8',
    agent: '#C6BEEC', agentSurface: '#18151F', success: '#8DD5AD',
    goalActive: '#B4C4FF', goalSuccess: '#7CDEA6', danger: '#FF8490', yolo: '#EAA2CE',
  }),
  white: Object.freeze({ ...blue,
    background: '#FFFFFF', surface: '#F3F4F5', elevated: '#E8EBEE',
    text: '#17212B', muted: '#52606D', border: '#8996A3', accent: '#176378',
    selection: '#DCE9EF', hover: '#C9DDE7', warning: '#805000',
    user: '#196143', userSurface: '#E7F3EC', userText: '#173E2B',
    agent: '#5D408D', agentSurface: '#F0ECF7', success: '#196143',
    goalActive: '#244EA7', goalSuccess: '#087B49', danger: '#B4233A', yolo: '#9D2864',
  }),
});

export function colorLevel(output, env = process.env) {
  if (env.NO_COLOR || env.FORCE_COLOR === '0') return 0;
  if (env.FORCE_COLOR != null) return env.FORCE_COLOR === '3' ? 3 : env.FORCE_COLOR === '2' ? 2 : 1;
  if (!output?.isTTY || env.TERM === 'dumb') return 0;
  if (/truecolor|24bit/i.test(env.COLORTERM || '') || /direct|truecolor|24bit/i.test(env.TERM || '') || /^(iTerm.app|WezTerm|vscode|ghostty)$/.test(env.TERM_PROGRAM || '')) return 3;
  return /256color/.test(env.TERM || '') ? 2 : 1;
}

const rgb = hex => hex.slice(1).match(/../g).map(value => parseInt(value, 16));
const xterm = Array.from({ length: 240 }, (_, offset) => {
  const index = offset + 16;
  return index >= 232 ? [index, ...Array(3).fill(8 + (index - 232) * 10)]
    : [index, ...[Math.floor((index - 16) / 36), Math.floor((index - 16) / 6) % 6, (index - 16) % 6].map(value => value ? 55 + value * 40 : 0)];
});
// 16-color terminals use one ANSI index per semantic key; unlisted keys use 6.
const neonBasic = { background: 0, surface: 0, elevated: 0, userSurface: 0, agentSurface: 0, text: 15, userText: 15,
  muted: 7, border: 6, accent: 14, warning: 11, user: 14, agent: 13, success: 10, goalActive: 14, goalSuccess: 10,
  danger: 9, yolo: 13, main: 13, tool: 11 };
const basicIndexes = {
  hive: { ...neonBasic, border: 8, accent: 11, warning: 3, selection: 0, hover: 8, tool: 12, goalActive: 6 },
  blue: neonBasic,
  black: { ...neonBasic, accent: 15, border: 8, user: 10 },
  white: { background: 15, surface: 15, elevated: 7, text: 0, muted: 8, border: 8, accent: 6,
    selection: 7, hover: 7, warning: 3, user: 2, userSurface: 15, userText: 0, agent: 5, agentSurface: 15,
    success: 2, goalActive: 4, goalSuccess: 2, danger: 1, yolo: 5, main: 5, tool: 3 },
};

export function createTerminalTheme(output = process.stdout, env = process.env, name = 'hive') {
  if (!Object.hasOwn(palettes, name)) throw new Error(paletteChoice);
  const selected = palettes[name];
  const tokens = new Map(Object.entries(palette).map(([key, tone]) => [tone, selected[key]]));
  const basicTones = new Map(Object.entries(basicIndexes[name]).map(([key, index]) => [palette[key], index]));
  const level = colorLevel(output, env), cache = new Map();
  const sgr = (tone, background = false) => {
    if (!level) return '';
    const key = `${background}:${tone}`;
    if (!cache.has(key)) {
      const channels = rgb(tokens.get(tone) || tone), base = background ? 48 : 38;
      if (level === 3) cache.set(key, `\x1b[${base};2;${channels.join(';')}m`);
      else if (level === 2) {
        let nearest, distance = Infinity;
        for (const [index, ...candidate] of xterm) {
          const delta = candidate.reduce((sum, value, i) => sum + (value - channels[i]) ** 2, 0);
          if (delta < distance) { distance = delta; nearest = index; }
        }
        cache.set(key, `\x1b[${base};5;${nearest}m`);
      } else {
        const index = basicTones.get(tone) ?? 6;
        cache.set(key, `\x1b[${(background ? 40 : 30) + index % 8 + (index >= 8 ? 60 : 0)}m`);
      }
    }
    return cache.get(key);
  };
  const foreground = tone => sgr(tone);
  const background = tone => sgr(tone, true);
  const color = (text, tone = palette.text, bold = false) => level
    ? `${bold ? '\x1b[1m' : ''}${foreground(tone)}${text}\x1b[22m${foreground(palette.text)}` : String(text);
  return { name, palette: selected, level, foreground, background, color };
}
