import type {CaptureInput} from '@mote/shared';
import type {Store} from './store.js';
import type {SourceStore} from './sources.js';
import type {FileStore} from './files.js';

export const INGRESS_PROTOCOL_VERSION='2';
/** Scope this gate to collector writes; owner imports and queries are independent. */
export function collectorIngressWrite(method:string,route:string):boolean {
  if(method==='POST'&&(route==='/api/captures'||route==='/api/captures/batch'||route==='/api/captures/bundle'||route==='/api/notes'))return true;
  if(method==='PUT'&&route==='/api/sources/:id/items')return true;
  if(method==='POST'&&route==='/api/sources/:id/items/batch')return true;
  if(method==='POST'&&route==='/api/capture-browser/:id/ocr')return true;
  if(route.startsWith('/api/file-sync/v1/')&&['POST','PUT'].includes(method))return true;
  return false;
}

/** A receipt attests that input can be recovered. It says nothing about
 * transformation, publication, indexing, or availability to an agent. */
export type IngressReceipt={
  version:2;
  id:string;
  kind:'capture'|'source-item'|'file-revision';
  state:'received';
  duplicate:boolean;
  sourceId?:string;
  externalId?:string;
  revision?:string;
};

type CaptureAck=Awaited<ReturnType<Store['ingest']>>;
type SourceAck=Awaited<ReturnType<SourceStore['upsert']>>;
type FileAck={id:string;sourceId:string;externalId:string;revision:string;duplicate:boolean;[key:string]:unknown};

export function captureReceipt(ack:Pick<CaptureAck,'id'|'duplicate'>):IngressReceipt {
  return {version:2,id:ack.id,kind:'capture',state:'received',duplicate:ack.duplicate};
}
export function sourceReceipt(ack:Pick<SourceAck,'id'|'sourceId'|'externalId'|'revision'|'duplicate'>):IngressReceipt {
  return {version:2,id:ack.id,kind:'source-item',state:'received',duplicate:ack.duplicate,sourceId:ack.sourceId,externalId:ack.externalId,revision:ack.revision};
}
export function fileReceipt(ack:FileAck):IngressReceipt {
  return {version:2,id:ack.id,kind:'file-revision',state:'received',duplicate:ack.duplicate,sourceId:ack.sourceId,externalId:ack.externalId,revision:ack.revision};
}
function fileAcknowledgement(ack:FileAck){return {...ack,receipt:fileReceipt(ack)};}

/** Owns the acknowledgement boundary for all three current physical stores.
 * In particular, a staged file upload has no receipt until commit succeeds. */
export class IngressService {
  constructor(private store:Store,private sources:SourceStore,private files:FileStore){}
  async capture(input:CaptureInput,authorize?:()=>void){
    const ack=await this.store.ingest(input,authorize);
    this.store.captureReceived(input.deviceId);
    return {...ack,receipt:captureReceipt(ack)};
  }
  async captureSettled(inputs:CaptureInput[],authorize?:()=>void){
    const committed=await this.store.ingestSettled(inputs,authorize);
    return committed.map(item=>item.result?{...item,result:{...item.result,receipt:captureReceipt(item.result)}}:item);
  }
  async sourceItem(sourceId:string,input:unknown,authorize?:()=>void){
    const ack=await this.sources.upsert(sourceId,input,authorize);
    return {...ack,receipt:sourceReceipt(ack)};
  }
  async sourceBatch(sourceId:string,inputs:unknown,authorize?:()=>void){
    const result=await this.sources.upsertBatch(sourceId,inputs,authorize);
    return {...result,receipts:result.receipts.map(ack=>({...ack,receipt:sourceReceipt(ack)}))};
  }
  async fileRevision(input:unknown,authorize:(sourceId:string)=>void){
    const ack=await this.files.revision(input,authorize) as FileAck;
    return fileAcknowledgement(ack);
  }
  async fileCommit(uploadId:string,authorize:(sourceId:string)=>void,signal?:AbortSignal){
    const ack=await this.files.commit(uploadId,authorize,signal) as FileAck;
    return fileAcknowledgement(ack);
  }
  fileBegin(input:unknown,authorize:(sourceId:string)=>void){
    const upload=this.files.begin(input,authorize);
    return {...upload,ack:upload.ack?fileAcknowledgement(upload.ack as FileAck):null};
  }
  fileUpload(id:string,authorize:(sourceId:string)=>void){
    const upload=this.files.upload(id,authorize);
    return {...upload,ack:upload.ack?fileAcknowledgement(upload.ack as FileAck):null};
  }
  async fileManifests(input:unknown,authorize:(sourceId:string)=>void){
    const result=await this.files.manifestBatch(input,authorize);
    return {results:(result.results as Array<{ack?:FileAck;upload?:{ack?:FileAck};[key:string]:unknown}>).map(entry=>('ack' in entry&&entry.ack?{...entry,ack:fileAcknowledgement(entry.ack)}:
      'upload' in entry&&entry.upload&&entry.upload.ack?{...entry,upload:{...entry.upload,ack:fileAcknowledgement(entry.upload.ack as FileAck)}}:entry))};
  }
}
