import type {Context} from '@deepseek-ai/cordis';
import * as sdk from '@deepseek-ai/dsh-sdk-jsonrpc-server';

export const name = 'mote-dsh-application-sdk';
export const inject = [...sdk.inject, 'sessionPersistence'];
export const Config = sdk.Config;

/** Keep the released SDK wire and original Factory. Only the SDK consumer's
 * creation call becomes create-or-resume; native registry callers keep their
 * existing creation semantics and original Context/Factory receivers. */
export function apply(context: Context, config: Parameters<typeof sdk.apply>[1]) {
  const registry = context.agents;
  const create = async (options: Parameters<typeof registry.create>[0]) => {
    const persistence = context.get('sessionPersistence');
    if (!persistence) throw new Error('Native application session persistence is unavailable');
    const stored = await persistence.stat(options.sessionId, {signal: options.signal});
    return stored ? registry.resume({resumeSessionId: options.sessionId, parentAgent: options.parentAgent, agentOptions: options.agentOptions, signal: options.signal, setup: options.setup}) : registry.create(options);
  };
  const agents = new Proxy(registry, {get(target, key) {
    if (key === 'create') return create;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const scoped = new Proxy(context, {get(target, key) {
    if (key === 'agents') return agents;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  return sdk.apply(scoped, config);
}
