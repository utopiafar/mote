import { moteText } from '@mote/shared/i18n';
export function prepareVisionImage(bgra: Uint8Array, width: number, height: number, maxSide: number): { width: number; height: number; rgbBase64: string } {
  if (![width, height, maxSide].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096) || width * height > 7_000_000 || bgra.length !== width * height * 4) throw new Error(moteText("本地模型输入像素格式无效"));
  const ratio = Math.min(1, maxSide / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * ratio)), targetHeight = Math.max(1, Math.round(height * ratio));
  const output = Buffer.alloc(targetWidth * targetHeight * 3);
  const offsets = [2, 1, 0];
  for (let y = 0; y < targetHeight; y++) {
    const sy = Math.max(0, Math.min(height - 1, (y + .5) * height / targetHeight - .5));
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, height - 1), wy = sy - y0;
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.max(0, Math.min(width - 1, (x + .5) * width / targetWidth - .5));
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, width - 1), wx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const offset = offsets[c];
        const top = bgra[(y0 * width + x0) * 4 + offset] * (1 - wx) + bgra[(y0 * width + x1) * 4 + offset] * wx;
        const bottom = bgra[(y1 * width + x0) * 4 + offset] * (1 - wx) + bgra[(y1 * width + x1) * 4 + offset] * wx;
        output[(y * targetWidth + x) * 3 + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
    }
  }
  return { width: targetWidth, height: targetHeight, rgbBase64: output.toString('base64') };
}
