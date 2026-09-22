import type {CaptureInput} from '@mote/shared';
import {StoreError} from './store.js';
/** Correction provenance is minted only by the owner's reviewed Memory service. */
export function assertExternalCaptures(inputs:CaptureInput[]){
 for(const input of inputs)if(input.metadata?.memoryCorrection)throw new StoreError('Memory correction provenance is reserved for the host review service',400);
}
