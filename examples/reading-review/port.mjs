/** The reading review domain's own public service port.
 *
 * Only the public SDK is imported: the contract identity is authored by the
 * package and consumed by any host or sibling plugin through the same SDK. */
import {serviceContract} from '@mote/plugin-sdk';

export const READING_REVIEW_PORT_ID = 'example.reading-review.plan';

/** @typedef {{state:()=>Promise<unknown>, selectStrategy:(strategy:string)=>Promise<unknown>, addCard:(input:unknown)=>Promise<unknown>, review:(input:unknown)=>Promise<unknown>, summary:()=>unknown}} ReadingReviewPort */

export const readingReviewPort = serviceContract(READING_REVIEW_PORT_ID, '1');
