/** Repository-external reading export domain.
 *
 * This package owns one archive of generic materials in the host-bound
 * `ctx.state`. It copies the public reading plan view verbatim: the selected
 * strategy, due dates and intervals are never recalculated here. When the
 * source port is missing or revoked, export stops and the archive stays
 * readable instead of silently choosing another algorithm.
 */
import {READING_EXPORT_PORT_ID, READING_EXPORT_API_VERSION, READING_PLAN_API_VERSION, READING_PLAN_PORT_ID} from './port.mjs';

export const STATE_KEY = 'reading-export-archive';
const STATE_VERSION = 1;
const MAX_EXPORTS = 20;
const MAX_CARDS = 100;
const MAX_ROUNDS = 40;
const MAX_TEXT = 512;
const MAX_ROUND_TEXT = 128;
const MAX_CONTENT = 200_000;

const sourceStatuses = ['unknown', 'ready', 'unavailable'];

export class ReadingExportError extends Error {
  constructor(code, statusCode = 400, options) {
    super(code, options);
    this.name = 'ReadingExportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, statusCode = 400, options) => { throw new ReadingExportError(code, statusCode, options); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

function boundedText(value, field, maximum = MAX_TEXT) {
  if (typeof value !== 'string') fail('reading_export_state_invalid', 500);
  const result = value.trim();
  if (!result || result.length > maximum) fail('reading_export_state_invalid', 500);
  return result;
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('reading_export_state_invalid', 500);
  return new Date(value).toISOString();
}

function integer(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) fail('reading_export_state_invalid', 500);
  return value;
}

function optionalIso(value, field) {
  return value === null ? null : iso(value, field);
}

function normalizeCard(value) {
  if (!isObject(value)) fail('reading_export_state_invalid', 500);
  const lastRating = value.lastRating;
  if (lastRating !== null && (typeof lastRating !== 'string' || lastRating.length > MAX_ROUND_TEXT))
    fail('reading_export_state_invalid', 500);
  return {
    id: boundedText(value.id, 'card.id', 128),
    prompt: boundedText(value.prompt, 'card.prompt'),
    answer: boundedText(value.answer, 'card.answer'),
    dueAt: iso(value.dueAt, 'card.dueAt'),
    intervalDays: integer(value.intervalDays, 'card.intervalDays', 365),
    reviewCount: integer(value.reviewCount, 'card.reviewCount'),
    lastReviewedAt: optionalIso(value.lastReviewedAt, 'card.lastReviewedAt'),
    lastRating,
  };
}

function normalizeCards(value) {
  if (!Array.isArray(value) || value.length > MAX_CARDS) fail('reading_export_state_invalid', 500);
  const cards = value.map(normalizeCard);
  if (new Set(cards.map(card => card.id)).size !== cards.length) fail('reading_export_state_invalid', 500);
  return cards;
}

function normalizeRound(value) {
  if (!isObject(value)) fail('reading_export_state_invalid', 500);
  return {
    id: boundedText(value.id, 'round.id', 128),
    cardId: boundedText(value.cardId, 'round.cardId', 128),
    strategy: boundedText(value.strategy, 'round.strategy', MAX_ROUND_TEXT),
    rating: boundedText(value.rating, 'round.rating', MAX_ROUND_TEXT),
    reviewedAt: iso(value.reviewedAt, 'round.reviewedAt'),
    dueAtBefore: iso(value.dueAtBefore, 'round.dueAtBefore'),
    dueAtAfter: iso(value.dueAtAfter, 'round.dueAtAfter'),
    intervalDays: integer(value.intervalDays, 'round.intervalDays', 365),
  };
}

function normalizeRounds(value) {
  if (!Array.isArray(value) || value.length > MAX_ROUNDS) fail('reading_export_state_invalid', 500);
  return value.map(normalizeRound);
}

function normalizeStrategy(value) {
  if (value === null) return null;
  if (!isObject(value)) fail('reading_export_state_invalid', 500);
  return {
    id: boundedText(value.id, 'strategy.id', 64),
    label: boundedText(value.label, 'strategy.label', 128),
    description: typeof value.description === 'string' && value.description.length <= MAX_TEXT
      ? value.description : fail('reading_export_state_invalid', 500),
  };
}

function normalizeMaterialSource(value) {
  if (!isObject(value)) fail('reading_export_state_invalid', 500);
  if (value.service !== READING_PLAN_PORT_ID || value.apiVersion !== READING_PLAN_API_VERSION)
    fail('reading_export_state_invalid', 500);
  return {
    service: READING_PLAN_PORT_ID,
    apiVersion: READING_PLAN_API_VERSION,
    stateRevision: integer(value.stateRevision, 'source.stateRevision'),
    observedAt: iso(value.observedAt, 'source.observedAt'),
    strategy: normalizeStrategy(value.strategy),
  };
}

function normalizeCoverage(value) {
  if (!isObject(value)) fail('reading_export_state_invalid', 500);
  return {
    cards: integer(value.cards, 'coverage.cards', MAX_CARDS),
    rounds: integer(value.rounds, 'coverage.rounds', MAX_ROUNDS),
    historyCount: integer(value.historyCount, 'coverage.historyCount'),
  };
}

function normalizeContent(value) {
  if (!isObject(value) || value.format !== 'markdown' || typeof value.text !== 'string'
    || !value.text || value.text.length > MAX_CONTENT || value.text.includes('\0'))
    fail('reading_export_state_invalid', 500);
  return {format: 'markdown', text: value.text};
}

function normalizeMaterial(value) {
  if (!isObject(value) || value.kind !== 'reading.export.material' || value.schemaVersion !== STATE_VERSION)
    fail('reading_export_state_invalid', 500);
  const fingerprint = value.fingerprint;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) fail('reading_export_state_invalid', 500);
  const cards = normalizeCards(value.cards);
  const dueCardIds = value.dueCardIds === undefined ? [] : value.dueCardIds;
  if (!Array.isArray(dueCardIds) || dueCardIds.some(entry => typeof entry !== 'string' || !cards.some(card => card.id === entry)))
    fail('reading_export_state_invalid', 500);
  return {
    id: boundedText(value.id, 'material.id', 128),
    kind: 'reading.export.material',
    schemaVersion: STATE_VERSION,
    title: boundedText(value.title, 'material.title', 256),
    publishedAt: iso(value.publishedAt, 'material.publishedAt'),
    source: normalizeMaterialSource(value.source),
    cards,
    rounds: normalizeRounds(value.rounds),
    coverage: normalizeCoverage(value.coverage),
    dueCardIds: [...new Set(dueCardIds)],
    nextDueAt: value.nextDueAt === undefined || value.nextDueAt === null ? null : iso(value.nextDueAt, 'material.nextDueAt'),
    content: normalizeContent(value.content),
    fingerprint,
  };
}

