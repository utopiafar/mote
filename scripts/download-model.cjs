// Downloads model weights only; no capture content is read or transmitted.
const { VisionModelStore, QWEN_MODEL } = require('@mote/local-inference');
const { resolve } = require('node:path');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const directory = resolve(option('--output', '.mote/models/qwen'));
const store = new VisionModelStore(directory);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
let last = 0;
(async () => {
  console.log(`Model: ${QWEN_MODEL.id}@${QWEN_MODEL.revision}`);
  if (args.includes('--verify-only')) {
    const state = await store.inspect(); console.log(state);
    if (state.state !== 'ready') process.exitCode = 1;
  }
  else console.log(await store.download({
    source: option('--source', 'auto'), customUrl: option('--url', undefined), signal: controller.signal,
    onProgress: ({ bytes, totalBytes, source }) => {
      if (Date.now() - last > 5000 || bytes === totalBytes) {
        console.log(`${source}: ${(bytes / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MiB`); last = Date.now();
      }
    },
  }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
