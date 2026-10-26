import type {ModelConnection} from './background-model-authorization.js';

/** Only the host issues this authority. Stage names and record IDs describe
 * work; neither a processor nor a public request can turn them into a grant. */
export type ModelProcessingRequest={
 operationId:string;captureId:string;ownerIntentId?:string;
 stage:'asr'|'ocr'|'diarization'|'file-summary'|'semantic-turns'|'image-understanding';
 dataKind:'text'|'image'|'audio';connection?:ModelConnection;
};
export type ModelProcessingAuthority={
 <T>(request:ModelProcessingRequest,signal:AbortSignal,task:(signal:AbortSignal,assertCurrent:()=>void)=>Promise<T>):Promise<T>;
 /** Called only at a host-controlled explicit retry/backfill boundary. The
  * returned ID is persisted, then revalidated by the host on every execution. */
 ownerIntent?:(captureId:string)=>string|undefined;
};
