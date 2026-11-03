import {loadNativeDshGeneration} from '../../../dist/runtime/dsh/native-lifecycle.js';
import * as nativePackage from './index.mjs';
import {trace} from './trace.mjs';

export const name = 'dsh-native-lifecycle-generation';
export const inject = ['tools'];

export async function apply(ctx) {
  return loadNativeDshGeneration(ctx, {
    packages: [{id: 'native-package', plugin: nativePackage}],
    hooks: [{event: 'agr01/control-probe', listener: () => trace('lifecycle-hook')}],
  });
}
