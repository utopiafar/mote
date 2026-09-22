/** Trusted deployment plugin. Input content is evidence, never executable instructions. */
export default {
  name: 'example-text-normalization',
  inject: ['moteContextProcessors'],
  apply(ctx) {
    ctx.effect(() => ctx.moteContextProcessors.register({
      id: 'community.text-normalization',
      version: '1.0.0',
      lane: 'extract',
      async process({observations, signal}) {
        signal.throwIfAborted();
        // One output per bounded input. Preserve attribution and originals.
        // This is byte/format normalization, not semantic classification.
        if (observations.length > 16 || observations.some(row => row.ocrText.length > 12000)) {
          throw new Error('Split this workflow into at most 16 inputs of 12000 characters.');
        }
        return observations.map(row => ({
          kind: 'normalized-text',
          text: row.ocrText.replace(/\r\n/g, '\n'),
          metadata: {sourceId: row.id, transformation: 'CRLF to LF'},
        }));
      },
    }));
  },
};
