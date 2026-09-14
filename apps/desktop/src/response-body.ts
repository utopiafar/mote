/** Bound decoded response bytes while streaming, before allocating text or parsing JSON. */
export async function readResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('响应大小限制无效');
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('响应超过大小限制');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  // One bounded allocation also prevents tiny network chunks from growing an unbounded object list.
  const bytes = Buffer.allocUnsafe(maximumBytes);
  let length = 0, completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) { completed = true; break; }
      if (length + next.value.byteLength > maximumBytes) throw new Error('响应超过大小限制');
      bytes.set(next.value, length); length += next.value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
