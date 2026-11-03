import {ViewLifetime} from '@mote/shared/plugin-view-lifetime';
import type {StorageStatistics} from '@mote/shared/storage-statistics';
import {ApiError,errorMessage,type Api} from '../../api';
import {invalidateConfiguration} from '../../configuration-cache';
import {resources,type Resource,type ResourceSnapshot} from '../../resource-cache';

export interface ContentStorageState {
  readonly enabled:boolean;
  readonly revision:number;
  readonly job:{readonly state:'idle'|'running'|'completed'|'cancelled';readonly total:number;readonly processed:number;readonly converted:number;readonly skipped:number;readonly failed:number};
}

export type MaintenanceReadName='statistics'|'content';

export interface MaintenanceSnapshot {
  readonly api:Api;
  readonly statistics:ResourceSnapshot<StorageStatistics>;
  readonly content:ResourceSnapshot<ContentStorageState>;
  readonly contentBusy:boolean;
  readonly contentError:string;
  readonly transferBusy:string;
  readonly transferKind:string;
  readonly transferMessage:string;
  readonly transferError:unknown;
}

export interface MaintenanceControllerOptions {
  readonly api:Api;
  readonly document?:Document;
}

const idle:ResourceSnapshot<never>={loading:false};
const paths:Record<MaintenanceReadName,string>={statistics:'/api/storage-statistics',content:'/api/content-storage'};
const unavailable=new Set([401,403,404,410]);

interface Slot {name:MaintenanceReadName;resource:Resource<unknown>;unsubscribe:()=>void;pollOff?:()=>void}

/** Owns the low-frequency maintenance reads and the durable export/import
 * handoff. Hiding the page detaches reads and polling; an already authorized
 * browser transfer keeps running, and resuming republishes its real state. */
export class MaintenanceController {
  readonly api:Api;
  readonly #document?:Document;
  readonly #lifetime=new ViewLifetime();
  readonly #listeners=new Set<()=>void>();
  readonly #interests=new Map<MaintenanceReadName,number>();
  readonly #slots=new Map<MaintenanceReadName,Slot>();
  #started=false;
  #foreground=true;
  #disposed=false;
  #snapshot:MaintenanceSnapshot;
  #contentData?:ContentStorageState;
  #contentBusy=false;
  #contentError='';
  #transferBusy='';
  #transferKind='';
  #transferMessage='';
  #transferError:unknown;
  #refresh?:()=>void;
  #refreshPending=false;
  #views=0;

  constructor(options:MaintenanceControllerOptions){
    this.api=options.api;
    this.#document=options.document??(typeof document==='undefined'?undefined:document);
    this.#snapshot=this.#buildSnapshot();
  }

  getSnapshot=():MaintenanceSnapshot=>this.#snapshot;

  subscribe=(listener:()=>void):(()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};

