// Builds zip files byte by byte so tests can make archives that a normal zip tool would refuse to write.
import { crc32, deflateRawSync } from "node:zlib";

export type ZipEntry = {
  name: string;
  data?: Buffer | string;
  method?: 0 | 8; // 0 = stored, 8 = deflate (default)
  unixMode?: number; // e.g. 0o100644 file, 0o120777 symlink
  size?: number; // lie about the uncompressed size
  crc?: number; // lie about the checksum
  flags?: number; // 1 = encrypted
  rawMethod?: number; // an unsupported compression method number
};

export function buildZip(entries: ZipEntry[], options: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.name.endsWith("/");
    const data = Buffer.from(entry.data ?? "");
    const method = entry.rawMethod ?? entry.method ?? (isDir ? 0 : 8);
    const stored = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, "utf8");
    const crc = entry.crc ?? crc32(data);
    const size = entry.size ?? data.length;
    const flags = entry.flags ?? 0;
    const mode = entry.unixMode ?? (isDir ? 0o040755 : 0o100644);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

/** A minimal valid Node project as zip entries, optionally inside a top-level folder. */
export function projectEntries(prefix = "", extra: ZipEntry[] = []): ZipEntry[] {
  return [
    { name: `${prefix}package.json`, data: JSON.stringify({ name: "zipped", scripts: { test: "node test.js" } }) },
    { name: `${prefix}test.js`, data: "console.log('hi')\n" },
    ...extra.map((e) => ({ ...e, name: `${prefix}${e.name}` })),
  ];
}
