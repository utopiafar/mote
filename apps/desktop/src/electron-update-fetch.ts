import type { ClientRequest, ClientRequestConstructorOptions, IncomingMessage } from 'electron';
import { Readable } from 'node:stream';

const headersFrom = (values: Record<string, string | string[]>): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  return headers;
};

/** Electron 41 net.fetch cancels manual redirects; expose each hop to the shared verifier. */
export function createChromiumUpdateFetch(request: (options: ClientRequestConstructorOptions) => ClientRequest): typeof fetch {
  return async (input, init) => {
    if (typeof input !== 'string' && !(input instanceof URL)) throw new Error('UPDATE_REQUEST_INVALID');
    if (init?.body != null || (init?.method && init.method !== 'GET') || init?.redirect !== 'manual') throw new Error('UPDATE_REQUEST_INVALID');
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('UPDATE_REQUEST_INVALID');
    if (init.signal?.aborted) throw new DOMException('Update cancelled', 'AbortError');
    const headers = new Headers(init.headers);
    for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
    const outgoing: Record<string, string> = {}; headers.forEach((value, name) => { outgoing[name] = value; });
    return new Promise<Response>((resolve, reject) => {
      let completed = false, responded = false;
      let incoming: Readable | undefined, controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const pending = request({ url: url.href, method: 'GET', headers: outgoing, redirect: 'manual', credentials: 'omit', useSessionCookies: false, bypassCustomProtocolHandlers: true });
      const cleanup = () => init.signal?.removeEventListener('abort', abort);
      const fail = (aborted = false) => {
        if (completed) return;
        completed = true; cleanup();
        const error = aborted ? new DOMException('Update cancelled', 'AbortError') : new Error('UPDATE_NETWORK_FAILED');
        incoming?.destroy(error); controller?.error(error); pending.abort(); reject(error);
      };
      const abort = () => fail(true);
      pending.on('error', () => fail());
      pending.on('abort', () => fail(true));
      // Electron 41 may emit the writable close after finish, before response/redirect.
      // Only errors, explicit abort, response end or the shared AbortSignal complete a transfer.
      pending.on('login', (_info, callback) => callback());
      pending.on('redirect', (status, _method, _url, responseHeaders) => {
        if (completed || responded) return;
        try {
          const response = new Response(null, { status, headers: headersFrom(responseHeaders) });
          responded = completed = true; cleanup(); resolve(response);
          // Never follow here: shared/release checks Location and its allowed host before the next request.
          pending.abort();
        } catch { fail(); }
      });
      pending.on('response', (response: IncomingMessage) => {
        if (completed || responded) return;
        try {
          // Pinned Electron 41 IncomingMessage extends Node Readable despite the narrower public d.ts.
          if (!(response instanceof Readable)) { fail(); return; }
          incoming = response;
          const reader = (Readable.toWeb(incoming, { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } }) as ReadableStream<Uint8Array>).getReader();
          const body = new ReadableStream<Uint8Array>({
            start(value) { controller = value; },
            async pull(value) {
              try {
                const next = await reader.read(); if (completed) return;
                if (next.done) { completed = true; cleanup(); value.close(); } else value.enqueue(next.value);
              } catch { fail(init.signal?.aborted); }
            },
            async cancel() {
              if (completed) return;
              completed = true; cleanup(); pending.abort();
              await reader.cancel().catch(() => {});
            },
          }, { highWaterMark: 1 });
          responded = true;
          resolve(new Response(body, { status: response.statusCode, headers: headersFrom(response.headers) }));
        } catch { fail(); }
      });
      init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) abort(); else pending.end();
    });
  };
}
