import {funasrIdentitySchema,FUNASR_PROTOCOL} from './funasr-contract.js';
import {LOCAL_IMAGE_PROTOCOL,localImageSuccessSchema} from './local-image-contract.js';
import type {MediaRole} from '@mote/shared';

/** Managed workers are deployment resources. These values are a startup snapshot;
 * changing them requires restarting the node and its managed workers. */
export interface MediaRuntimeSettings {
  ocrEndpoint: string;
  asrEndpoint: string;
  workerToken: string;
  localImageEndpoint?: string;
}
export interface MediaConfiguration extends MediaRuntimeSettings {
  modelDirectory: string;
  python: string;
  ocrPort: number;
  asrPort: number;
  localImagePort?: number;
}
export const DEFAULT_MEDIA_OCR_ENDPOINT = 'http://127.0.0.1:9010/ocr';
export const DEFAULT_MEDIA_ASR_ENDPOINT = 'http://127.0.0.1:9009/transcribe';
export const DEFAULT_MEDIA_LOCAL_IMAGE_ENDPOINT = 'http://127.0.0.1:9011/v1/interpret';
export function mediaRuntimeSettings(value?: Partial<MediaRuntimeSettings>): MediaRuntimeSettings {
  return {ocrEndpoint: DEFAULT_MEDIA_OCR_ENDPOINT, asrEndpoint: DEFAULT_MEDIA_ASR_ENDPOINT, workerToken: '', ...value};
}

export function mediaRoleEndpoint(role:MediaRole,media:MediaRuntimeSettings){
  return role==='ocr'?media.ocrEndpoint:role==='local-image'?media.localImageEndpoint??DEFAULT_MEDIA_LOCAL_IMAGE_ENDPOINT:media.asrEndpoint;
}

/** Model health, distinct from Compose's listener probe. New worker producers
 * must report their loaded domain identity, not the old ASR directory booleans.
 * These are consumer requirements; model/worker acceptance remains separate. */
export function mediaModelHealth(role:MediaRole,raw:unknown):{ready:boolean;error?:string;missingDependencies?:string[]}{
  if(!raw||typeof raw!=='object')return {ready:false};
  const value=raw as Record<string,unknown>;
  // Only the current audio worker can describe this installation's runtime
  // dependencies. A retired worker's diagnostics do not belong to FunASR.
  if(role==='dialogue'&&value.protocol!==FUNASR_PROTOCOL)return {ready:false,missingDependencies:[]};
  const missing=Array.isArray(value.missingDependencies)&&value.missingDependencies.length<=32&&value.missingDependencies.every(name=>typeof name==='string'&&/^[a-zA-Z0-9._-]{1,100}$/.test(name))?value.missingDependencies as string[]:undefined;
  if(value.missingDependencies!==undefined&&!missing)return {ready:false,error:'worker_health_invalid'};
  const diagnostic={...(missing?{missingDependencies:missing}:{}),...(value.loadError===true?{error:'model_load_failed'}:{})};
  if(value.execution!=='local'||diagnostic.error||missing?.length)return {ready:false,...diagnostic};
  if(role==='ocr')return {ready:value.version===1&&value.ocr===true,...diagnostic};
  if(role==='dialogue'){
    const identity=funasrIdentitySchema.safeParse(value.identity);
    const backend=identity.success&&((process.platform==='darwin'&&process.arch==='arm64')?['mps','cpu']:['cpu']).includes(identity.data.backend);
    return {ready:value.protocol===FUNASR_PROTOCOL&&value.asr===true&&value.diarization===true&&identity.success&&Boolean(backend),...diagnostic};
  }
  if(role==='local-image')return {ready:process.platform==='darwin'&&process.arch==='arm64'&&value.version===LOCAL_IMAGE_PROTOCOL.version&&value.localImage===true&&localImageSuccessSchema.shape.model.safeParse(value.model).success,...diagnostic};
  return {ready:false,...diagnostic};
}
