/** Repository-external reading review domain.
 *
 * The domain owns only its plan and scheduling rules. It receives the
 * host-bound `ctx.state` store and never reads a database, a profile path or an
 * owner token. The same service is used by the publishable host port and by the
 * deployment connector adapter so both expose one scheduling implementation. */

export const STATE_KEY = 'review-plan';
const STATE_VERSION = 1;
const DAY_MS = 86_400_000;
const MAX_CARDS = 30;
const MAX_ROUNDS = 40;
const MAX_TEXT = 512;

export const readingReviewRatings = Object.freeze(['again', 'hard', 'good', 'easy']);

export const readingReviewStrategies = Object.freeze({
  spaced: Object.freeze({
    id: 'spaced', label: 'Spaced', description: 'Expand the interval after each successful review.',
    ratings: Object.freeze({
      again: Object.freeze({first: 0, factor: 1}),
      hard: Object.freeze({first: 1, factor: 1.6}),
      good: Object.freeze({first: 3, factor: 2.2}),
      easy: Object.freeze({first: 7, factor: 3}),
    }),
  }),
  daily: Object.freeze({
    id: 'daily', label: 'Daily', description: 'Keep successful cards on a steady one-day cadence.',
    ratings: Object.freeze({
      again: Object.freeze({first: 0, factor: 1}),
      hard: Object.freeze({first: 1, factor: 1}),
      good: Object.freeze({first: 1, factor: 1}),
      easy: Object.freeze({first: 2, factor: 1.5}),
    }),
  }),
  intensive: Object.freeze({
    id: 'intensive', label: 'Intensive', description: 'Repeat weak cards the same day and grow slowly.',
    ratings: Object.freeze({
      again: Object.freeze({first: 0, factor: 1}),
      hard: Object.freeze({first: 0, factor: 1}),
      good: Object.freeze({first: 1, factor: 1.5}),
      easy: Object.freeze({first: 2, factor: 2}),
    }),
  }),
});

/** Dispatcher-compatible failure: the host maps `ConnectorError` without
 * exposing internal messages or stack traces to the owner. */
export class ReadingReviewError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, statusCode = 400) => { throw new ReadingReviewError(code, statusCode); };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);

function text(value, field, maximum = MAX_TEXT) {
  if (typeof value !== 'string') fail('reading_review_input_invalid');
  const result = value.trim();
  if (!result || result.length > maximum) fail('reading_review_input_invalid');
  return result;
}

function iso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('reading_review_state_invalid', 500);
  return new Date(value).toISOString();
}

function strategyId(value) {
  if (typeof value !== 'string' || !Object.hasOwn(readingReviewStrategies, value))
    fail('reading_review_strategy_invalid');
  return value;
}

function rating(value) {
  if (!readingReviewRatings.includes(value)) fail('reading_review_rating_invalid');
  return value;
}

function emptyPlan() {
  return {version: STATE_VERSION, strategy: null, cards: [], rounds: []};
}

/** Strict enough to fail closed on malformed host state, while preserving every
 * field this domain wrote. A plugin never stores host snapshots or credentials
 * here, so the value is only plan metadata. */
