import { createHash } from 'node:crypto';

export type ImageDedupeMode = 'off' | 'exact' | 'conservative' | 'balanced' | 'aggressive';
export interface FrameFeatures { width: number; height: number; exactHash: string; dHash: bigint; thumb: Uint8Array }
// The same grayscale, dHash, 32×32 thumbnail and thresholds as Android ScreenshotDedupeHelper.
export function imageFeatures(bgra: Buffer, width: number, height: number): FrameFeatures {
  if (width < 1 || height < 1 || bgra.length !== width * height * 4) throw new Error('Invalid bitmap');
  const gray = (x: number, y: number) => { const i = (y * width + x) * 4; return Math.floor((bgra[i + 2]! * 299 + bgra[i + 1]! * 587 + bgra[i]! * 114) / 1000); };
  const thumb = new Uint8Array(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const x0 = Math.floor(x * width / 32), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / 32));
    const y0 = Math.floor(y * height / 32), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / 32));
    let sum = 0;
    for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) sum += gray(sx, sy);
    thumb[y * 32 + x] = Math.floor(sum / ((x1 - x0) * (y1 - y0)));
  }
  let dHash = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const sy = Math.min(height - 1, Math.floor((y + .5) * height / 8));
    const sample = (sx: number) => gray(Math.min(width - 1, Math.floor((sx + .5) * width / 9)), sy);
    dHash = (dHash << 1n) | (sample(x) > sample(x + 1) ? 1n : 0n);
  }
  return { width, height, exactHash: createHash('sha256').update(bgra).digest('hex'), dHash, thumb };
}
export function duplicateImage(previous: FrameFeatures | undefined, current: FrameFeatures, mode: ImageDedupeMode): boolean {
  if (mode === 'off' || !previous || previous.width !== current.width || previous.height !== current.height) return false;
  if (previous.exactHash === current.exactHash) return true;
  if (mode === 'exact') return false;
  const [maxHash, maxPixels, maxBlocks] = { conservative: [4, .008, 2], balanced: [8, .015, 4], aggressive: [14, .03, 8] }[mode] as [number, number, number];
  let bits = previous.dHash ^ current.dHash, distance = 0;
  while (bits) { distance++; bits &= bits - 1n; }
  if (distance > maxHash) return false;
  const rows = new Array<number>(32).fill(0), cols = new Array<number>(32).fill(0), blocks = new Array<number>(64).fill(0);
  let cells = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const delta = Math.abs(previous.thumb[y * 32 + x]! - current.thumb[y * 32 + x]!);
    if (delta >= 64) cells++;
    rows[y]! += delta; cols[x]! += delta; blocks[Math.floor(y / 4) * 8 + Math.floor(x / 4)]! += delta;
  }
  return cells / 1024 <= maxPixels && blocks.filter(sum => sum / 16 >= 32).length <= maxBlocks && rows.filter(sum => sum / 32 >= 64).length <= maxBlocks && cols.filter(sum => sum / 32 >= 64).length <= maxBlocks;
}
