import type {Api} from '../../api';
import {resources} from '../../resource-cache';

/** A correction or forget receipt retires cached derived bodies immediately,
 * including unmounted people/topic pages and pending pre-mutation reads. */
export function refreshMemoryResources(api:Api,retire=false){
  resources(api).invalidate(key=>/^\/api\/(memories|memory-jobs|context-trees|assistant\/commitments)([/?]|$)/.test(key),retire);
}
