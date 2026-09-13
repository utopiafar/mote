import type { Rectangle } from './contracts';
import { validateLocalModelUrl, validateRectangles } from './config';

export function shouldExclude(appId: string | undefined, excludedAppIds: string[]): boolean {
  // Exact identities only. Unknown foreground identity is always fail-closed.
  return !appId || excludedAppIds.includes(appId);
}
export function shouldExcludeVisibleApps(visibleAppIds: string[], unknownVisibleWindows: boolean, excludedAppIds: string[]): boolean {
  return excludedAppIds.length > 0 && (unknownVisibleWindows || visibleAppIds.some(id => excludedAppIds.includes(id)));
}

/** Electron nativeImage bitmap uses four bytes per pixel; black is channel-order independent. */
export function maskBitmap(bitmap: Buffer, width: number, height: number, rectangles: Rectangle[]): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || bitmap.length !== width * height * 4) throw new Error('截图像素格式不正确');
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

export interface ReviewDecision { allow: boolean; rectangles: Rectangle[] }
export function parseReviewDecision(value: unknown): ReviewDecision {
  if (!value || typeof value !== 'object' || typeof (value as ReviewDecision).allow !== 'boolean') throw new Error('本地隐私模型返回值无效；已跳过本次采集');
  const v = value as ReviewDecision;
  return { allow: v.allow, rectangles: validateRectangles(v.rectangles) };
}
export async function reviewLocally(url: string, image: Buffer, signal?: AbortSignal): Promise<ReviewDecision> {
  validateLocalModelUrl(url);
  try {
    const result = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      body: JSON.stringify({ version: 1, imageBase64: image.toString('base64'), imageMime: 'image/jpeg', purpose: 'privacy_review' }),
    });
    if (!result.ok) throw new Error('request failed');
    const raw = await result.text();
    if (raw.length > 64000) throw new Error('response too large');
    return parseReviewDecision(JSON.parse(raw));
  } catch {
    throw new Error('本地隐私审查不可用或返回无效结果，已跳过本次采集');
  }
}
