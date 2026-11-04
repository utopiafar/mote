/** The public port identities used by this second-level package.
 *
 * The consumed contract is authored by `examples/reading-review`; this package
 * repeats only its published identity and the documented call shape. It never
 * imports the reading review domain, source adapter, test fixtures or Web page.
 * Any host that offers `example.reading-review.plan@1` is interchangeable. */
import {serviceContract} from '@mote/plugin-sdk';

export const READING_PLAN_PORT_ID = 'example.reading-review.plan';
export const READING_PLAN_API_VERSION = '1';
export const READING_EXPORT_PORT_ID = 'example.reading-export.materials';
export const READING_EXPORT_API_VERSION = '1';

/** The reading review view this package copies:
 * `{version, stateRevision, observedAt, strategy, strategies, ratings, cards,
 * rounds, historyCount, dueCardIds, nextDueAt}`. It only calls `state()`. */
export const readingPlanPort = serviceContract(READING_PLAN_PORT_ID, READING_PLAN_API_VERSION);

/** Generic exported materials remain readable without the reading review
 * package. The published methods are `list`, `read`, `exportNow` and
 * `summary`. */
export const readingExportPort = serviceContract(READING_EXPORT_PORT_ID, READING_EXPORT_API_VERSION);
