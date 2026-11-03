import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';

/** Deep-runtime package entry for the current Central worker ABI.
 *
 * The installed payload directory carries no dependencies: this entry must
 * stay self-contained (Node builtins only). The host spawns it in the
 * plugin-worker process, calls `createMemoryProvider(configuration)` once,
 * then dispatches health/put/read/remove/search/export over JSON lines with a
 * per-call AbortSignal. Cancellation and process close are lifecycle
 * boundaries, not proof that a submitted remote mutation was rolled back.
 *
 * Persistence is deliberately boring: one provider-owned JSON file at the
 * instance-configured `dataFile` path. Records keep their immutable
 * namespace/key/body identity, writes and removals replay by exact opId
 * (receipts persist, so a retried operation returns the identical receipt
 * and durable deletion history survives restarts), and retrieval returns
 * scoped records filtered by `keys`/`limit`. `query` is an opaque retrieval
 * hint owned by the real provider's index — this template returns the scoped
 * set unchanged; never present that as semantic search. */
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const now = () => new Date().toISOString();

function providerError(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

export async function createMemoryProvider(configuration = {}) {
  const file = configuration.dataFile;
  if (typeof file !== 'string' || !file)
    throw providerError('invalid_configuration', 'The instance must configure a private provider dataFile');
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    state = {records: [], receipts: {}};
  }
  if (!state || !Array.isArray(state.records) || !state.receipts || typeof state.receipts !== 'object')
    throw providerError('invalid_record', 'The provider data file does not hold template state');
  let closed = false;
  const open = () => { if (closed) throw providerError('closed', 'The provider is closed'); };
  const save = async () => {
    await mkdir(dirname(file), {recursive: true, mode: 0o700});
    await writeFile(file, JSON.stringify(state), {mode: 0o600});
  };
  const exact = (record, input) => same(record.namespace, input.namespace) && same(record.key, input.key);
  const scoped = input => state.records.filter(record => same(record.namespace, input.namespace));
  const receipt = (input, status) => ({
    opId: input.opId,
    namespace: input.namespace,
    key: input.key,
    payloadDigest: hash({namespace: input.namespace, key: input.key, memory: input.memory}),
    state: status,
    eraseVerified: false,
    recordedAt: now(),
    ...(status === 'removed' ? {currentRemoved: true, historyRetained: true} : {}),
  });
  /** Exact opId replay: an identical retry returns the stored receipt; the
   * same id on different input is a conflict, never a second mutation. */
  const replay = input => {
    const fingerprint = hash(input);
    const prior = state.receipts[input.opId];
    if (!prior) return {fingerprint};
    if (prior.fingerprint !== fingerprint)
      throw providerError('conflict', 'The same operation id carries a different input');
    return {fingerprint, prior: prior.value};
  };
  const keep = (input, value) => {
    state.receipts[input.opId] = {fingerprint: hash(input), value};
  };

  return {
    async health() {
      open();
      return {
        providerId: 'template.local-memory',
        version: '0.1.0',
        ready: true,
        verified: {
          persistentCrud: true,
          scopedRetrieval: true,
          immutableRecords: true,
          idempotentReplay: true,
          history: true,
          physicalErase: false,
        },
        problems: [],
      };
    },
    async put(input) {
      open();
      const prior = replay(input);
      if (prior.prior) return prior.prior;
      const existing = state.records.find(record => exact(record, input));
      if (existing && !same(existing.memory, input.memory))
        throw providerError('conflict', 'The same exact key carries a different immutable body');
      if (!existing) state.records.push({namespace: input.namespace, key: input.key, memory: input.memory});
      const value = receipt(input, 'applied');
      keep(input, value);
      await save();
      return value;
    },
    async read(input) {
      open();
      return state.records.find(record => exact(record, input))?.memory ?? null;
    },
    async remove(input) {
      open();
      const prior = replay(input);
      if (prior.prior) return prior.prior;
      state.records = state.records.filter(record => !exact(record, input));
      const value = receipt(input, 'removed');
      keep(input, value);
      await save();
      return value;
    },
    async search(input) {
      open();
      const records = scoped(input)
        .filter(record => !input.keys || input.keys.some(key => same(key, record.key)));
      return records.slice(0, input.limit ?? records.length);
    },
    async export(input) {
      open();
      return scoped(input);
    },
    async close() {
      if (closed) return;
      closed = true;
      await save();
    },
  };
}

export default {createMemoryProvider};
