import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {trace} from './trace.mjs';

const marker = 'factory-b';

export const name = 'dsh-native-factory-b';
export const inject = ['agents', 'sessions', 'sessionProjections', 'systemPrompt', 'tools', 'llm', 'sessionPersistence'];

/** Runtime B's factory: the same public contract, a different instance/version. */
export function apply(ctx) {
  class ProbeLoop extends AgentLoop {
    async createAgent(ownerCtx, options) {
      trace(`${marker}-create`, {sessionId: options.sessionId});
      return super.createAgent(ownerCtx, options);
    }
    async resume(ownerCtx, options) {
      trace(`${marker}-resume`, {sessionId: options.resumeSessionId});
      return super.resume(ownerCtx, options);
    }
  }
  new ProbeLoop(ctx, {agents: [], maxParallelToolCalls: {get: () => 10}});
  ctx.effect(() => () => trace(`${marker}-disposed`), `${marker}.dispose`);
  try {
    ctx.agents.setFactory({
      async createAgent() { throw new Error('duplicate factory must not run'); },
      async resume() { throw new Error('duplicate factory must not run'); },
    });
    trace(`${marker}-duplicate-unexpected`);
  } catch (error) {
    trace(`${marker}-duplicate-rejected`, {message: error instanceof Error ? error.message : String(error)});
  }
}
