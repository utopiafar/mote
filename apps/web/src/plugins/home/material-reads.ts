import {featureRequirementsAvailable,type FeatureInventory} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {useContext,useEffect,useLayoutEffect,useMemo,useSyncExternalStore} from 'react';
import type {Api} from '../../api';
import type {Material} from '../../Materials';
import {materialKind} from '../../material-presentation';
import {materialTextExcerpt,type MaterialExcerpt} from '../../material-preview-text';
import {sourceMaterialExcerpt} from '../../material-source-preview';
import {resources,type Resource,type ResourceSnapshot} from '../../resource-cache';
import {HomePluginContext} from './context';

export interface MaterialPreviewItem extends Pick<Material,'id'|'ref'|'revision'|'kind'|'textLength'> {
  readonly origin:Material['origin'];
}

interface KeyIdentity {api:Api;ref:string;revision:string}
interface SourceState extends KeyIdentity {text?:string}
interface PreviewState extends KeyIdentity {value:MaterialExcerpt&{material?:{ref:string}}}
interface MembersState extends KeyIdentity {capture?:string}
interface FileState extends KeyIdentity {hasOriginal:boolean;mimeType?:string}
interface ImageState extends KeyIdentity {capture:string;url:string}

interface EntryState {
  readonly inventory:ResourceSnapshot<FeatureInventory>;
  readonly sourceView:boolean;
  readonly thumbnails:boolean;
  readonly source?:SourceState;
  readonly preview?:PreviewState;
  readonly members?:MembersState;
  readonly file?:FileState;
  readonly image?:ImageState;
}

interface Params {canRead:boolean;canPreview:boolean;near:boolean}

const EMPTY_INVENTORY:ResourceSnapshot<FeatureInventory>={loading:false};
const identity=(api:Api,item:Pick<Material,'ref'|'revision'>):KeyIdentity=>({api,ref:item.ref,revision:item.revision});
const same=(a:KeyIdentity|undefined,b:KeyIdentity):boolean=>Boolean(a&&a.api===b.api&&a.ref===b.ref&&a.revision===b.revision);
const itemKey=(item:Pick<Material,'ref'|'revision'>):string=>item.ref+'\u0000'+item.revision;

const thumbnailLimit=4;
let thumbnailActive=0;
const thumbnailPending:{signal:AbortSignal;job:()=>Promise<void>}[]=[];
function thumbnailPump(){
 while(thumbnailActive<thumbnailLimit){
  const next=thumbnailPending.shift();
  if(!next)break;
  if(next.signal.aborted)continue;
  thumbnailActive++;
  void next.job().catch(()=>{/* A missing thumbnail keeps the type icon. */}).finally(()=>{thumbnailActive--;thumbnailPump();});
 }
}
/** Thumbnail fetches share one plugin gate; queued work is dropped when its row goes away. */
function enqueueThumbnail(signal:AbortSignal,job:()=>Promise<void>){
 if(signal.aborted)return;
 const task={signal,job};
 signal.addEventListener('abort',()=>{const index=thumbnailPending.indexOf(task);if(index>=0)thumbnailPending.splice(index,1);},{once:true});
 thumbnailPending.push(task);
 thumbnailPump();
}

/** One bounded preview read for one Material revision. The cache owns the
 * request, abort generation, thumbnail slot and object URL; React only renders
 * the snapshot and gates it against the currently visible identity. */
class HomeMaterialEntry {
  readonly #listeners=new Set<()=>void>();
  #params:Params={canRead:false,canPreview:false,near:false};
  #state:EntryState={inventory:EMPTY_INVENTORY,sourceView:false,thumbnails:false};
  #refs=0;
  #sourceController?:AbortController;
  #previewController?:AbortController;
  #membersController?:AbortController;
  #fileController?:AbortController;
  #thumbnailController?:AbortController;
  #imageObjectUrl?:string;
  #disposed=false;
  #cache:HomeMaterialCache;

