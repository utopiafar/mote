import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {trace} from './trace.mjs';

const marker = 'factory-a';

export const name = 'dsh-native-factory-a';
export const inject = ['agents', 'sessions', 'sessionProjections', 'systemPrompt', 'tools', 'llm', 'sessionPersistence'];

/** A real public-API AgentFactory for runtime A. It delegates driving to the
 * exported AgentLoop and marks the factory instance that actually served create/resume. */
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
