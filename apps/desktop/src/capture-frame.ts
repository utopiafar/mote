import { nativeImage, type NativeImage } from 'electron';
import { maskBitmap } from './privacy';
import type { Rectangle } from './contracts';

/** Normalize the native scale representation before pairing pixel dimensions with bitmap bytes. */
export function prepareScreenshot(image: NativeImage, display: { width: number; height: number }, maximum: number): NativeImage {
  let normalized = nativeImage.createFromBuffer(image.toPNG());
  if (normalized.isEmpty()) throw new Error('系统未提供完整屏幕帧，本次采集已跳过');
  const size = normalized.getSize();
  const ratio = display.width / display.height;
  if (Math.abs(size.width - size.height * ratio) > Math.max(2, ratio * 2)) throw new Error('屏幕尺寸已变化或画面不完整，下一周期重试');
  const pixels = normalized.toBitmap();
  if (pixels.length !== size.width * size.height * 4) throw new Error('截图像素尺寸不一致，本次采集已跳过');
  let visible = false;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] && (pixels[i] || pixels[i + 1] || pixels[i + 2])) { visible = true; break; }
  }
  if (!visible) throw new Error('系统返回空白屏幕帧，已跳过；请检查屏幕录制权限或受保护窗口');
  if (Math.max(size.width, size.height) > maximum) normalized = normalized.resize(size.width >= size.height ? { width: maximum } : { height: maximum });
  return normalized;
}

export function maskScreenshot(image: NativeImage, rectangles: Rectangle[]): NativeImage {
  const { width, height } = image.getSize();
  return nativeImage.createFromBitmap(maskBitmap(image.toBitmap(), width, height, rectangles), { width, height });
}
