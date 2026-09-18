/** Counts request-body bytes consumed by the transport, never image sizes before encoding. */
export class UploadMeter {
  private samples: { at: number; bytes: number }[] = [];
  add(bytes: number, now = performance.now()): void { this.samples.push({ at: now, bytes }); this.trim(now); }
  private trim(now: number): void { this.samples = this.samples.filter(sample => now - sample.at < 2000); }
  rate(now = performance.now()): number { this.trim(now); return this.samples.reduce((sum, sample) => sum + sample.bytes, 0) / 2; }
}
export const uploadMeter = new UploadMeter();
export function meteredBody(body: string | Uint8Array): ReadableStream<Uint8Array> {
  const bytes = Buffer.from(body); let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    const chunk = bytes.subarray(offset, offset + 64 * 1024); offset += chunk.length;
    uploadMeter.add(chunk.length); controller.enqueue(chunk);
  } }, { highWaterMark: 0 });
}