export function normalizeReadingReviewPlan(value) {
  if (!isObject(value) || value.version !== STATE_VERSION || !Array.isArray(value.cards) || !Array.isArray(value.rounds))
    fail('reading_review_state_invalid', 500);
  const strategy = value.strategy === null ? null : strategyId(value.strategy);
  if (value.cards.length > MAX_CARDS || value.rounds.length > MAX_ROUNDS) fail('reading_review_state_invalid', 500);
  const cards = value.cards.map(card => {
    if (!isObject(card)) fail('reading_review_state_invalid', 500);
    const intervalDays = card.intervalDays;
    const reviewCount = card.reviewCount;
    if (!Number.isSafeInteger(intervalDays) || intervalDays < 0 || intervalDays > 365
      || !Number.isSafeInteger(reviewCount) || reviewCount < 0)
      fail('reading_review_state_invalid', 500);
    return {
      id: text(card.id, 'id', 128),
      prompt: text(card.prompt, 'prompt'),
      answer: text(card.answer, 'answer'),
      createdAt: iso(card.createdAt, 'createdAt'),
      dueAt: iso(card.dueAt, 'dueAt'),
      intervalDays,
      reviewCount,
      lastReviewedAt: card.lastReviewedAt === null ? null : iso(card.lastReviewedAt, 'lastReviewedAt'),
      lastRating: card.lastRating === null ? null : rating(card.lastRating),
    };
  });
  if (new Set(cards.map(card => card.id)).size !== cards.length) fail('reading_review_state_invalid', 500);
  const rounds = value.rounds.map(round => {
    if (!isObject(round)) fail('reading_review_state_invalid', 500);
    const intervalDays = round.intervalDays;
    if (!Number.isSafeInteger(intervalDays) || intervalDays < 0 || intervalDays > 365)
      fail('reading_review_state_invalid', 500);
    return {
      id: text(round.id, 'id', 128),
      cardId: text(round.cardId, 'cardId', 128),
      strategy: strategyId(round.strategy),
      rating: rating(round.rating),
      reviewedAt: iso(round.reviewedAt, 'reviewedAt'),
      dueAtBefore: iso(round.dueAtBefore, 'dueAtBefore'),
      dueAtAfter: iso(round.dueAtAfter, 'dueAtAfter'),
      intervalDays,
    };
  });
  return {version: STATE_VERSION, strategy, cards, rounds};
}

function nextInterval(strategy, cardInterval, value) {
  const rule = readingReviewStrategies[strategy].ratings[value];
  if (value === 'again') return 0;
  if (!cardInterval) return rule.first;
  return Math.min(365, Math.max(rule.first, Math.round(cardInterval * rule.factor)));
}

function publicStrategies() {
  return Object.values(readingReviewStrategies).map(({id, label, description}) => ({id, label, description}));
}

/** One instance-scoped controller. Writes are serialized per service and use
 * the StateStore revision for compare-and-set, so two activations cannot
 * silently overwrite each other. */
