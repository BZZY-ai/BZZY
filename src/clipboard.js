import { spawn } from 'node:child_process';

const MAX_BYTES = 512 * 1024, OSC52_BYTES = 64 * 1024;

function commands(platform, env, write) {
  if (platform === 'darwin') return [[write ? 'pbcopy' : 'pbpaste', []]];
  if (platform !== 'linux') return [];
  const result = [];
  if (env.WAYLAND_DISPLAY) result.push([write ? 'wl-copy' : 'wl-paste', write ? [] : ['--no-newline']]);
  if (env.DISPLAY) result.push(['xclip', ['-selection', 'clipboard', write ? '-in' : '-out']], ['xsel', ['--clipboard', write ? '--input' : '--output']]);
  return result;
}

function nativeClipboard(command, args, input, options) {
  const spawnImpl = options.spawnImpl || spawn, timeoutMs = Math.min(5000, Math.max(1, options.timeoutMs || 1500));
  return new Promise(resolve => {
    let child, finished = false, timer, bytes = 0; const chunks = [];
    const finish = result => { if (finished) return; finished = true; clearTimeout(timer); resolve(result); };
    const kill = () => { try { child?.kill('SIGKILL'); } catch {} };
    try { child = spawnImpl(command, args, { env: options.env || process.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); }
    catch { finish({ ok: false }); return; }
    child.once('error', () => finish({ ok: false }));
    child.once('close', code => finish(code === 0 ? { ok: true, text: Buffer.concat(chunks).toString('utf8') } : { ok: false }));
    child.stdout?.on('data', chunk => {
      if (finished) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
      if (bytes > MAX_BYTES) { kill(); finish({ ok: false, oversized: true }); return; }
      chunks.push(data);
    });
    child.stdin?.on('error', () => { kill(); finish({ ok: false }); });
    timer = setTimeout(() => { kill(); finish({ ok: false, timedOut: true }); }, timeoutMs);
    try { child.stdin?.end(input == null ? undefined : input); }
    catch { kill(); finish({ ok: false }); }
  });
}

// Clipboard reads happen only when explicitly requested by the caller. No
// terminal query is emitted: many SSH terminals cannot answer clipboard reads.
export async function readClipboard(options = {}) {
  const candidates = commands(options.platform || process.platform, options.env || process.env, false);
  for (const [command, args] of candidates) {
    const result = await nativeClipboard(command, args, null, options);
    if (result.ok) return { text: result.text, method: 'native' };
    if (result.oversized) return { text: null, reason: 'Clipboard content exceeds 512 KiB. Paste a smaller section.' };
  }
  return { text: null, reason: 'Clipboard reading is unavailable here. Use your terminal’s Paste command (usually Cmd+V on Mac or Ctrl+Shift+V on Linux).' };
}

export async function copyText(text, output = process.stdout, options = {}) {
  // Accept an options object as well as the TUI's explicit output stream.
  if (output && typeof output.write !== 'function') { options = output; output = options.output || process.stdout; }
  if (typeof text !== 'string') return { copied: false, reason: 'Select some chat text first.' };
  const content = Buffer.from(text, 'utf8');
  if (!content.length) return { copied: false, reason: 'Select some chat text first.' };
  if (content.length > MAX_BYTES) return { copied: false, reason: 'Selection exceeds 512 KiB. Copy a smaller section.' };
  const env = options.env || process.env;
  for (const [command, args] of commands(options.platform || process.platform, env, true)) {
    const result = await nativeClipboard(command, args, content, options);
    if (result.ok) return { copied: true, method: 'native' };
  }
  if (options.osc52 === false || !output?.isTTY || env.TERM === 'dumb') return { copied: false, reason: 'Clipboard copying is unavailable. Use your terminal’s text selection and Copy command.' };
  if (content.length > OSC52_BYTES) return { copied: false, reason: 'Selection is too large for a terminal clipboard request. Copy a section smaller than 64 KiB.' };
  let sequence = `\x1b]52;c;${content.toString('base64')}\x07`;
  if (env.TMUX) sequence = `\x1bPtmux;${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
  try { output.write(sequence); }
  catch { return { copied: false, reason: 'The terminal clipboard request could not be written.' }; }
  return { copied: true, method: 'osc52', reason: 'Copy request sent to the terminal. Clipboard access must be enabled in your terminal.' };
}
