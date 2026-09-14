import { expect, it, vi } from 'vitest';
import { readResponseText } from '../src/response-body';

it('bounds streamed bytes without trusting a missing or smaller Content-Length', async () => {
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel }), { headers });
    await expect(readResponseText(response, 16)).rejects.toThrow('响应超过大小限制');
    expect(cancel).toHaveBeenCalledOnce();
  }
});

it('rejects an oversized declared body before reading it and cancels the transfer', async () => {
  const cancel = vi.fn(), pull = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), { headers: { 'Content-Length': '1000' } });
  await expect(readResponseText(response, 16)).rejects.toThrow('响应超过大小限制');
  expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
});

it('handles UTF-8 split across chunks and counts bytes instead of characters', async () => {
  const bytes = new TextEncoder().encode('中文🙂');
  const response = () => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  expect(await readResponseText(response(), bytes.length)).toBe('中文🙂');
  await expect(readResponseText(response(), bytes.length - 1)).rejects.toThrow('响应超过大小限制');
  await expect(readResponseText(new Response(Uint8Array.of(0xff)), 16)).rejects.toThrow();
});
