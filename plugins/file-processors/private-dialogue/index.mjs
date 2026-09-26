/** A composition example: a new processor identity using the native offline worker. */
export default {
  name: 'example-private-dialogue',
  inject: ['moteFileProcessors'],
  apply(ctx) {
    const native = ctx.moteFileProcessors.get('audio.local-dialogue');
    ctx.effect(() => ctx.moteFileProcessors.register({
      ...native,
      id: 'example.private-dialogue',
      name: 'Example private dialogue',
      version: `1.${native.version}`,
      localOnly: true,
      contentPolicy: 'local-only',
      allowSummary: false,
      dialogue: true,
    }));
  },
};
