import fs from 'node:fs';

// A body format is presentation only. Never use its tags as tool/control input.
export const messageFormatInstructions = fs.readFileSync(new URL('../assets/message-format.txt', import.meta.url), 'utf8').trim();
export const MESSAGE_FORMAT_LIMITS = Object.freeze({ bytes: 65_536, nodes: 2_048, depth: 12, blocks: 128, listItems: 64, columns: 6, dataRows: 64 });

const attributes = new Map(Object.entries({
  message: ['version'], p: ['size'], h1: [], h2: [], b: [], strong: [], i: [], em: [],
  span: ['size', 'color'], br: [], code: [], table: [], tr: [], th: [], td: [],
  thead: [], tbody: [], ul: [], ol: [], li: [], pre: ['language'], blockquote: [], hr: [],
}));
const sizes = new Set(['small', 'normal', 'large']);
const colors = new Set(['mint', 'amber', 'coral', 'blue', 'lavender', 'muted']);
const inline = new Set(['b', 'strong', 'i', 'em', 'code', 'span', 'br']);
const namedEntities = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });
const invalid = () => { throw new Error('invalid_markup'); };
const xmlCharacter = code => code === 9 || code === 10 || code === 13 || code >= 0x20 && code <= 0xD7FF || code >= 0xE000 && code <= 0xFFFD || code >= 0x10000 && code <= 0x10FFFF;

export function escapeMessageText(text) {
  if (typeof text !== 'string') throw new TypeError('Message content must be a string.');
  return text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function decodeText(text) {
  let result = '', cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('&', cursor);
    if (start < 0) return result + text.slice(cursor);
    result += text.slice(cursor, start);
    const end = text.indexOf(';', start + 1);
    if (end < 0) invalid();
    const entity = text.slice(start + 1, end);
    if (Object.hasOwn(namedEntities, entity)) result += namedEntities[entity];
    else {
      if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity)) invalid();
      const code = entity[1] === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isSafeInteger(code) || !xmlCharacter(code)) invalid();
      result += String.fromCodePoint(code);
    }
    cursor = end + 1;
  }
  return result;
}

