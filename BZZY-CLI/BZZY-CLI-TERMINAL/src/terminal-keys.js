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

// Buffer only a possible Escape packet; the caller bounds partial sequences.
export function possibleEscapeSequence(sequence) {
  return ['\x1b', '\x1b[', '\x1b[2'].includes(sequence) || /^\x1b\[27[\d;:]*[u~]?$/.test(sequence);
}
// Node splits CSI-u event notifications and modifyOtherKeys packets into an
// unknown prefix and printable characters. Consume Escape packets before its
// decoder, and give arrows, Alt chords, mouse reports and text to readline.
export class TerminalKeyInput {
  constructor(onKey, onEscape, { timeout = 50 } = {}) {
    this.onEscape = onEscape; this.timeout = timeout; this.pending = '';
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
      const kind = escapeInputKind('', { sequence: this.pending });
      if (this.pending !== '\x1b' && kind) {
        flush(); const sequence = this.pending; this.pending = '';
        if (kind === 'press') this.onEscape('', { name: 'escape', sequence });
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
