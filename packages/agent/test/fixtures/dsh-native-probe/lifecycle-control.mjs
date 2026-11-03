import {trace} from './trace.mjs';

export const name = 'dsh-native-lifecycle-control';
export const inject = ['loader', 'tools'];

export async function apply(ctx) {
  const loader = ctx.fiber.entry.parent.tree;
  const entry = loader.resolve('agr01-generation');
  const fiber = entry.fiber;
  await fiber.await();
  trace('control-before', {tool: ctx.tools.get('probe_echo') !== undefined});
  ctx.emit('agr01/control-probe');
  loader.remove('agr01-generation');
  await fiber.await();
  trace('control-after', {tool: ctx.tools.get('probe_echo') !== undefined});
  ctx.emit('agr01/control-probe');
  trace('control-finished');
}