  constructor(cache:HomeMaterialCache,readonly api:Api,readonly item:MaterialPreviewItem){this.#cache=cache;}

  get key():string{return itemKey(this.item);}
  getSnapshot=():EntryState=>this.#state;
  subscribe=(listener:()=>void):(()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};
  get observed():boolean{return this.#refs>0;}

  attach(params:Params):()=>void{
    if(this.#disposed)return()=>{};
    this.#refs++;
    this.#params=params;
    this.#refresh();
    return()=>{
      this.#refs--;
      if(this.#refs<=0)this.#cache.releaseEntry(this);
    };
  }

  update(params:Params):void{
    if(this.#disposed)return;
    const previous=this.#params;
    this.#params=params;
    if(previous.canRead!==params.canRead||previous.canPreview!==params.canPreview||previous.near!==params.near)this.#refresh();
  }

  refresh():void{this.#refresh();}

  /** A row leaving the viewport/unmounting releases its in-flight reads and
   * object URL; a StrictMode remount can attach the same cache entry again. */
  suspend():void{
    this.#cancel();
    this.#dropImage();
    this.#listeners.clear();
    this.#state={inventory:this.#state.inventory,sourceView:false,thumbnails:false};
  }

  dispose():void{
    if(this.#disposed)return;
    this.#disposed=true;
    this.#cancel();
    this.#dropImage();
    this.#listeners.clear();
  }

  #cancel():void{
    this.#sourceController?.abort();this.#sourceController=undefined;
    this.#previewController?.abort();this.#previewController=undefined;
    this.#membersController?.abort();this.#membersController=undefined;
    this.#fileController?.abort();this.#fileController=undefined;
    this.#thumbnailController?.abort();this.#thumbnailController=undefined;
  }

  #emit(state:EntryState):void{
    if(this.#disposed)return;
    this.#state=state;
    for(const listener of this.#listeners)listener();
  }

  #patch(patch:Partial<EntryState>):void{this.#emit({...this.#state,...patch});}

  #dropImage():void{
    const image=this.#state.image;
    if(image){if(this.#imageObjectUrl)URL.revokeObjectURL(this.#imageObjectUrl);this.#imageObjectUrl=undefined;this.#patch({image:undefined});}
    else if(this.#imageObjectUrl){URL.revokeObjectURL(this.#imageObjectUrl);this.#imageObjectUrl=undefined;}
  }

  clearImage=():void=>{this.#thumbnailController?.abort();this.#thumbnailController=undefined;this.#dropImage();};

  #needsInventory():boolean{return(this.#params.canRead||this.#params.canPreview)&&this.item.kind==='mote.file';}

  #capability(path:string):boolean{
    const inventory=this.#cache.inventorySnapshot();
    return inventory.error===undefined&&featureRequirementsAvailable(['http:GET:'+path],inventory.data);
  }

  #refresh():void{
    if(this.#disposed||!this.#refs)return;
    const {canRead,canPreview,near}=this.#params,visible=this.#cache.visible;
    const needsInventory=this.#needsInventory();
    this.#cache.observeInventory(this,needsInventory);
    const inventory=this.#cache.inventorySnapshot();
    const sourceView=needsInventory&&canRead&&this.#capability('/api/materials/:id/source-view');
    const thumbnails=needsInventory&&this.#capability('/api/files/:id/thumbnail');
    if(this.#state.inventory!==inventory||this.#state.sourceView!==sourceView||this.#state.thumbnails!==thumbnails)this.#patch({inventory,sourceView,thumbnails});
    if(visible&&near){
      if(canRead&&this.item.textLength>0){
        if(sourceView)this.#startSource();
        else this.#startPreview();
      }
      if(canPreview&&this.item.kind==='mote.file')this.#startMembers();
    }
    if(!near||!visible){
      this.#sourceController?.abort();this.#sourceController=undefined;
      this.#previewController?.abort();this.#previewController=undefined;
      this.#membersController?.abort();this.#membersController=undefined;
      this.#fileController?.abort();this.#fileController=undefined;
      this.#thumbnailController?.abort();this.#thumbnailController=undefined;this.#dropImage();
    }
    this.#maybeThumbnail();
  }

  #startSource():void{
    const key=identity(this.api,this.item);
    if(same(this.#state.source,key)||this.#sourceController)return;
    const controller=new AbortController();this.#sourceController=controller;
    void sourceMaterialExcerpt(this.api,this.item,controller.signal).then(text=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({source:{...key,...(text!==undefined?{text}:{})}});
    }).catch(()=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({source:key});
    }).finally(()=>{if(this.#sourceController===controller)this.#sourceController=undefined;});
  }

  #startPreview():void{
    const key=identity(this.api,this.item);
    if(same(this.#state.preview,key)||this.#previewController)return;
    const controller=new AbortController();this.#previewController=controller;
    const path=`/api/materials/${encodeURIComponent(this.item.id)}/read?revision=${encodeURIComponent(this.item.revision)}&offset=0&length=240`;
    void this.api.request<MaterialExcerpt&{material?:{ref:string}}>(path,{signal:controller.signal}).then(value=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({preview:{...key,value}});
    }).catch(()=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({preview:{...key,value:{text:''}}});
    }).finally(()=>{if(this.#previewController===controller)this.#previewController=undefined;});
  }

  #startMembers():void{
    const key=identity(this.api,this.item);
    if(same(this.#state.members,key)||this.#membersController)return;
    const controller=new AbortController();this.#membersController=controller;
    const path=`/api/materials/${encodeURIComponent(this.item.id)}/members?revision=${encodeURIComponent(this.item.revision)}&offset=0&limit=1`;
    void this.api.request<{items:{kind:string;ref:string}[]}>(path,{signal:controller.signal}).then(value=>{
      if(controller.signal.aborted||!this.observed)return;
      const capture=value.items.find(member=>member.kind==='capture'&&/^capture:[a-f0-9-]{36}$/i.test(member.ref))?.ref.slice(8);
      this.#patch({members:{...key,...(capture?{capture}:{})}});
      this.#maybeFile(capture);
    }).catch(()=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({members:key});
    }).finally(()=>{if(this.#membersController===controller)this.#membersController=undefined;});
  }

  #maybeFile(capture=this.#state.members?.capture):void{
    const key=identity(this.api,this.item);
    if(!capture||!this.#params.canPreview||!this.#cache.visible||!this.#params.near)return;
    if(same(this.#state.file,key)||this.#fileController)return;
    const controller=new AbortController();this.#fileController=controller;
    void this.api.request<{hasOriginal:boolean;sizeBytes:number;item:{mimeType?:string}}>(`/api/files/${encodeURIComponent(capture)}`,{signal:controller.signal}).then(value=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({file:{...key,hasOriginal:value.hasOriginal,...(value.item.mimeType?{mimeType:value.item.mimeType}:{})}});
      this.#maybeThumbnail();
    }).catch(()=>{
      if(controller.signal.aborted||!this.observed)return;
      this.#patch({file:{...key,hasOriginal:false}});
    }).finally(()=>{if(this.#fileController===controller)this.#fileController=undefined;});
  }

  #maybeThumbnail():void{
    const {near,canPreview}=this.#params,file=this.#state.file,members=this.#state.members;
    if(!this.#cache.visible||!near||!canPreview||!this.#state.thumbnails||!file?.hasOriginal||!members?.capture)return;
    if(this.#state.image||this.#thumbnailController)return;
    const key=identity(this.api,this.item);
    if(!same(file,key))return;
    const capture=members.capture;
    const controller=new AbortController();this.#thumbnailController=controller;
    controller.signal.addEventListener('abort',()=>{if(this.#thumbnailController===controller)this.#thumbnailController=undefined;},{once:true});
    enqueueThumbnail(controller.signal,async()=>{
      try{
        const response=await this.api.raw(`/api/files/${encodeURIComponent(capture)}/thumbnail`,{signal:controller.signal});
        if(controller.signal.aborted||!this.observed)return;
        const blob=await response.blob();
        if(controller.signal.aborted||!this.observed)return;
        const url=URL.createObjectURL(blob);
        if(this.#disposed||controller.signal.aborted){URL.revokeObjectURL(url);return;}
        this.#imageObjectUrl=url;
        this.#patch({image:{...key,capture,url}});
      }finally{if(this.#thumbnailController===controller)this.#thumbnailController=undefined;}
    });
  }
}

/** Plugin-owned preview cache per authenticated Api. Hidden documents suspend
 * inventory polling and in-flight row reads; resuming revalidates inventory
 * once and lets each visible row continue one exact revision. */
export class HomeMaterialCache {
  readonly #entries=new Map<string,HomeMaterialEntry>();
  #inventory?:Resource<FeatureInventory>;
  #unsubscribeInventory?:()=>void;
  #inventoryPoller?:()=>void;
  #inventoryNeeds=new Set<HomeMaterialEntry>();
  #inventoryAttaching=false;
  #visible=typeof document==='undefined'||!document.hidden;
  #started=false;
  #refs=0;
  #disposed=false;
  #entriesChanged=():void=>{for(const entry of [...this.#entries.values()])entry.refresh();};

  constructor(readonly api:Api){}

  get visible():boolean{return this.#started&&this.#visible&&!this.#disposed;}

  /** Activation is reversible: hiding/unmounting stops the listener and
   * inventory poll while the same cache can be activated again. */
  start():void{
    if(this.#disposed||this.#started)return;
    this.#started=true;
    this.#visible=typeof document==='undefined'||!document.hidden;
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',this.#visibility);
    this.#entriesChanged();
  }

  stop():void{
    if(!this.#started)return;
    this.#started=false;
    if(typeof document!=='undefined')document.removeEventListener('visibilitychange',this.#visibility);
    this.#detachInventory();
    // A real unmount releases the rows; a StrictMode replay reactivates before
    // this check runs, so only an actually stopped cache drops its entries.
    queueMicrotask(()=>{if(!this.#started)this.#clearEntries();});
  }

  retain():void{this.#refs++;this.start();}

  release():void{
    this.#refs--;
    if(this.#refs>0)return;
    queueMicrotask(()=>{if(!this.#refs)this.stop();});
  }

  entry(api:Api,item:MaterialPreviewItem):HomeMaterialEntry{
    const key=itemKey(item);
    let entry=this.#entries.get(key);
    if(!entry){entry=new HomeMaterialEntry(this,api,item);this.#entries.set(key,entry);}
    return entry;
  }

  releaseEntry(entry:HomeMaterialEntry):void{
    if(this.#entries.get(entry.key)!==entry)return;
    this.#inventoryNeeds.delete(entry);
    entry.suspend();
    if(!this.#inventoryNeeds.size)this.#detachInventory();
  }

  inventorySnapshot():ResourceSnapshot<FeatureInventory>{
    return this.#inventory?.getSnapshot()??EMPTY_INVENTORY;
  }

  observeInventory(entry:HomeMaterialEntry,wanted:boolean):void{
    if(wanted)this.#inventoryNeeds.add(entry);
    else this.#inventoryNeeds.delete(entry);
    this.#inventory??=resources(this.api).get<FeatureInventory>('/api/features');
    if(!this.#inventoryNeeds.size){this.#detachInventory();return;}
    this.#attachInventory();
  }

  #attachInventory():void{
    if(this.#disposed||!this.#started||this.#inventoryAttaching||!this.#visible||!this.#inventoryNeeds.size||!this.#inventory)return;
    if(!this.#unsubscribeInventory){
      this.#inventoryAttaching=true;
      try{
        this.#inventory.invalidate();
        this.#unsubscribeInventory=this.#inventory.subscribe(this.#entriesChanged);
        this.#inventoryPoller=this.#inventory.poll(5000);
      }finally{this.#inventoryAttaching=false;}
      this.#entriesChanged();
    }
  }

  #detachInventory():void{
    this.#unsubscribeInventory?.();this.#unsubscribeInventory=undefined;
    this.#inventoryPoller?.();this.#inventoryPoller=undefined;
  }

  #visibility=():void=>{
    if(!this.#started)return;
    const visible=typeof document==='undefined'||!document.hidden;
    if(visible===this.#visible)return;
    this.#visible=visible;
    if(visible){this.#attachInventory();this.#entriesChanged();}
    else{this.#detachInventory();for(const entry of [...this.#entries.values()])entry.refresh();}
  };

  #clearEntries():void{
    this.#inventoryNeeds.clear();
    for(const entry of this.#entries.values())entry.dispose();
    this.#entries.clear();
    this.#detachInventory();
  }

  dispose():void{
    if(this.#disposed)return;
    this.stop();
    this.#disposed=true;
    this.#clearEntries();
  }
}

const caches=new WeakMap<Api,HomeMaterialCache>();
function sharedMaterials(api:Api):HomeMaterialCache{
  let cache=caches.get(api);
  if(!cache){cache=new HomeMaterialCache(api);caches.set(api,cache);}
  return cache;
}

/** Read the plugin cache for the current authenticated Api; a directly rendered
 * row without the page provider retains the shared cache for that mount. */
export function useHomeMaterialCache(api:Api):HomeMaterialCache{
  const context=useContext(HomePluginContext);
  const shared=context?.controller.api===api?context.materials:undefined;
  const standalone=useMemo(()=>shared?undefined:sharedMaterials(api),[shared,api]);
  useEffect(()=>{
    if(!standalone)return;
    standalone.retain();
    return()=>standalone.release();
  },[standalone]);
  return shared??standalone!;
}

export interface HomeMaterialPreview {
  readonly image?:string;
  readonly kindLabel:string;
  readonly text?:string;
  clearImage:()=>void;
}

/** The exact preview contract reused by Home and Library rows. Every value is
 * gated by the current permission, node, revision and membership identity. */
export function useMaterialPreview(api:Api,item:Material,canRead:boolean,canPreview:boolean,near:boolean):HomeMaterialPreview{
  const cache=useHomeMaterialCache(api);
  const entry=useMemo(()=>cache.entry(api,item),[cache,api,item.id,item.ref,item.revision]);
  useLayoutEffect(()=>entry.attach({canRead,canPreview,near}),[entry]);
  useLayoutEffect(()=>entry.update({canRead,canPreview,near}),[entry,canRead,canPreview,near]);
  const state=useSyncExternalStore(entry.subscribe,entry.getSnapshot,entry.getSnapshot);
  const key=identity(api,item);
  const members=state.members&&same(state.members,key)?state.members:undefined,capture=members?.capture;
  const file=state.file&&same(state.file,key)?state.file:undefined,mime=file?.mimeType;
  const imageFile=Boolean(mime&&['image/png','image/jpeg','image/webp','image/gif'].includes(mime));
  const kindLabel=imageFile?moteText('图片'):mime?.startsWith('text/')?moteText('文档'):mime?.startsWith('audio/')?moteText('音频'):materialKind(item.kind);
  const image=canPreview&&near&&imageFile&&file?.hasOriginal&&state.image&&same(state.image,key)&&state.image.capture===capture?state.image.url:undefined;
  const source=state.sourceView&&state.source&&same(state.source,key)?state.source.text:undefined;
  const preview=state.preview&&same(state.preview,key)?state.preview.value:undefined;
  const text=!canRead?undefined:state.sourceView?source:item.kind==='mote.note'?preview?.material?.ref===item.ref?materialTextExcerpt(preview):undefined:item.kind==='mote.file'?preview?.material?.ref===item.ref?materialTextExcerpt({...preview,spans:preview.spans?.filter(span=>span.format==='plain'||span.format==='transcript')}):undefined:preview?.text;
  return {image,kindLabel,text,clearImage:entry.clearImage};
}