function parseTree(source) {
  // No general XML engine, resource resolver, entity declarations, or expansion.
  // Reject comments/declarations/processing instructions outside this subset too.
  if (source.includes('<!') || source.includes('<?')) invalid();
  for (const character of source) if (!xmlCharacter(character.codePointAt(0))) invalid();
  const stack = [];
  let root, count = 0, cursor = 0;
  const addText = text => {
    if (!text) return;
    if (text.includes(']]>')) invalid();
    const decoded = decodeText(text);
    if (!stack.length) { if (decoded.trim()) invalid(); return; }
    const parent = stack.at(-1), previous = parent.children.at(-1);
    if (previous?.tag === '#text') previous.text += decoded;
    else {
      if (++count > MESSAGE_FORMAT_LIMITS.nodes) invalid();
      parent.children.push({ tag: '#text', text: decoded });
    }
  };
  while (cursor < source.length) {
    if (source[cursor] !== '<') {
      const end = source.indexOf('<', cursor);
      addText(source.slice(cursor, end < 0 ? source.length : end));
      cursor = end < 0 ? source.length : end;
      continue;
    }
    let end = cursor + 1, quote;
    for (; end < source.length; end++) {
      const character = source[end];
      if (quote) { if (character === quote) quote = undefined; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
      else if (character === '<') invalid();
    }
    if (end === source.length || quote) invalid();
    const tag = source.slice(cursor + 1, end);
    cursor = end + 1;
    if (tag.startsWith('/')) {
      const closing = /^\/([a-z][a-z0-9]*)[\t\r\n ]*$/.exec(tag);
      if (!closing || !stack.length || stack.pop().tag !== closing[1]) invalid();
      continue;
    }
    const start = /^([a-z][a-z0-9]*)(?=[\t\r\n /]|$)/.exec(tag);
    if (!start || !attributes.has(start[1])) invalid();
    const name = start[1], selfClosing = tag.endsWith('/');
    let remainder = tag.slice(name.length, selfClosing ? -1 : undefined);
    const attrs = Object.create(null);
    while (remainder) {
      if (/^[\t\r\n ]+$/.test(remainder)) break;
      const attr = /^[\t\r\n ]+([a-z][a-z0-9]*)[\t\r\n ]*=[\t\r\n ]*(["'])([\s\S]*?)\2/.exec(remainder);
      if (!attr || Object.hasOwn(attrs, attr[1]) || !attributes.get(name).includes(attr[1]) || attr[3].includes('<')) invalid();
      attrs[attr[1]] = decodeText(attr[3].replace(/[\t\r\n]/g, ' '));
      remainder = remainder.slice(attr[0].length);
    }
    if (Object.hasOwn(attrs, 'size') && !sizes.has(attrs.size) || Object.hasOwn(attrs, 'color') && !colors.has(attrs.color)
      || Object.hasOwn(attrs, 'language') && !/^[A-Za-z0-9_+#-]{1,24}$/.test(attrs.language)) invalid();
    if (++count > MESSAGE_FORMAT_LIMITS.nodes || stack.length >= MESSAGE_FORMAT_LIMITS.depth) invalid();
    const node = { tag: name, attributes: attrs, children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else if (root) invalid();
    else root = node;
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || root?.tag !== 'message' || root.attributes.version !== '1') invalid();
  return root;
}

function elements(node) {
  if (node.children.some(child => child.tag === '#text' && child.text.trim())) invalid();
  return node.children.filter(child => child.tag !== '#text');
}

function inlineText(node) {
  return node.children.map(child => {
    if (child.tag === '#text') return child.text;
    if (!inline.has(child.tag)) invalid();
    if (child.tag === 'br') { if (child.children.length) invalid(); return '\n'; }
    return inlineText(child);
  }).join('');
}

function blockText(node) {
  if (['p', 'h1', 'h2', 'blockquote', 'pre'].includes(node.tag)) return [inlineText(node)];
  if (node.tag === 'hr') { if (node.children.length) invalid(); return ['']; }
  if (['ul', 'ol'].includes(node.tag)) {
    const items = elements(node);
    if (items.length > MESSAGE_FORMAT_LIMITS.listItems || items.some(item => item.tag !== 'li')) invalid();
    return items.map((item, index) => `${node.tag === 'ol' ? `${index + 1}.` : '•'} ${inlineText(item)}`);
  }
  if (node.tag === 'table') {
    const rows = elements(node).flatMap(group => {
      if (group.tag === 'tr') return [group];
      if (['thead', 'tbody'].includes(group.tag)) return elements(group);
      invalid();
    });
    if (!rows.length || rows.length > MESSAGE_FORMAT_LIMITS.dataRows + 1 || rows.some(row => row.tag !== 'tr')) invalid();
    const cells = rows.map(elements), width = cells[0].length;
    if (!width || width > MESSAGE_FORMAT_LIMITS.columns || cells.some((row, index) => row.length !== width || row.some(cell => cell.tag !== (index ? 'td' : 'th')))) invalid();
    return [cells.map(row => row.map(inlineText).join(' · ')).join('\n')];
  }
  invalid();
}

function boundedPrefix(body) {
  // Avoid cutting a Unicode scalar in half at the byte boundary.
  const bytes = Buffer.from(body, 'utf8');
  let end = MESSAGE_FORMAT_LIMITS.bytes;
  while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Preserve body verbatim; validate only a derived, non-executable display view.
 * Valid rich bodies also expose blocks: nodes with tag/attributes/children,
 * and #text children with decoded text. No AST is returned for invalid bodies.
 */
export function parseMessageBody(body) {
  if (typeof body !== 'string') throw new TypeError('Message body must be a string.');
  if (Buffer.byteLength(body, 'utf8') > MESSAGE_FORMAT_LIMITS.bytes) return { body, plainText: boundedPrefix(body), isFormatted: false, truncated: true, reason: 'body_too_large' };
  const result = { body, plainText: body, isFormatted: false, truncated: false };
  const source = body.trim().replace(/\r\n?/g, '\n');
  if (!source.startsWith('<message')) return result;
  try {
    const blocks = elements(parseTree(source));
    if (blocks.length > MESSAGE_FORMAT_LIMITS.blocks) invalid();
    // Structural validation must finish before clients receive any rich nodes.
    const plainText = blocks.flatMap(blockText).join('\n\n');
    return { ...result, plainText, isFormatted: true, blocks };
  } catch {
    return { ...result, reason: 'invalid_markup' };
  }
}

export function messageBodyToPlainText(body) { return parseMessageBody(body).plainText; }