function normalizeSourceStatus(value) {
  if (!isObject(value) || !sourceStatuses.includes(value.state)) fail('reading_export_state_invalid', 500);
  return {
    state: value.state,
    reason: value.reason === null ? null : boundedText(value.reason, 'source.reason', 128),
    checkedAt: optionalIso(value.checkedAt, 'source.checkedAt'),
  };
}

function normalizeAttempt(value) {
  if (value === null) return null;
  if (!isObject(value) || !['ok', 'unavailable'].includes(value.status)) fail('reading_export_state_invalid', 500);
  return {
    at: iso(value.at, 'attempt.at'),
    status: value.status,
    code: value.code === null ? null : boundedText(value.code, 'attempt.code', 128),
  };
}

/** Strict enough to fail closed on malformed host state while preserving every
 * field this domain wrote. */
export function normalizeReadingExportArchive(value) {
  if (!isObject(value) || value.version !== STATE_VERSION || !Array.isArray(value.exports)
    || value.exports.length > MAX_EXPORTS) fail('reading_export_state_invalid', 500);
  const material = value.exports.map(normalizeMaterial);
  if (new Set(material.map(entry => entry.id)).size !== material.length) fail('reading_export_state_invalid', 500);
  return {
    version: STATE_VERSION,
    exports: material,
    source: normalizeSourceStatus(value.source),
    lastAttempt: normalizeAttempt(value.lastAttempt),
  };
}

function emptyArchive() {
  return {
    version: STATE_VERSION,
    exports: [],
    source: {state: 'unknown', reason: null, checkedAt: null},
    lastAttempt: null,
  };
}