export function createReadingReviewService({state, clock = () => new Date(), limit = {maxCards: MAX_CARDS, maxRounds: MAX_ROUNDS}} = {}) {
  if (!state || typeof state.get !== 'function' || typeof state.compareAndSet !== 'function')
    fail('reading_review_state_unavailable', 503);

  let plan = emptyPlan();
  let revision = 0;
  let loaded;
  let queue = Promise.resolve();
  let quiesced = false;
  let closed = false;

  const now = () => {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) fail('reading_review_clock_invalid', 500);
    return date;
  };

  const assertOpen = () => {
    if (closed) fail('reading_review_closed', 409);
    if (quiesced) fail('reading_review_quiesced', 409);
  };

  async function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const current = await state.get(STATE_KEY);
      if (current) {
        plan = normalizeReadingReviewPlan(current.value);
        revision = current.revision;
        return;
      }
      const initial = emptyPlan();
      try {
        const record = await state.compareAndSet(STATE_KEY, null, initial);
        plan = initial;
        revision = record.revision;
      } catch (error) {
        // Another activation created the plan between get and create. Read the
        // committed value instead of replacing it.
        if (error?.code !== 'conflict') throw error;
        const created = await state.get(STATE_KEY);
        if (!created) throw error;
        plan = normalizeReadingReviewPlan(created.value);
        revision = created.revision;
      }
    })().catch(error => { loaded = undefined; throw error; });
    return loaded;
  }

  function view() {
    const current = now();
    const due = plan.cards.filter(card => Date.parse(card.dueAt) <= current.getTime());
    const next = [...plan.cards].sort((left, right) => left.dueAt.localeCompare(right.dueAt))[0];
    return {
      version: STATE_VERSION,
      stateRevision: revision,
      observedAt: current.toISOString(),
      strategy: plan.strategy,
      strategies: publicStrategies(),
      ratings: [...readingReviewRatings],
      cards: clone(plan.cards),
      rounds: clone(plan.rounds.slice(-20)),
      historyCount: plan.rounds.length,
      dueCardIds: due.map(card => card.id),
      nextDueAt: next?.dueAt ?? null,
    };
  }

  function summary() {
    const current = now();
    return {
      ready: Boolean(loaded),
      stateRevision: revision,
      strategy: plan.strategy,
      cards: plan.cards.length,
      reviews: plan.rounds.length,
      due: plan.cards.filter(card => Date.parse(card.dueAt) <= current.getTime()).length,
    };
  }

  function mutate(recipe) {
    assertOpen();
    const run = queue.then(async () => {
      assertOpen();
      await load();
      const currentTime = now();
      // Read immediately before the write so an external activation's
      // committed revision is never overwritten by a stale local cache. One
      // retry re-runs the pure recipe after a concurrent compare-and-set.
      for (let attempt = 0; ; attempt++) {
        const current = await state.get(STATE_KEY);
        if (!current) fail('reading_review_state_missing', 500);
        const next = recipe(normalizeReadingReviewPlan(current.value), currentTime);
        let record;
        try {
          record = await state.compareAndSet(STATE_KEY, current.revision, next);
        } catch (error) {
          if (error?.code === 'conflict' && attempt === 0) continue;
          throw error;
        }
        plan = next;
        revision = record.revision;
        return view();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  const port = Object.freeze({
    state: () => service.state(),
    selectStrategy: value => service.selectStrategy(value),
    addCard: input => service.addCard(input),
    review: input => service.review(input),
    summary: () => service.summary(),
  });

  const service = Object.freeze({
    STATE_KEY,
    port,
    load,
    async state() {
      await load();
      return view();
    },
    summary,
    async selectStrategy(value) {
      const selected = strategyId(value);
      return mutate(current => {
        current.strategy = selected;
        return current;
      });
    },
    async addCard(input) {
      if (!isObject(input)) fail('reading_review_input_invalid');
      const prompt = text(input.prompt, 'prompt');
      const answer = text(input.answer, 'answer');
      const id = input.id === undefined ? globalThis.crypto.randomUUID() : text(input.id, 'id', 128);
      return mutate((current, currentTime) => {
        if (current.cards.length >= limit.maxCards) fail('reading_review_limit_reached', 409);
        if (current.cards.some(card => card.id === id)) fail('reading_review_card_exists', 409);
        current.cards.push({
          id, prompt, answer, createdAt: currentTime.toISOString(), dueAt: currentTime.toISOString(),
          intervalDays: 0, reviewCount: 0, lastReviewedAt: null, lastRating: null,
        });
        return current;
      });
    },
    async review(input) {
      if (!isObject(input)) fail('reading_review_input_invalid');
      const cardId = text(input.cardId, 'cardId', 128);
      const selectedRating = rating(input.rating);
      return mutate((current, currentTime) => {
        if (!current.strategy) fail('reading_review_strategy_required', 409);
        const card = current.cards.find(candidate => candidate.id === cardId);
        if (!card) fail('reading_review_card_missing', 404);
        const intervalDays = nextInterval(current.strategy, card.intervalDays, selectedRating);
        const dueAtBefore = card.dueAt;
        const dueAtAfter = new Date(currentTime.getTime() + intervalDays * DAY_MS).toISOString();
        card.intervalDays = intervalDays;
        card.dueAt = dueAtAfter;
        card.reviewCount += 1;
        card.lastReviewedAt = currentTime.toISOString();
        card.lastRating = selectedRating;
        current.rounds.push({
          id: globalThis.crypto.randomUUID(),
          cardId,
          strategy: current.strategy,
          rating: selectedRating,
          reviewedAt: currentTime.toISOString(),
          dueAtBefore,
          dueAtAfter,
          intervalDays,
        });
        current.rounds.splice(0, Math.max(0, current.rounds.length - limit.maxRounds));
        return current;
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
