import { afterEach, describe, expect, it, vi } from 'vitest';
import { maskBitmap, parseReviewDecision, reviewLocally, shouldExclude, shouldExcludeVisibleApps } from '../src/privacy';
import { image } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('pre-persistence privacy', () => {
  it('applies only exact user configured app IDs and skips unknown identity', () => {
    expect(shouldExclude('dev.private', ['dev.private'])).toBe(true);
    expect(shouldExclude('dev.private.extra', ['dev.private'])).toBe(false);
    expect(shouldExclude(undefined, [])).toBe(true);
  });
  it('also blocks an excluded background window and unresolved application windows when filters are configured', () => {
    expect(shouldExcludeVisibleApps(['dev.public', 'dev.private'], false, ['dev.private'])).toBe(true);
    expect(shouldExcludeVisibleApps(['dev.public'], true, ['dev.private'])).toBe(true);
    expect(shouldExcludeVisibleApps(['dev.public'], false, ['dev.private'])).toBe(false);
    expect(shouldExcludeVisibleApps(['dev.public'], true, [])).toBe(false);
  });
  it('blacks out full covered pixels with rounded-out boundaries without changing the input', () => {
    const pixels = Buffer.alloc(4 * 4 * 4, 123);
    const masked = maskBitmap(pixels, 4, 4, [{ x: 0.26, y: 0.26, width: 0.24, height: 0.24 }]);
    expect([...masked.subarray(20, 24)]).toEqual([0, 0, 0, 255]);
    expect(masked.subarray(0, 20)).toEqual(pixels.subarray(0, 20));
    expect(pixels.every(b => b === 123)).toBe(true);
    expect(() => maskBitmap(pixels, 4, 4, [{ x: -0.1, y: 0, width: 1, height: 1 }])).toThrow();
  });
  it('validates model decisions and never treats malformed output as allow', () => {
    expect(parseReviewDecision({ allow: false, rectangles: [] })).toEqual({ allow: false, rectangles: [] });
    expect(() => parseReviewDecision({ allow: true })).toThrow();
    expect(() => parseReviewDecision({ allow: 'true' })).toThrow();
    expect(() => parseReviewDecision({ allow: true, rectangles: [{ x: 0, y: 0, width: 2, height: 1 }] })).toThrow();
    expect(() => parseReviewDecision({})).toThrow();
  });
  it('sends only explicitly supplied sanitized image to loopback and disallows redirect following', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ allow: true, rectangles: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fakeFetch);
    await reviewLocally('http://127.0.0.1:8787/review', image);
    expect(fakeFetch).toHaveBeenCalledWith('http://127.0.0.1:8787/review', expect.objectContaining({ redirect: 'error' }));
    expect(JSON.parse(fakeFetch.mock.calls[0][1].body).imageBase64).toBe(image.toString('base64'));
    await expect(reviewLocally('https://cloud.example/review', image)).rejects.toThrow();
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
  it('fails closed on network and model errors without exposing model output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private content')));
    await expect(reviewLocally('http://localhost:8787/review', image)).rejects.toThrow('本地隐私审查不可用');
  });
});
