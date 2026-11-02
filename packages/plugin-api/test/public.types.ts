import {
  serviceContract, type ServiceContract, type ServiceResolver, type PluginFactory,
  type PluginSnapshot, type PluginFailure, type Cancellation,
} from '../src/index.js';

// Port shapes reflect actual baseline boundaries. They are type examples, not implemented consumers/T3.
interface OriginalReadPort { read(ref: string, signal: AbortSignal): Promise<{id: string; text: string}> }
interface MutableStorePort { delete(id: string): Promise<void> }
const original = serviceContract<OriginalReadPort>('mote.evidence.original', '1');
declare const mutable: ServiceContract<MutableStorePort>;
// @ts-expect-error A write-capable internal implementation cannot satisfy the declared read service.
const wrongContract: ServiceContract<OriginalReadPort> = mutable;
void wrongContract;

declare const resolver: ServiceResolver;
declare const binding: Parameters<typeof resolver.acquire>[1];
async function readExample(signal: AbortSignal) {
  const lease = await resolver.acquire(original, binding, signal);
  try {
    lease.assertCurrent();
    return await lease.value.read('exact-original-ref', signal);
  } finally { await lease.release(); }
}
void readExample;

const factory: PluginFactory = context => {
  context.scope.defer(async () => {});
  return {prepare() {}, start() {}, quiesce() {}, stop() {}, dispose() {}};
};
void factory;
declare const dto: PluginSnapshot;
// @ts-expect-error Node/local service values are absent from the wire snapshot.
dto.contributions[0]!.value;
const error: PluginFailure = {code: 'result_unknown', operationId: 'operation-1'};
const cancellation: Cancellation = {kind: 'revoked'};
void [error, cancellation];
