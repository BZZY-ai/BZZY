import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

// Escape can arrive as an ordinary key, a C0 byte, Kitty CSI-u or xterm
// modifyOtherKeys. Release/repeat notifications are not new menu actions.
export function escapeInputKind(text, key = {}) {
  const sequence = key.sequence || text || '';
  const kitty = /^\x1b\[27(?::\d+)*(?:;(\d+)(?::([123]))?)?(?:;\d+(?::\d+)*)?u$/.exec(sequence);
  if (kitty) return kitty[2] && kitty[2] !== '1' ? 'ignore' : 'press';
  if (/^\x1b\[27;\d+;27~$/.test(sequence)) return 'press';
  return ['escape', 'esc'].includes(key.name) || key.code === 'Escape' || text === '\x1b' || sequence === '\x1b'
    || key.ctrl && (key.name === '[' || text === '[') ? 'press' : null;
}

// Normalize extended Backspace before readline can split a packet into text.
// Kitty/xterm encode Shift, Alt and Ctrl in bits 0, 1 and 2, plus one.
function backspacePacket(sequence) {
  const kitty = /^\x1b\[(?:8|127)(?::\d+)*(?:;(\d+)(?::([123]))?)?(?:;\d+(?::\d+)*)?u$/.exec(sequence);
  const xterm = /^\x1b\[27;(\d+);(?:8|127)~$/.exec(sequence);
  if (!kitty && !xterm) return null;
  const modifiers = Number(kitty?.[1] || xterm?.[1] || 1) - 1;
  if (kitty?.[2] === '3' || !Number.isSafeInteger(modifiers) || modifiers < 0 || modifiers > 255 || modifiers & ~(1 | 2 | 4 | 64 | 128)) return { ignore: true };
  return { key: { name: 'backspace', sequence, shift: Boolean(modifiers & 1), meta: Boolean(modifiers & 2), ctrl: Boolean(modifiers & 4) } };
}

// Buffer only possible Escape/Backspace packets; the caller bounds partials.
export function possibleEscapeSequence(sequence) {
  return ['\x1b', '\x1b[', '\x1b[1', '\x1b[12', '\x1b[2'].includes(sequence) || /^\x1b\[(?:27|127|8)[\d;:]*[u~]?$/.test(sequence);
}
// Node splits CSI-u event notifications and modifyOtherKeys packets into an
// unknown prefix and printable characters. Consume Escape packets before its
// decoder, and give arrows, Alt chords, mouse reports and text to readline.
export class TerminalKeyInput {
  constructor(onKey, onEscape, { timeout = 50 } = {}) {
    this.onKey = onKey; this.onEscape = onEscape; this.timeout = timeout; this.pending = '';
    this.utf8 = new StringDecoder('utf8'); this.decoder = new PassThrough();
    readline.emitKeypressEvents(this.decoder, { escapeCodeTimeout: timeout });
    this.decoder.on('keypress', onKey);
  }
  write(chunk) {
    if (this.closed) return;
    const text = Buffer.isBuffer(chunk) ? this.utf8.write(chunk) : String(chunk ?? '');
    let ordinary = '';
    const flush = () => { if (ordinary) { this.decoder.write(ordinary); ordinary = ''; } };
    for (const character of text) {
      clearTimeout(this.timer); this.timer = null;
      if (!this.pending) {
        if (character !== '\x1b') { ordinary += character; continue; }
        flush(); this.pending = character;
      } else if (character === '\x1b') {
        flush(); this.flushPending(); this.pending = character;
      } else this.pending += character;
      const kind = escapeInputKind('', { sequence: this.pending }), backspace = backspacePacket(this.pending);
      if (this.pending !== '\x1b' && (kind || backspace)) {
        flush(); const sequence = this.pending; this.pending = '';
        if (kind === 'press') this.onEscape('', { name: 'escape', sequence });
        else if (backspace && !backspace.ignore) this.onKey('', backspace.key);
      } else if (this.pending.length > 64 || !possibleEscapeSequence(this.pending) || /[u~]$/.test(this.pending)) {
        ordinary += this.pending; this.pending = '';
      }
      if (this.pending) {
        this.timer = setTimeout(() => this.flushPending(), this.timeout);
        this.timer.unref?.();
      }
    }
    flush();
  }
  flushPending() {
    clearTimeout(this.timer); this.timer = null;
    const sequence = this.pending; this.pending = '';
    if (sequence === '\x1b') this.onEscape('', { name: 'escape', sequence });
    else if (sequence) this.decoder.write(sequence);
  }
  close() {
    this.closed = true; clearTimeout(this.timer); this.pending = '';
    this.decoder.removeAllListeners('keypress'); this.decoder.destroy();
  }
}
