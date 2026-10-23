import fs from 'node:fs';
import path from 'node:path';

export const contains = (root, target) => target === root || target.startsWith(root + path.sep);

// Canonicalize an existing ancestor too, so macOS /var aliases and not-yet-created
// private directories cannot bypass scope checks.
export function canonicalPath(input) {
  let ancestor = path.resolve(input);
  const remaining = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('No existing path ancestor.');
    remaining.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), ...remaining);
}
