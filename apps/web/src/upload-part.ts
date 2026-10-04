export interface PartReceipt { part: number; hash: string; bytes?: number }
export const uploadHash = async (body: ArrayBuffer): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',body)),byte=>byte.toString(16).padStart(2,'0')).join('');
/** Shared transport contract; import and file-ingress keep their own owner/commit protocols. */
export async function uploadFilePart(file: File, part: number, partBytes: number, existing: PartReceipt | undefined,
                                     send: (body: ArrayBuffer) => Promise<PartReceipt>, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted();
  const body = await file.slice(part * partBytes,(part + 1) * partBytes).arrayBuffer(), hash = await uploadHash(body);
  signal?.throwIfAborted();
  if (existing?.hash !== hash || existing.bytes !== body.byteLength) {
    const ack = await send(body); signal?.throwIfAborted();
    if (ack.part !== part || ack.hash !== hash || ack.bytes !== body.byteLength) throw Error('Upload part acknowledgement does not match the selected file');
  }
  return body.byteLength;
}