function normalizeSourceStrategy(value) {
  if (value.strategy === null) return null;
  if (typeof value.strategy !== 'string') fail('reading_export_source_invalid', 502);
  const strategies = Array.isArray(value.strategies) ? value.strategies : [];
  const found = strategies.find(entry => isObject(entry) && entry.id === value.strategy);
  if (!found) fail('reading_export_source_invalid', 502);
  if (typeof found.label !== 'string' || !found.label.trim() || found.label.length > 128)
    fail('reading_export_source_invalid', 502);
  if (found.description !== undefined && (typeof found.description !== 'string' || found.description.length > MAX_TEXT))
    fail('reading_export_source_invalid', 502);
  return {
    id: value.strategy,
    label: found.label,
    description: found.description ?? '',
  };
}

function normalizeSourceView(value) {
  if (!isObject(value)) fail('reading_export_source_incompatible', 502);
  if (value.version !== 1) fail('reading_export_source_incompatible', 502);
  if (!Number.isSafeInteger(value.stateRevision) || value.stateRevision < 0) fail('reading_export_source_invalid', 502);
  if (typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt)))
    fail('reading_export_source_invalid', 502);
  if (!Array.isArray(value.cards) || value.cards.length > MAX_CARDS) fail('reading_export_source_invalid', 502);
  if (!Array.isArray(value.rounds)) fail('reading_export_source_invalid', 502);
  const strategy = normalizeSourceStrategy(value);
  let cards;
  let rounds;
  try {
    cards = value.cards.map(normalizeCard);
    rounds = value.rounds.slice(-MAX_ROUNDS).map(normalizeRound);
  } catch (error) {
    if (error instanceof ReadingExportError) fail('reading_export_source_invalid', 502);
    throw error;
  }
  if (new Set(cards.map(card => card.id)).size !== cards.length) fail('reading_export_source_invalid', 502);
  const dueCardIds = Array.isArray(value.dueCardIds)
    ? value.dueCardIds.filter(entry => typeof entry === 'string' && cards.some(card => card.id === entry))
    : [];
  return {
    stateRevision: value.stateRevision,
    observedAt: new Date(value.observedAt).toISOString(),
    strategy,
    cards,
    rounds,
    historyCount: Number.isSafeInteger(value.historyCount) && value.historyCount >= 0
      ? value.historyCount : value.rounds.length,
    dueCardIds,
    nextDueAt: typeof value.nextDueAt === 'string' && !Number.isNaN(Date.parse(value.nextDueAt))
      ? new Date(value.nextDueAt).toISOString() : null,
  };
}

