import { afterEach, describe, expect, it, vi } from 'vitest';
import { heartbeat, uploadCapture } from '../src/transport';
import { defaultConfig } from '../src/config';
import { event, image } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('acknowledgment-gated uploads', () => {
  it('requires a matching 200/201 event ID, preserving retry identity', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: event().id }), { status: 201 }));
    vi.stubGlobal('fetch', fakeFetch);
    const config = { ...defaultConfig(), token: 'synthetic-token' };
    await uploadCapture(config, event(), image);
    expect(fakeFetch.mock.calls[0][0]).toBe('http://127.0.0.1:47832/api/captures');
    const options = fakeFetch.mock.calls[0][1];
    expect(options.redirect).toBe('error');
    expect(JSON.parse(await new Response(options.body).text())).toEqual({ ...event(), imageBase64: image.toString('base64') });
  });
  it.each([200, 201, 202, 401, 409, 500])('keeps queue ownership when HTTP %s does not acknowledge the exact record', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'wrong-id', privateText: 'must-not-leak' }), { status })));
    await expect(uploadCapture({ ...defaultConfig(), token: 'synthetic-token' }, event(), image)).rejects.toThrow('队列已保留');
  });
  it('does not expose network internals or tokens in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('url has synthetic-secret')));
    await expect(uploadCapture({ ...defaultConfig(), token: 'synthetic-secret' }, event(), image)).rejects.toThrow('无法连接中央节点');
  });
  it('cancels an oversized streamed acknowledgement and preserves the pending record', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel }), { status: 201 })));
    await expect(uploadCapture({ ...defaultConfig(), token: 'synthetic-token' }, event(), image)).rejects.toThrow('队列已保留');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([200, 500])('cancels unused heartbeat response bodies on HTTP %s', async status => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status })));
    await heartbeat({ ...defaultConfig(), token: 'synthetic-token' }, {});
    expect(cancel).toHaveBeenCalledOnce();
  });
});
