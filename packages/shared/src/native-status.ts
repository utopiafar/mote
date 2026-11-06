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

/** One owner-facing state at a time. Level wins over table order; the fixed order below picks the first fact that applies. */
export type CaptureStatusLevel='normal'|'reminder'|'needs_action';
export type CaptureStatusId='capturing'|'pending_sync'|'screen_paused'|'paused'|'send_paused'|'local_only'|'reconnect'|'storage_full'|'interrupted'|'permission'|'send_attention'|'disconnected';
/** The operation names the destination; each client keeps its existing action labels. */
export type CaptureStatusOperation='resume_capture'|'resume_send'|'reconnect'|'restart_capture'|'open_permissions'|'open_storage'|'open_sync';
export type CaptureStatusPlatform='ios'|'android'|'macos';
export type CaptureStatusHome={titleKey:string;operation:CaptureStatusOperation};
export type CaptureStatusNotification={titleKey:string;operation:CaptureStatusOperation;platforms:readonly CaptureStatusPlatform[]};
/** Central text and badge tone; the device row itself opens the device detail. */
export type CaptureStatusCentral={textKey:string;tone:'ok'|'neutral'|'warn'};
export type CaptureStatusMacIcon='normal'|'paused'|'alert';
/** The five display columns from the state table plus the level. */
export type CaptureStatusRow={
  id:CaptureStatusId;level:CaptureStatusLevel;
  home:CaptureStatusHome|null;notification:CaptureStatusNotification|null;
  androidOngoing:string|null;macIcon:CaptureStatusMacIcon|null;
  central:CaptureStatusCentral|null;
};

/** Pure local and Central facts used to choose the row. Text stays as keys so every client translates it itself. */
export type CaptureStatusFacts={
  /** `reconnect` means a Central connection exists but its credential must be renewed. */
  connection:'connected'|'unconfigured'|'reconnect';
  captureEnabled:boolean;
  captureLive:boolean;
  /** An explicit temporary screen pause; absent when screen capture is on. */
  screenPausedAt?:string|null;
  /** All or some selected sources lack permission. */
  permission?:'missing'|'partial'|null;
  storageFull?:boolean;
  /** The capture service stopped while capture was enabled. */
  interrupted?:boolean;
  /** The same sync state reported to Central; `paused` is a paused send, `unconfigured` is local only. */
  syncState:NativeSyncState;
  pending?:number|null;
  /** Central-only observation: no contact within the device's reporting interval. */
  disconnected?:boolean;
};

const capturePlatforms:readonly CaptureStatusPlatform[]=['ios','android','macos'];
const captureMobileDesktop:readonly CaptureStatusPlatform[]=['android','macos'];
const captureHome=(titleKey:string,operation:CaptureStatusOperation):CaptureStatusHome=>({titleKey,operation});
const captureNotification=(titleKey:string,operation:CaptureStatusOperation,platforms:readonly CaptureStatusPlatform[]=capturePlatforms):CaptureStatusNotification=>({titleKey,operation,platforms:[...platforms]});

/** The only capture status table. `androidOngoing` is the Android ongoing-notification title; it names the state and never carries the pending count, which stays in 采集与存储详情. */
export const captureStatusTable:readonly CaptureStatusRow[]=[
  {id:'capturing',level:'normal',home:null,notification:null,androidOngoing:'采集中',macIcon:'normal',central:{textKey:'正在采集',tone:'ok'}},
  {id:'pending_sync',level:'normal',home:null,notification:null,androidOngoing:'采集中',macIcon:'normal',central:{textKey:'正在采集',tone:'ok'}},
  {id:'screen_paused',level:'reminder',home:captureHome('屏幕采集已暂停','resume_capture'),notification:null,androidOngoing:'屏幕采集已暂停',macIcon:'paused',central:{textKey:'正在采集',tone:'ok'}},
  {id:'paused',level:'reminder',home:captureHome('采集已暂停','resume_capture'),notification:null,androidOngoing:'采集已暂停',macIcon:'paused',central:{textKey:'已暂停',tone:'neutral'}},
  {id:'send_paused',level:'reminder',home:captureHome('发送已暂停','resume_send'),notification:null,androidOngoing:'采集中 · 发送已暂停',macIcon:'normal',central:null},
  {id:'local_only',level:'reminder',home:null,notification:null,androidOngoing:'采集中',macIcon:'normal',central:null},
  {id:'reconnect',level:'needs_action',home:captureHome('需要重新连接','reconnect'),notification:captureNotification('需要重新连接','reconnect'),androidOngoing:'需要重新连接',macIcon:'alert',central:{textKey:'需要处理',tone:'warn'}},
  {id:'storage_full',level:'needs_action',home:captureHome('本机空间已满','open_storage'),notification:captureNotification('本机空间已满','open_storage'),androidOngoing:'本机空间已满',macIcon:'alert',central:{textKey:'需要处理',tone:'warn'}},
  {id:'interrupted',level:'needs_action',home:captureHome('采集已中断','restart_capture'),notification:captureNotification('采集已中断','restart_capture',captureMobileDesktop),androidOngoing:null,macIcon:'alert',central:{textKey:'需要处理',tone:'warn'}},
  {id:'permission',level:'needs_action',home:captureHome('等待采集权限','open_permissions'),notification:captureNotification('等待采集权限','open_permissions'),androidOngoing:'部分来源等待权限',macIcon:'alert',central:{textKey:'等待权限',tone:'warn'}},
  {id:'send_attention',level:'needs_action',home:captureHome('发送需要处理','open_sync'),notification:captureNotification('发送需要处理','open_sync'),androidOngoing:'采集中 · 发送需要处理',macIcon:'alert',central:null},
  {id:'disconnected',level:'needs_action',home:null,notification:null,androidOngoing:null,macIcon:null,central:{textKey:'失联',tone:'warn'}},
];

const captureStatusRowById=new Map(captureStatusTable.map(row=>[row.id,row]));
export function captureStatusRow(id:CaptureStatusId):CaptureStatusRow{
  const row=captureStatusRowById.get(id);
  if(!row)throw Error(`Unknown capture status: ${id}`);
  return row;
}

const captureCount=(n:number|null|undefined):number|null=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0?n:null;

/** Pick the single row shown at the home hint. Needs-action facts win over reminders; disconnected is Central-only. */
export function captureStatus(facts:CaptureStatusFacts):CaptureStatusRow{
  if(facts.disconnected)return captureStatusRow('disconnected');
  if(facts.connection==='reconnect')return captureStatusRow('reconnect');
  if(facts.storageFull)return captureStatusRow('storage_full');
  if(facts.captureEnabled&&facts.interrupted)return captureStatusRow('interrupted');
  if(facts.captureEnabled&&facts.permission)return captureStatusRow('permission');
  // Enabled capture with no live source and no explicit cause still needs the owner to check permissions.
  if(facts.captureEnabled&&!facts.captureLive)return captureStatusRow('permission');
  if(facts.connection==='connected'&&(facts.syncState==='error'||facts.syncState==='blocked'))return captureStatusRow('send_attention');
  if(facts.captureEnabled&&facts.screenPausedAt)return captureStatusRow('screen_paused');
  if(!facts.captureEnabled)return captureStatusRow('paused');
  if(facts.connection==='unconfigured'||facts.syncState==='unconfigured')return captureStatusRow('local_only');
  if(facts.connection==='connected'&&facts.syncState==='paused')return captureStatusRow('send_paused');
  if((captureCount(facts.pending)??0)>0)return captureStatusRow('pending_sync');
  return captureStatusRow('capturing');
}
