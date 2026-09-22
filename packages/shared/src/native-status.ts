/** Local observations are not evidence that central OCR, analysis or Memory ran. */
export type NativeSyncState='unconfigured'|'idle'|'waiting'|'uploading'|'paused'|'blocked'|'error';
export type NativeErrorCode='connection_required'|'permission_required'|'retained_conflict'|'source_unavailable'|'transport_error'|'local_state_unavailable';
export type NativeStatusAction='configure_connection'|'grant_permission'|'resume_sync'|'retry_sync'|'open_processing';
export type NativeStatusFacts={
  pending:number|null; lastAcknowledgedAt?:string|null; archiveAcknowledged?:boolean;
  syncState:NativeSyncState; errorCode?:NativeErrorCode|null; retryAt?:string|null;
  /** The server owns processing state/actions; a successful upload never fills this field. */
  processing?:{state:string;allowedActions:string[];errorCode?:string|null;retryAt?:string|null}|null;
  scanComplete?:boolean|null; knownItems?:number|null; skipped?:number|null;
};
export type NativeStatusView={
  archive:{state:'unknown'|'local'|'partial'|'acknowledged';pending:number|null;lastAcknowledgedAt:string|null};
  processing:{state:string;allowedActions:string[];errorCode:string|null;retryAt:string|null};
  sync:{state:NativeSyncState;errorCode:NativeErrorCode|null;retryAt:string|null;allowedActions:NativeStatusAction[]};
  coverage:{state:'unknown'|'partial'|'scanned';knownItems:number|null;skipped:number|null};
};
export function nativeStatusView(facts:NativeStatusFacts):NativeStatusView{
  const count=(n:number|null|undefined)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;
  const pending=count(facts.pending),ack=facts.lastAcknowledgedAt||null,acknowledged=facts.archiveAcknowledged===true||Boolean(ack);
  const errorCode=facts.errorCode??(facts.syncState==='unconfigured'?'connection_required':facts.syncState==='error'?'transport_error':null);
  const allowedActions:NativeStatusAction[]=facts.syncState==='unconfigured'?['configure_connection']:
    errorCode==='permission_required'?['grant_permission']:
    facts.syncState==='paused'?['resume_sync']:
    facts.syncState==='uploading'?[]:['retry_sync'];
  if(facts.syncState!=='unconfigured'&&ack)allowedActions.push('open_processing');
  return {
    archive:{state:pending===null?'unknown':pending>0?(acknowledged?'partial':'local'):acknowledged?'acknowledged':'unknown',pending,lastAcknowledgedAt:ack},
    processing:{state:facts.processing?.state??'unknown',allowedActions:[...(facts.processing?.allowedActions??[])],errorCode:facts.processing?.errorCode??null,retryAt:facts.processing?.retryAt??null},
    sync:{state:facts.syncState,errorCode,retryAt:facts.retryAt??null,allowedActions},
    coverage:{state:facts.scanComplete==null?'unknown':facts.scanComplete?'scanned':'partial',knownItems:count(facts.knownItems),skipped:count(facts.skipped)},
  };
}
