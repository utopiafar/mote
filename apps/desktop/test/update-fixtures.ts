import { createHash } from 'node:crypto';
export function updateZip(entries: Array<{ name: string; text?: string; symlink?: boolean; localName?: string }>): Buffer {
  const local: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName || entry.name), body = Buffer.from(entry.text || '');
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(body.length, 22); header.writeUInt16LE(localName.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(((entry.symlink ? 0xa1ff : 0x81a4) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    local.push(header, localName, body); directory.push(central, name); offset += header.length + localName.length + body.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}
export const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
