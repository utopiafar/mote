import {defineTool} from '@deepseek-ai/dsh-tools';
import {trace} from './trace.mjs';

export const name = 'dsh-native-probe';
export const inject = ['tools'];

/** A non-Mote native package: one tool, one request hook, one turn-stopping hook. */
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'probe_echo',
    description: 'Echo one value through the native DSH probe.',
    parameters: {
      value: {type: 'string', required: true},
    },
    output: {
      schema: {type: 'json'},
      render: (_args, value) => [{type: 'text', text: JSON.stringify(value)}],
    },
    async execute(args) {
      trace('native-tool', {value: args.value});
      return {echo: args.value, native: true};
    },
  }));

  ctx.on('agent/error', payload => {
    trace('agent-error', {
      message: payload.error instanceof Error ? payload.error.message : String(payload.error),
      stack: payload.error instanceof Error ? payload.error.stack : undefined,
      name: payload.error instanceof Error ? payload.error.name : undefined,
    });
  });

  ctx.on('agent/request', async (payload, next) => {
    const config = await next();
    const changed = {...config, temperature: 0.25, maxTokens: 321};
    trace('request-hook', {turn: payload.turn, step: payload.step, before: config, after: changed});
    return changed;
  });

  let steered = false;
  ctx.on('agent/turn-stopping', async payload => {
    trace('turn-stopping', {turn: payload.turn, steered});
    if (steered) return;
    steered = true;
    payload.agent.steer({
      id: `probe-steer-${Date.now()}`,
      role: 'user',
      content: [{type: 'text', text: 'probe continuation'}],
      source: {kind: 'user'},
    });
    trace('turn-stopping-steered');
  });
}
