import { spawn } from 'node:child_process';
import { parseMessageBody } from '@bzzy/core/message-format';

export function responseResources(text) {
  const parsed = parseMessageBody(text), code = [];
  const content = node => node.tag === '#text' ? node.text : (node.children || []).map(content).join('');
  const visit = node => { if (node.tag === 'pre') code.push({ language: node.attributes?.language || 'code', text: content(node) }); else for (const child of node.children || []) visit(child); };
  for (const block of parsed.blocks || []) visit(block);
  if (!parsed.isFormatted) for (const match of String(text).matchAll(/^```([^\n]*)\n([\s\S]*?)^```\s*$/gm)) code.push({ language: match[1].trim() || 'code', text: match[2].replace(/\n$/, '') });
  const links = [];
  for (const match of parsed.plainText.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
    try { const url = new URL(match[0].replace(/[.,;)\]]+$/, '')); if (!url.username && !url.password && !links.includes(url.href)) links.push(url.href); } catch { /* Non-URL prose stays ordinary text. */ }
  }
  return { code: code.slice(0, 32), links: links.slice(0, 32) };
}
export async function openTerminalLink(value, { platform = process.platform, spawnImpl = spawn } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\x00-\x20\x7f-\x9f]/u.test(value)) return Promise.reject(new Error('Only plain HTTP(S) links can be opened.'));
  return new Promise((resolve, reject) => {
    const command = platform === 'darwin' ? 'open' : 'xdg-open';
    // A visible owner click is the only caller. Never execute a URL as shell
    // syntax, interpret file:// links, or open links merely because they stream.
    const child = spawnImpl(command, [url.href], { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new Error('Could not open the browser. Copy this link from the response menu.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('The terminal could not open this link.')));
  });
}
