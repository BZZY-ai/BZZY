// Keep the terminal and local session viewer aligned with BZZY iOS.
export const palette = Object.freeze({
  background: '#03090F', surface: '#0A151F', accent: '#24DFFF',
  text: '#EDF5F2', muted: '#94ADB8', border: '#1A4354', warning: '#E4BD7C',
  selection: '#0B3444', hover: '#12475A',
  elevated: '#102331', user: '#58DFC7', userSurface: '#0B302E', userText: '#DCFFF6',
  agent: '#B9B6FF', agentSurface: '#101B2C', success: '#7DDFAD',
  goalActive: '#5385FF', goalSuccess: '#16E09A', danger: '#FF526C', yolo: '#FF5BBF',
});

// Existing call sites pass semantic blue tokens. Resolve those tokens within
// each theme instance, keeping separate UI instances and rich-body colors safe.
export const palettes = Object.freeze({
  blue: palette,
  black: Object.freeze({
    background: '#000000', surface: '#111111', elevated: '#1C1C1C',
    text: '#F2F2F2', muted: '#A3A3A3', border: '#414141', accent: '#E5E5E5',
    selection: '#292929', hover: '#383838', warning: '#E8B86B',
    user: '#8DD5AD', userSurface: '#10251A', userText: '#E0F5E8',
    agent: '#C6BEEC', agentSurface: '#18151F', success: '#8DD5AD',
    goalActive: '#B4C4FF', goalSuccess: '#7CDEA6', danger: '#FF8490', yolo: '#EAA2CE',
  }),
  white: Object.freeze({
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
const basic = new Map([[palette.background, 0], [palette.surface, 0], [palette.text, 15],
  [palette.muted, 7], [palette.border, 6], [palette.accent, 14], [palette.warning, 11]]);
basic.set(palette.user, 14); basic.set(palette.userText, 15); basic.set(palette.agent, 13);
for (const tone of [palette.elevated, palette.userSurface, palette.agentSurface]) basic.set(tone, 0);
basic.set(palette.success, 10);
basic.set(palette.goalActive, 12); basic.set(palette.goalSuccess, 10); basic.set(palette.danger, 9); basic.set(palette.yolo, 13);

export function createTerminalTheme(output = process.stdout, env = process.env, name = 'blue') {
  if (!Object.hasOwn(palettes, name)) throw new Error('Choose /color blue, /color black or /color white.');
  const selected = palettes[name];
  const tokens = new Map(Object.entries(palette).map(([key, tone]) => [tone, selected[key]]));
  const lightBasic = { background: 15, surface: 15, elevated: 7, text: 0, muted: 8, border: 8, accent: 6,
    selection: 7, hover: 7, warning: 3, user: 2, userSurface: 15, userText: 0, agent: 5, agentSurface: 15,
    success: 2, goalActive: 4, goalSuccess: 2, danger: 1, yolo: 5 };
  const basicTones = name === 'white' ? new Map(Object.entries(lightBasic).map(([key, index]) => [palette[key], index]))
    : name === 'black' ? new Map([...basic, [palette.accent, 15], [palette.border, 8], [palette.user, 10]]) : basic;
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