  setRefresh(refresh?:()=>void):void{this.#refresh=refresh;}

  /** A mounted surface keeps this controller's durable work publishable.
   * Navigation away releases the view without cancelling the fetch itself. */
  attach():()=>void{
    if(this.#disposed)return()=>{};
    this.#views+=1;
    return()=>{this.#views=Math.max(0,this.#views-1);};
  }

  start():void{
    if(this.#started||this.#disposed)return;
    this.#started=true;
    this.#foreground=!this.#hidden();
    this.#document?.addEventListener('visibilitychange',this.#visibility);
    if(this.#foreground){this.#lifetime.show();this.#bindInterests();}
    else this.#lifetime.suspend();
    this.#emit();
  }

  stop():void{
    if(!this.#started)return;
    this.#started=false;
    this.#document?.removeEventListener('visibilitychange',this.#visibility);
    this.#detachAll();
    this.#lifetime.suspend();
    this.#emit();
  }

  dispose():void{
    if(this.#disposed)return;
    this.stop();
    this.#disposed=true;
    this.#lifetime.dispose();
    this.#listeners.clear();
  }

  /** A mounted surface declares which reads it needs; leaving releases them. */
  watch(name:MaintenanceReadName):()=>void{
    this.#interests.set(name,(this.#interests.get(name)??0)+1);
    this.#bind(name);
    return()=>{
      const count=(this.#interests.get(name)??1)-1;
      if(count>0){this.#interests.set(name,count);return;}
      this.#interests.delete(name);
      this.#detach(name);
    };
  }

  refresh(name:MaintenanceReadName):void{
    this.#slots.get(name)?.resource.refresh();
  }

  /** Durable maintenance transfer: hide/resume never cancels it, and only the
   * same owner can publish its receipt. */
  async run(kind:string,work:(current:()=>boolean)=>Promise<string>):Promise<void>{
    if(!this.#started||this.#disposed||this.#transferBusy)return;
    const owner=this.api;
    this.#transferBusy=kind;this.#transferKind=kind;this.#transferMessage='';this.#transferError=undefined;
    this.#emit();
    try{
      const message=await work(()=>this.api===owner&&!this.#disposed&&this.#views>0);
      if(this.#disposed||this.api!==owner||this.#views<=0)return;
      this.#transferMessage=message;this.#transferKind=kind;
      if(this.#foreground)this.#refresh?.();else this.#refreshPending=true;
    }catch(error){if(!this.#disposed&&this.api===owner)this.#transferError=error;}
    finally{if(!this.#disposed&&this.api===owner){this.#transferBusy='';this.#emit();}}
  }

  reloadContent():void{
    this.#contentError='';
    this.refresh('content');
  }

  async setContentEnabled(enabled:boolean,onChange?:()=>void):Promise<void>{
    const current=this.#contentData;
    if(!current||this.#contentBusy)return;
    await this.#contentCommand('/api/content-storage','PUT',{enabled,revision:current.revision},onChange);
  }

  async decrypt(onChange?:()=>void):Promise<void>{
    if(this.#contentBusy)return;
    await this.#contentCommand('/api/content-storage/decrypt','POST',{},onChange);
  }

  async cancelDecrypt(onChange?:()=>void):Promise<void>{
    if(this.#contentBusy)return;
    await this.#contentCommand('/api/content-storage/decrypt/cancel','POST',{},onChange);
  }

  async #contentCommand(path:string,method:string,body:object,onChange?:()=>void):Promise<void>{
    const owner=this.api;
    this.#contentBusy=true;this.#contentError='';
    this.#emit();
    try{
      const next=await this.api.request<ContentStorageState>(path,{method,body:JSON.stringify(body)});
      if(this.#disposed||this.api!==owner||this.#views<=0)return;
      this.#applyContent(next);
      invalidateConfiguration(this.api);
      onChange?.();
    }catch(error){if(!this.#disposed&&this.api===owner)this.#contentError=errorMessage(error);}
    finally{if(!this.#disposed&&this.api===owner){this.#contentBusy=false;this.#emit();}}
  }

  #buildSnapshot():MaintenanceSnapshot{
    const statistics=this.#slots.get('statistics')?.resource.getSnapshot() as ResourceSnapshot<StorageStatistics>|undefined;
    const content=this.#slots.get('content')?.resource.getSnapshot() as ResourceSnapshot<ContentStorageState>|undefined;
    return {
      api:this.api,
      statistics:statistics??idle,
      content:{...(content?.loading&&!this.#contentData?{loading:true}:{loading:false}),...(this.#contentData?{data:this.#contentData}:{}),...(content?.error!==undefined?{error:content.error}:{})},
      contentBusy:this.#contentBusy,contentError:this.#contentError,
      transferBusy:this.#transferBusy,transferKind:this.#transferKind,transferMessage:this.#transferMessage,transferError:this.#transferError,
    };
  }

  #emit():void{
    this.#snapshot=this.#buildSnapshot();
    for(const listener of this.#listeners)listener();
  }

  #bindInterests():void{for(const name of this.#interests.keys())this.#bind(name);}

  #bind(name:MaintenanceReadName):void{
    if(!this.#started||!this.#foreground||this.#disposed||this.#slots.has(name))return;
    if(!this.#interests.has(name))return;
    const resource=resources(this.api).get<unknown>(paths[name]);
    const slot:Slot={name,resource,unsubscribe:resource.subscribe(this.#changed)};
    this.#slots.set(name,slot);
    this.#syncContentPoll();
    this.#emit();
  }

  #detach(name:MaintenanceReadName):void{
    const slot=this.#slots.get(name);
    if(!slot)return;
    slot.unsubscribe();slot.pollOff?.();this.#slots.delete(name);
    this.#emit();
  }

  #detachAll():void{for(const name of [...this.#slots.keys()])this.#detach(name);}

  #changed=():void=>{
    const content=this.#slots.get('content')?.resource.getSnapshot() as ResourceSnapshot<ContentStorageState>|undefined;
    if(content?.data)this.#applyContent(content.data);
    if(content?.error instanceof ApiError&&unavailable.has(content.error.status))this.#contentData=undefined;
    this.#syncContentPoll();
    this.#emit();
  };

  #applyContent(value:ContentStorageState):void{
    if(this.#contentData&&this.#contentData.revision>value.revision)return;
    this.#contentData=value;
  }

  #syncContentPoll():void{
    const slot=this.#slots.get('content');
    if(!slot)return;
    const running=this.#contentData?.job.state==='running';
    if(running&&!slot.pollOff&&this.#foreground&&this.#started)slot.pollOff=slot.resource.poll(500);
    if(!running&&slot.pollOff){slot.pollOff();slot.pollOff=undefined;}
  }

  /** A JSDOM document without a visual session reports hidden=true/prerender;
   * that is not a browser page hidden by its user. */
  #hidden():boolean{
    const document=this.#document;
    if(!document)return false;
    return (document.visibilityState as string)!=='prerender'&&document.hidden;
  }

  #visibility=():void=>{
    if(!this.#started||this.#disposed)return;
    if(this.#hidden())this.#suspend();
    else this.#resume();
  };

  #suspend():void{
    this.#foreground=false;
    this.#detachAll();
    if(this.#lifetime.state==='visible')this.#lifetime.suspend();
    this.#emit();
  }

  #resume():void{
    this.#foreground=true;this.#lifetime.show();
    this.#bindInterests();
    if(this.#refreshPending){this.#refreshPending=false;this.#refresh?.();}
    this.#emit();
  }
}

export function createMaintenanceController(options:MaintenanceControllerOptions):MaintenanceController{
  return new MaintenanceController(options);
}
