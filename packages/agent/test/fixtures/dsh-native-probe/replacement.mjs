import {NativeDshGenerationRegistry} from '../../../dist/runtime/dsh/native-lifecycle.js';
import * as nativePackage from './index.mjs';
import * as factoryA from './factory-a.mjs';
import * as factoryB from './factory-b.mjs';
import {trace} from './trace.mjs';

export const name = 'dsh-native-replacement-control';
export const inject = ['tools', 'agents'];

/** Loads one complete generation. Factory changes are restart-only; the running
 * generation remains authoritative until a fresh DSH process starts. */
export async function apply(ctx) {
  const mode = process.env.PROBE_REPLACEMENT;
  const registry = new NativeDshGenerationRegistry(ctx);
  ctx.effect(() => () => registry.close());
  const generation = (factory, version) => ({
    packages: [
      {id: 'native-package', version: '1', plugin: nativePackage},
      {id: 'factory-package', version, plugin: factory, descriptor: {id: 'factory', version, replacement: 'restart'}},
    ],
  });
  if (mode === 'attempt-b') {
    const initial = await registry.replace(generation(factoryA, 'a'));
    trace('replacement-initial', {state: initial.state, generation: initial.generation});
    const attempted = await registry.replace(generation(factoryB, 'b'));
    trace('replacement-attempt', {state: attempted.state, restartRequired: attempted.restartRequired});
    return;
  }
  const initial = await registry.replace(generation(mode === 'b' ? factoryB : factoryA, mode === 'b' ? 'b' : 'a'));
  trace('replacement-initial', {state: initial.state, generation: initial.generation});
}