function renderContent({title, source, cards, rounds, coverage}) {
  const due = new Set(source.dueCardIds);
  const lines = [
    `# ${title}`,
    '',
    source.strategy
      ? `Algorithm: ${source.strategy.label} (${source.strategy.id})`
      : 'Algorithm: not selected by the reading plan source',
    `Source state revision: ${source.stateRevision}`,
    `Source observed at: ${source.observedAt}`,
    `History rounds kept by the source: ${coverage.historyCount}`,
    '',
    '## Cards',
  ];
  if (!cards.length) lines.push('No cards were published by the source.');
  for (const card of cards) {
    lines.push(
      `- ${card.prompt}${due.has(card.id) ? ' [due]' : ''}`,
      `  Due: ${card.dueAt}; interval: ${card.intervalDays} day(s); reviews: ${card.reviewCount}`,
      `  Answer: ${card.answer}`,
    );
    if (card.lastRating !== null) lines.push(`  Last rating: ${card.lastRating}`);
  }
  lines.push('', '## Recent review rounds');
  if (!rounds.length) lines.push('No review rounds were published by the source.');
  for (const round of rounds) {
    lines.push(`- ${round.reviewedAt}: ${round.rating} on ${round.cardId}; strategy ${round.strategy}; next interval ${round.intervalDays} day(s)`);
  }
  lines.push('', 'This export copies the source plan. It does not schedule or recompute reviews.');
  return lines.join('\n');
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function createMaterial(value, publishedAt) {
  const sourceView = normalizeSourceView(value);
  const source = {
    service: READING_PLAN_PORT_ID,
    apiVersion: READING_PLAN_API_VERSION,
    stateRevision: sourceView.stateRevision,
    observedAt: sourceView.observedAt,
    strategy: sourceView.strategy,
  };
  const cards = sourceView.cards.map(card => ({
    id: card.id,
    prompt: card.prompt,
    answer: card.answer,
    dueAt: card.dueAt,
    intervalDays: card.intervalDays,
    reviewCount: card.reviewCount,
    lastReviewedAt: card.lastReviewedAt,
    lastRating: card.lastRating,
  }));
  const rounds = sourceView.rounds;
  const dueCardIds = sourceView.dueCardIds;
  const coverage = {cards: cards.length, rounds: rounds.length, historyCount: sourceView.historyCount};
  const title = source.strategy ? `Reading plan export: ${source.strategy.label}` : 'Reading plan export';
  const content = renderContent({
    title,
    source: {...source, dueCardIds},
    cards,
    rounds,
    coverage,
  });
  const fingerprint = await sha256(JSON.stringify({
    service: source.service,
    apiVersion: source.apiVersion,
    stateRevision: source.stateRevision,
    strategy: source.strategy,
    dueCardIds,
    nextDueAt: sourceView.nextDueAt,
    cards,
    rounds,
    coverage,
  }));
  return {
    id: `export_${globalThis.crypto.randomUUID()}`,
    kind: 'reading.export.material',
    schemaVersion: STATE_VERSION,
    title,
    publishedAt: publishedAt.toISOString(),
    source,
    cards,
    rounds,
    coverage,
    dueCardIds,
    nextDueAt: sourceView.nextDueAt,
    content: {format: 'markdown', text: content},
    fingerprint,
  };
}

function materialSummary(material) {
  return {
    id: material.id,
    title: material.title,
    publishedAt: material.publishedAt,
    source: clone(material.source),
    cards: material.cards.length,
    rounds: material.rounds.length,
    fingerprint: material.fingerprint,
  };
}

function unavailableArchive(current, at, reason, code) {
  if (current.source.state === 'unavailable' && current.source.reason === reason
    && current.lastAttempt?.code === code) return current;
  return {
    version: STATE_VERSION,
    exports: current.exports,
    source: {state: 'unavailable', reason, checkedAt: at.toISOString()},
    lastAttempt: {at: at.toISOString(), status: 'unavailable', code},
  };
}

/** One instance-scoped archive controller. Writes are serialized and use the
 * StateStore revision for compare-and-set. The archive never copies credentials
 * or a profile path. */
export function createReadingExportService({state, source = null, clock = () => new Date(), limit = {maxExports: MAX_EXPORTS}} = {}) {
  if (!state || typeof state.get !== 'function' || typeof state.compareAndSet !== 'function')
    fail('reading_export_state_unavailable', 503);
  const maxExports = Number.isSafeInteger(limit?.maxExports) && limit.maxExports > 0 ? limit.maxExports : MAX_EXPORTS;

  let archive = emptyArchive();
  let revision = 0;
  let loaded;
  let queue = Promise.resolve();
  let quiesced = false;
  let closed = false;

  const now = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) fail('reading_export_clock_invalid', 500);
    return date;
  };

  const assertOpen = () => {
    if (closed) fail('reading_export_closed', 409);
    if (quiesced) fail('reading_export_quiesced', 409);
  };

  async function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const current = await state.get(STATE_KEY);
      if (current) {
        archive = normalizeReadingExportArchive(current.value);
        revision = current.revision;
        return;
      }
      const initial = emptyArchive();
      try {
        const record = await state.compareAndSet(STATE_KEY, null, initial);
        archive = initial;
        revision = record.revision;
      } catch (error) {
        if (error?.code !== 'conflict') throw error;
        const created = await state.get(STATE_KEY);
        if (!created) throw error;
        archive = normalizeReadingExportArchive(created.value);
        revision = created.revision;
      }
    })().catch(error => { loaded = undefined; throw error; });
    return loaded;
  }

  function view() {
    return {
      version: STATE_VERSION,
      stateRevision: revision,
      observedAt: now().toISOString(),
      materials: archive.exports.map(materialSummary),
      source: clone(archive.source),
      lastAttempt: archive.lastAttempt === null ? null : clone(archive.lastAttempt),
      limit: maxExports,
    };
  }

  function summary() {
    const last = archive.exports.at(-1);
    return {
      ready: Boolean(loaded),
      stateRevision: revision,
      materials: archive.exports.length,
      lastExportAt: last?.publishedAt ?? null,
      lastStrategy: last?.source.strategy?.id ?? null,
      source: clone(archive.source),
      lastAttempt: archive.lastAttempt === null ? null : clone(archive.lastAttempt),
    };
  }

  async function write(recipe) {
    const at = now();
    for (let attempt = 0; ; attempt++) {
      const current = await state.get(STATE_KEY);
      if (!current) fail('reading_export_state_missing', 500);
      const before = normalizeReadingExportArchive(current.value);
      const next = await recipe(before, at);
      if (next === before) {
        archive = before;
        revision = current.revision;
        return {archive: before, revision: current.revision};
      }
      const canonical = normalizeReadingExportArchive(next);
      try {
        const record = await state.compareAndSet(STATE_KEY, current.revision, canonical);
        archive = canonical;
        revision = record.revision;
        return {archive: canonical, revision: record.revision};
      } catch (error) {
        if (error?.code === 'conflict' && attempt === 0) continue;
        throw error;
      }
    }
  }

  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  function exportNow() {
    return enqueue(async () => {
      assertOpen();
      await load();
      const at = now();
      if (!source) {
        const code = 'reading_export_source_unavailable';
        await write(current => unavailableArchive(current, at, 'dependency_missing', code));
        fail(code, 503);
      }
      let value;
      try {
        value = await source.state();
      } catch (error) {
        const code = 'reading_export_source_unavailable';
        await write(current => unavailableArchive(current, at, 'source_unavailable', code));
        fail(code, 503, {cause: error});
      }
      let material;
      try {
        material = await createMaterial(value, at);
      } catch (error) {
        if (error instanceof ReadingExportError) {
          await write(current => unavailableArchive(current, at, error.code === 'reading_export_source_incompatible'
            ? 'api_incompatible' : 'source_invalid', error.code));
        }
        throw error;
      }
      let exported = false;
      let selected;
      await write(current => {
        const latest = current.exports.at(-1);
        const unchanged = Boolean(latest && latest.fingerprint === material.fingerprint);
        selected = unchanged ? latest : material;
        exported = !unchanged;
        return {
          version: STATE_VERSION,
          exports: unchanged ? current.exports : [...current.exports, material].slice(-maxExports),
          source: {state: 'ready', reason: null, checkedAt: at.toISOString()},
          lastAttempt: {at: at.toISOString(), status: 'ok', code: null},
        };
      });
      return {
        ...view(),
        exported,
        materialId: selected.id,
        material: clone(selected),
      };
    });
  }

  async function tick() {
    if (!source) return {ok: false, exported: false, code: 'reading_export_source_unavailable'};
    try {
      const result = await exportNow();
      return {ok: true, exported: result.exported, materialId: result.materialId};
    } catch (error) {
      return {ok: false, exported: false, code: error?.code ?? 'reading_export_failed'};
    }
  }

  const port = Object.freeze({
    list: () => service.list(),
    read: id => service.read(id),
    exportNow: () => service.exportNow(),
    summary: () => service.summary(),
  });

  const service = Object.freeze({
    STATE_KEY,
    port,
    load,
    async list() {
      await load();
      return view();
    },
    async read(id) {
      await load();
      const material = archive.exports.find(entry => entry.id === boundedText(id, 'material.id', 128));
      if (!material) fail('reading_export_material_missing', 404);
      return clone(material);
    },
    exportNow,
    tick,
    summary,
    markSourceUnavailable(reason = 'dependency_missing') {
      if (closed) return Promise.resolve();
      return enqueue(async () => {
        await load();
        await write((current, at) => unavailableArchive(current, at, reason, 'reading_export_source_unavailable'));
      });
    },
    quiesce() { quiesced = true; },
    close() {
      quiesced = true;
      closed = true;
    },
  });
  return service;
}

export const readingExportLimits = Object.freeze({maxExports: MAX_EXPORTS, maxCards: MAX_CARDS, maxRounds: MAX_ROUNDS});
export {READING_EXPORT_PORT_ID, READING_EXPORT_API_VERSION, READING_PLAN_PORT_ID, READING_PLAN_API_VERSION};
