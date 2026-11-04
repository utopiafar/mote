/** Collection domain: an append-only list of short owner-authored items.
 *
 * Domain objects are constructed only by the plugin factory. All durable
 * state lives behind the host-injected StateStore (`ctx.state`) under one
 * private key; writes use compareAndSet so concurrent activations retry.
 * The service exposes a narrow `port` (the typed service surface other
 * contributions may acquire) plus explicit lifecycle methods. */
export const STATE_KEY = 'collection';
const STATE_VERSION = 1;
const MAX_ITEMS = 200;
const MAX_TEXT_CHARS = 1024;
const MAX_WRITE_ATTEMPTS = 3;

const clone = value => structuredClone(value);
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Dispatcher-mapped failure shape: `name` `ConnectorError`, `code`,
 * `statusCode`. The dynamic HTTP dispatcher resolves this shape without the
 * plugin importing host types. The domain reports the same honest failure —
 * never a silent success. */
function fail(code, statusCode = 400) {
  const error = new Error(code);
  error.name = 'ConnectorError';
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function itemText(value) {
  if (typeof value !== 'string') fail('invalid_item_text');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_TEXT_CHARS) fail('invalid_item_text');
  return trimmed;
}

function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('invalid_record');
  return value;
}

function emptyCollection() {
  return {version: STATE_VERSION, items: []};
}

export function normalizeCollection(value) {
  if (!isObject(value) || value.version !== STATE_VERSION || !Array.isArray(value.items)) fail('invalid_record');
  const items = value.items.map((item, index) => {
    if (!isObject(item)) fail('invalid_record');
    const id = typeof item.id === 'string' && item.id ? item.id : `item-${index + 1}`;
    return {id, text: itemText(item.text), addedAt: iso(item.addedAt)};
  });
  return {version: STATE_VERSION, items};
}

export function createCollectionService({state, clock = () => new Date().toISOString()}) {
  if (!state) throw Error('createCollectionService requires a host-injected state store');
  let current = emptyCollection();
  let quiesced = false;
  let closed = false;

  const readable = () => { if (closed) fail('collection_closed', 503); };
  const writable = () => {
    readable();
    if (quiesced) fail('collection_quiesced', 503);
  };

  async function load() {
    readable();
    const record = await state.get(STATE_KEY);
    current = normalizeCollection(record?.value ?? emptyCollection());
  }

  async function write(mutate) {
    writable();
    for (let attempt = 1; ; attempt += 1) {
      const record = await state.get(STATE_KEY);
      const base = normalizeCollection(record?.value ?? emptyCollection());
      try {
        const written = await state.compareAndSet(STATE_KEY, record?.revision ?? null, mutate(clone(base)));
        current = normalizeCollection(written.value);
        return clone(current);
      } catch (error) {
        if (error?.code !== 'conflict' || attempt === MAX_WRITE_ATTEMPTS) throw error;
      }
    }
  }

  const port = Object.freeze({
    state() { readable(); return clone(current); },
    summary() {
      readable();
      return {items: current.items.length, updatedAt: current.items.at(-1)?.addedAt ?? null};
    },
    async add(input) {
      const text = itemText(input?.text);
      await write(base => {
        if (base.items.length >= MAX_ITEMS) fail('collection_limit_reached', 409);
        base.items.push({id: `item-${base.items.length + 1}`, text, addedAt: clock()});
        return base;
      });
      return clone(current.items.at(-1));
    },
  });

  return Object.freeze({
    port,
    load,
    quiesce() { quiesced = true; },
    async close() { closed = true; },
  });
}
