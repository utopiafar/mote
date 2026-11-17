import type {CaptureInput} from '@mote/shared';
import {StoreError} from './evidence-store.js';
import type {FileStore} from './files.js';
import type {ConnectionCredential} from './connections.js';
/** Correction provenance is minted only by the owner's reviewed Memory service. */
export function assertExternalCaptures(inputs:CaptureInput[],owner=false){
 for(const input of inputs){
  if(input.metadata?.memoryCorrection)throw new StoreError('Memory correction provenance is reserved for the host review service',400);
  if(input.metadata?.ownerDescription!==undefined&&!owner)throw new StoreError('Only the owner may declare record context',403);
 }
}

/** Reference declarations never authorize a device to attach another device's bytes. */
export function assertCaptureAttachments(inputs:CaptureInput[],files:FileStore,credential?:ConnectionCredential){
 for(const input of inputs)for(const id of input.metadata?.attachments??[]){
  const attachment=files.detail(id);
  if(credential?.scope==='collector'&&files.sources.getSource(attachment.sourceId).deviceId!==credential.deviceId)throw new StoreError('Attachment belongs to another device',403);
 }
}
