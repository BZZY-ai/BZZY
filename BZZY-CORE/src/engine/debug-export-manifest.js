import fs from 'node:fs';
import path from 'node:path';

// The public v1 manifest still has ordinary JSON arrays. Their entries live on
// private disk during capture so large file inventories do not accumulate in RAM.
export function createDebugManifestLog(stage) {
  const lists = Object.fromEntries(['inventory', 'exclusions'].map(name => [name,
    { file: path.join(stage, `.manifest-${name}.jsonl`), fd: undefined, count: 0, bytes: 0 }]));
  const close = () => {
    for (const list of Object.values(lists)) if (list.fd !== undefined) {
      const fd = list.fd; list.fd = undefined; fs.closeSync(fd);
    }
  };
  return {
    count: name => lists[name].count,
    get bytes() { return Object.values(lists).reduce((sum, list) => sum + list.bytes, 0); },
    append(name, entry) {
      const list = lists[name], data = Buffer.from(JSON.stringify(entry) + '\n');
      list.fd ??= fs.openSync(list.file, 'wx', 0o600);
      let offset = 0; while (offset < data.length) offset += fs.writeSync(list.fd, data, offset);
      list.count++; list.bytes += data.length;
    },
    async write(file, metadata, onBytes = () => {}) {
      close();
      const fd = fs.openSync(file, 'wx', 0o600);
      const write = value => {
        const data = Buffer.from(value); onBytes(data.length);
        let offset = 0; while (offset < data.length) offset += fs.writeSync(fd, data, offset);
      };
      try {
        write(JSON.stringify(metadata, null, 2).slice(0, -1));
        for (const [name, list] of Object.entries(lists)) {
          write(`,\n  "${name}": [`);
          if (list.count) {
            const source = fs.createReadStream(list.file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
            let entries = 0;
            write('\n    ');
            // JSON.stringify escapes embedded newlines, so literal LF bytes
            // delimit records without decoding or buffering a whole inventory.
            for await (const chunk of source) {
              let offset = 0, newline;
              while ((newline = chunk.indexOf(10, offset)) !== -1) {
                write(chunk.subarray(offset, newline)); entries++;
                if (entries < list.count) write(',\n    ');
                offset = newline + 1;
              }
              if (offset < chunk.length) write(chunk.subarray(offset));
            }
            if (entries !== list.count) throw new Error('Diagnostic manifest entries changed during capture.');
          }
          write('\n  ]');
        }
        write('\n}\n'); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      for (const list of Object.values(lists)) if (list.count) fs.unlinkSync(list.file);
    },
    close,
  };
}
