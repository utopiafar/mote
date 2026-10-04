import { moteText } from '@mote/shared/i18n';
import type { Rectangle } from './contracts';
import { validateRectangles } from './config';

/** Electron nativeImage bitmap uses four bytes per pixel; black is channel-order independent. */
export function maskBitmap(bitmap: Buffer, width: number, height: number, rectangles: Rectangle[]): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || bitmap.length !== width * height * 4) throw new Error(moteText("截图像素格式不正确"));
  const masks = validateRectangles(rectangles);
  const output = Buffer.from(bitmap);
  for (const rect of masks) {
    const left = Math.floor(rect.x * width), top = Math.floor(rect.y * height);
    const right = Math.min(width, Math.ceil((rect.x + rect.width) * width));
    const bottom = Math.min(height, Math.ceil((rect.y + rect.height) * height));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      output[i] = output[i + 1] = output[i + 2] = 0;
      output[i + 3] = 255;
    }
  }
  return output;
}
