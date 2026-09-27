/** Explicit alternative: offline ASR, with derived text available to central analysis. */
export default {
  name: 'example-local-dialogue-analysis',
  inject: ['moteFileProcessors'],
  apply(ctx) {
    const native = ctx.moteFileProcessors.get('audio.local-dialogue');
    ctx.effect(() => ctx.moteFileProcessors.register({
      ...native,
      id: 'example.local-dialogue-analysis',
      name: 'Local dialogue with central analysis',
      version: `1.${native.version}`,
      contentPolicy: undefined,
      allowSummary: true,
      parameters: native.parameters.map(parameter => parameter.key === 'semanticTurns'
        ? {...parameter, label: 'Group consecutive turns with the selected language model'}
        : parameter),
    }));
  },
};
