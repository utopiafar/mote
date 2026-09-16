import {it,expect} from 'vitest';
import sharp from 'sharp';
import {compressionPreview} from '../src/compression-preview';
it('reports real encoded JPEG sizes and downsampling for generated input',async()=>{
  const low=await compressionPreview(40,640),high=await compressionPreview(95,2560);
  const bytes=Buffer.from(low.compressed.split(',')[1],'base64'),meta=await sharp(bytes).metadata();
  expect(meta.format).toBe('jpeg');expect(meta.width).toBe(640);expect(meta.height).toBe(360);expect(low.compressedBytes).toBe(bytes.length);
  expect(low.originalBytes).toBe(Buffer.from(low.original.split(',')[1],'base64').length);expect(low.compressedBytes).toBeLessThan(high.compressedBytes);
  await expect(compressionPreview(0,1280)).rejects.toThrow();await expect(compressionPreview(75,999999)).rejects.toThrow();
});
