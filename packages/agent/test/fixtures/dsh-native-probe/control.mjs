import {trace} from './trace.mjs';

export const name = 'dsh-native-control';
export const inject = ['agents', 'agentLoop'];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Controlled failure and rollback scenarios. Enabled only in runtime A so the
 * successful resume fixture is not created twice. */
export async function apply(ctx) {
  const mode = process.env.PROBE_CONTROL;
  const provider = process.env.PROBE_PROVIDER;
  const model = process.env.PROBE_MODEL;
  trace('control-start', {mode});
  if (mode === '2') {
    const resumed = await ctx.agents.resume({
      resumeSessionId: process.env.PROBE_RESUME_ID ?? 'probe-session-a',
      agentOptions: {provider, model},
    });
    trace('resume-handle-resumed');
    await resumed.dispose();
    trace('resume-handle-closed');
    return;
  }
  if (mode !== '1') return;

  const expectRejected = async (label, promise) => {
    try {
      await promise;
      trace(`${label}-unexpected`);
    } catch (error) {
      trace(`${label}-rejected`, {message: error instanceof Error ? error.message : String(error)});
    }
  };

  await expectRejected('setup', ctx.agents.create({
    sessionId: 'probe-setup-fail',
    setup() { trace('setup-called'); throw new Error('setup-failure'); },
  }));
  trace('setup-absent', {absent: ctx.agents.get('probe-setup-fail') === undefined});

  await expectRejected('commit', ctx.agents.create({
    sessionId: 'probe-commit-fail',
    setup() {
      trace('commit-setup-called');
      return {commit() { trace('commit-called'); throw new Error('commit-failure'); }};
    },
  }));
  trace('commit-absent', {absent: ctx.agents.get('probe-commit-fail') === undefined});

  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const fork = ctx.plugin({
    name: 'probe-owner',
    inject: ['agents'],
    apply(ownerCtx) {
      ownerCtx.agents.create({
        sessionId: 'probe-owner-unload',
        setup: async () => {
          trace('owner-setup-started');
          started();
          await delay(500);
          trace('owner-setup-finished');
        },
      }).then(
        () => trace('owner-unexpected'),
        error => trace('owner-rejected', {message: error instanceof Error ? error.message : String(error)}),
      );
    },
  });
  await startedPromise;
  await fork.dispose();
  trace('owner-disposed');
  await delay(300);
  trace('owner-absent', {absent: ctx.agents.get('probe-owner-unload') === undefined});
}
