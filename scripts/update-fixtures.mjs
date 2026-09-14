import { gzipSync } from 'node:zlib';
/** Synthetic bounded USTAR fixture; contains no workspace or personal data. */
export function sourceTar(version = '0.5.0', extra = [], packageVersion = version) {
  const entries = [{ name: `mote-${version}/package.json`, body: JSON.stringify({ name: 'mote', version: packageVersion, type: 'module' }) }, { name: `mote-${version}/package-lock.json`, body: '{}' }, ...extra], chunks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512), body = Buffer.from(entry.body ?? '');
    const put = (text, at, size) => header.write(text, at, size, 'utf8');
    put(entry.name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8); put(body.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12); header.fill(32, 148, 156); put(entry.type ?? '0', 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
    const sum = header.reduce((a, b) => a + b, 0); put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
