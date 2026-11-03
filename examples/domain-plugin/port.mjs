import {serviceContract} from '@mote/plugin-sdk';

/** Typed port for the collection domain. Both the contributing entry and any
 * consumer acquire through this contract; the service id matches the manifest
 * `provides` declaration. */
export const COLLECTION_PORT_ID = 'template.collection.log';
export const collectionPort = serviceContract(COLLECTION_PORT_ID, '1');
