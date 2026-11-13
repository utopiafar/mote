import {featureRequirementsAvailable,type FeatureInventory} from '@mote/shared';
import {ViewLifetime} from '@mote/shared/plugin-view-lifetime';
import type {Answer,Capture} from '../../api';
import type {Api} from '../../api';
import type {DiscoveryState} from '../../discovery-availability';
import type {HomeEntry} from '../../features/types';
import type {OwnerBrowsePage} from '../library/owner-library-browse';
import {webFeatures} from '../../features/registry';
import {operationFeed,type OperationFeed} from '../work/operation-feed';
import {ownerQuestionListPath} from '../../owner-question-route';
import {resources,type Resource,type ResourceSnapshot} from '../../resource-cache';
import {assistantScopeQuery,homeAssistantScope,type AssistantCardPage} from './assistant-cards';

export type FirstDeviceData={state:'waiting'|'unverified'|'received_unavailable'|'ready';originalAvailable:boolean;checkedDevices:number;checkedRecords:number;windowLimited:boolean;candidate?:{id:string;deviceId:string;deviceName:string;source:string;capturedAt:string;receivedAt:string}};
export type HomeSource={id:string;name?:string;status?:{state:string}};
export type HomeConnection={scope:string;revokedAt?:string;expiresAt?:string};
export type HomeConversation={id:string;title:string;updatedAt:string;turnCount:number};
export type HomeInsightRun={id:string;status:string;scope:unknown;createdAt:string;updatedAt:string;events:unknown[];result?:Answer};
export type HomeQuestionPage={items:{id:string}[];nextCursor?:string|null};
export type HomeActionPage={items:{id:string;version:number;status:string;resolution?:string;event?:{start?:string|null;end?:string|null}}[];nextCursor:number|null;revision?:number;authorizationRevision?:number;progress?:{jobs?:{status:string;count:number}[]}};
export type HomeTodoPage={items:{status:string}[];nextCursor:string|null};
export type HomeCatalogPage=OwnerBrowsePage;

/** One read projected from the shared resource cache. refresh is the exact
 * read this plugin owns; consumers render the snapshot and never issue their
 * own resource reads. */
export interface HomeRead<T> extends ResourceSnapshot<T>{refresh:()=>void;}
const idle:HomeRead<never>={loading:false,refresh:()=>{}};
const read=<T>(resource:Resource<unknown>|undefined):HomeRead<T>=>resource?{...resource.getSnapshot(),refresh:resource.refresh} as HomeRead<T>:idle as HomeRead<T>;

export type HomeReadName='features'|'sources'|'connections'|'catalog'|'conversations'|'questions'|'insightRuns'|'actions'|'todos'|'firstData'|'firstPreview'|'cards';

export interface HomeSnapshot {
  readonly api:Api;
  readonly availability:DiscoveryState;
  readonly homeEntries:readonly HomeEntry[];
  readonly firstUse:boolean;
  readonly feedError:unknown;
  readonly features:HomeRead<FeatureInventory>;
  readonly sources:HomeRead<{items:HomeSource[]}>;
  readonly connections:HomeRead<{items:HomeConnection[]}>;
  readonly catalog:HomeRead<HomeCatalogPage>;
  readonly conversations:HomeRead<{items:HomeConversation[]}>;
  readonly questions:HomeRead<HomeQuestionPage>;
  readonly insightRuns:HomeRead<{items:HomeInsightRun[]}>;
  readonly actions:HomeRead<HomeActionPage>;
  readonly todos:HomeRead<HomeTodoPage>;
  readonly firstData:HomeRead<FirstDeviceData>;
  readonly firstPreview:HomeRead<Capture>;
  readonly cards:HomeRead<AssistantCardPage>;
  readonly cardPaging:{page:number;previous:()=>void;next:(cursor:string)=>void;reset:()=>void};
}

export interface HomeControllerOptions {
  readonly api:Api;
  readonly captures?:number;
  readonly deviceIds?:readonly string[];
}

interface Slot { name:HomeReadName; path:string; resource:Resource<unknown>; unsubscribe?:()=>void }

const names:readonly HomeReadName[]=['features','sources','connections','catalog','conversations','questions','insightRuns','actions','todos','firstData','firstPreview','cards'];

/** Owns Home's reads and pollers: registry/inventory projection, first-use
 * receipt and preview, catalog/sources/connections, optional Ask/Action reads,
 * review-run polling and the shared change feed. The page component subscribes
 * to this snapshot. Visibility suspends reads and the feed; resuming validates
 * each current key exactly once before polling continues. */
export class HomeController {
  readonly api:Api;
  readonly #lifetime=new ViewLifetime();
  readonly #listeners=new Set<()=>void>();
  readonly #slots=new Map<HomeReadName,Slot>();
  readonly #pollers=new Map<HomeReadName,{interval:number;off:()=>void}>();
  #snapshot:HomeSnapshot;
  #started=false;
  #foreground=typeof document==='undefined'||!document.hidden;
  #firstUse=false;
  #deviceRevision:string;
  #feed?:OperationFeed;
  #feedError:unknown;
  #unsubscribeFeed?:()=>void;
  #unsubscribeRegistry?:()=>void;
  #updating=false;
  #pending=false;
  #disposed=false;
  #cardCursors:(string|undefined)[]=[undefined];

  constructor(options:HomeControllerOptions){
    this.api=options.api;
    this.#deviceRevision=String(options.captures??0)+':'+[...(options.deviceIds??[])].sort().join(',');
    this.#snapshot=this.#buildSnapshot();
  }

  getSnapshot=():HomeSnapshot=>this.#snapshot;
  subscribe=(listener:()=>void):(()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};

  start():void{
    if(this.#disposed||this.#started)return;
    this.#started=true;
    this.#foreground=typeof document==='undefined'||!document.hidden;
    this.#lifetime.show();
    if(typeof document!=='undefined')document.addEventListener('visibilitychange',this.#visibility);
    this.#unsubscribeRegistry=webFeatures.registry.subscribe(this.#registryChanged);
    if(this.#foreground)this.#resume();
    this.#refresh();
  }

  stop():void{
    if(!this.#started)return;
    this.#started=false;
    this.#suspend();
    if(typeof document!=='undefined')document.removeEventListener('visibilitychange',this.#visibility);
    this.#unsubscribeRegistry?.();this.#unsubscribeRegistry=undefined;
    this.#lifetime.suspend();
  }

  dispose():void{
    if(this.#disposed)return;
    this.stop();
    this.#disposed=true;
    this.#lifetime.dispose();
    this.#listeners.clear();
  }

  /** The receipt key moves with the observed store/device projection. */
  setInputs(inputs:{captures?:number;deviceIds?:readonly string[]}):void{
    if(this.#disposed)return;
    const revision=String(inputs.captures??0)+':'+[...(inputs.deviceIds??[])].sort().join(',');
    if(revision===this.#deviceRevision)return;
    this.#deviceRevision=revision;
    this.#slots.get('firstData')?.resource.invalidate();
  }

  refresh(name:HomeReadName):void{this.#slots.get(name)?.resource.refresh();}
  refreshAll():void{for(const slot of this.#slots.values())slot.resource.refresh();}
  refreshFirstData():void{this.refresh('firstData');}
  refreshFirstPreview():void{this.refresh('firstPreview');}
  previousCards=():void=>{if(this.#cardCursors.length>1){this.#cardCursors.pop();this.#changed();}};
  nextCards=(cursor:string):void=>{if(cursor&&cursor!==this.#cardCursors.at(-1)){this.#cardCursors.push(cursor);this.#changed();}};
  resetCards=():void=>{this.#cardCursors=[undefined];this.#changed();};

  #emit():void{for(const listener of this.#listeners)listener();}
  #changed=():void=>{
    if(!this.#started||this.#disposed)return;
    if(this.#updating){this.#pending=true;return;}
    do{
      this.#pending=false;this.#updating=true;
      try{this.#refresh();}finally{this.#updating=false;}
    }while(this.#pending);
  };

  #refresh():void{
    if(!this.#started||this.#disposed)return;
    this.#updateFirstUse();
    this.#applySlots();
    this.#applyPollers();
    this.#snapshot=this.#buildSnapshot();
    this.#emit();
  }

  #registryChanged=():void=>{this.#changed();};
  #feedChanged=():void=>{const error=this.#feed?.getSnapshot();if(error===this.#feedError)return;this.#feedError=error;this.#snapshot=this.#buildSnapshot();this.#emit();};

  #visibility=():void=>{
    if(this.#disposed||!this.#started)return;
    if(typeof document!=='undefined'&&document.hidden)this.#pause();
    else this.#play();
  };

  #pause():void{
    if(!this.#foreground)return;
    this.#foreground=false;
    this.#suspend();
  }

  #play():void{
    if(this.#foreground||this.#disposed)return;
    this.#foreground=true;
    this.#lifetime.show();
    this.#resume();
    this.#refresh();
  }

  #suspend():void{
    for(const slot of this.#slots.values()){slot.unsubscribe?.();slot.unsubscribe=undefined;}
    for(const poller of this.#pollers.values())poller.off();
    this.#pollers.clear();
    this.#unsubscribeFeed?.();this.#unsubscribeFeed=undefined;this.#feed=undefined;
    if(this.#lifetime.state==='visible')this.#lifetime.suspend();
  }

  /** Resuming validates each current key once. invalidate() marks a dirty key
   * before subscribing, so a reattached read never doubles the catch-up. */
  #resume():void{
    this.#updateFirstUse();
    const existing=new Set(this.#slots.values());
    this.#applySlots(false);
    for(const slot of existing)if([...this.#slots.values()].includes(slot))slot.resource.invalidate();
    this.#applySlots(true);
    this.#applyPollers();
    if(!this.#unsubscribeFeed){
      this.#feed=operationFeed(this.api);
      this.#unsubscribeFeed=this.#feed.subscribe(this.#feedChanged);
    }
  }

  #supports(path:string):boolean{
    const features=read<FeatureInventory>(this.#slots.get('features')?.resource);
    return features.error===undefined&&featureRequirementsAvailable(['http:GET:'+path],features.data);
  }

  #hasPage(id:string):boolean{return webFeatures.page(id)!==undefined;}

  #plan():Map<HomeReadName,string>{
    const plan=new Map<HomeReadName,string>();
    plan.set('features','/api/features');
    plan.set('sources','/api/sources');
    plan.set('connections','/api/connections');
    plan.set('catalog','/api/library/browse?limit=3');
    plan.set('firstData','/api/devices/first-data');
    const canConversations=this.#hasPage('ask')&&this.#supports('/api/conversations');
    const canQuestions=this.#hasPage('ask')&&this.#supports('/api/owner-questions');
    const canActions=this.#hasPage('actions')&&this.#supports('/api/actions');
    const canTodos=this.#hasPage('actions')&&this.#supports('/api/todos');
    const canInsightRuns=this.#hasPage('insights')&&this.#supports('/api/insight-runs');
    if(canConversations)plan.set('conversations','/api/conversations?limit=3');
    if(canQuestions)plan.set('questions',ownerQuestionListPath());
    if(canInsightRuns)plan.set('insightRuns','/api/insight-runs');
    if(canActions)plan.set('actions','/api/actions?cursor=0');
    if(canTodos)plan.set('todos','/api/todos?status=open');
    if(this.#hasPage('insights')&&this.#supports('/api/assistant-cards')){
      const query=assistantScopeQuery(homeAssistantScope);query.set('limit','6');
      const cursor=this.#cardCursors.at(-1);if(cursor)query.set('cursor',cursor);
      plan.set('cards','/api/assistant-cards?'+query);
    }
    const candidate=read<FirstDeviceData>(this.#slots.get('firstData')?.resource).data?.candidate;
    if(this.#firstUse&&candidate)plan.set('firstPreview','/api/capture-browser/'+encodeURIComponent(candidate.id));
    return plan;
  }

  #applySlots(attach=true):void{
    const plan=this.#plan();
    for(const name of names){
      const path=plan.get(name),current=this.#slots.get(name);
      if(!path){if(current){this.#detach(current);this.#slots.delete(name);}continue;}
      if(current&&current.path===path){
        if(attach&&!current.unsubscribe)this.#attach(current);
        continue;
      }
      if(current){this.#detach(current);this.#slots.delete(name);}
      const slot:Slot={name,path,resource:resources(this.api).get<unknown>(path)};
      this.#slots.set(name,slot);
      if(attach&&this.#foreground)this.#attach(slot);
    }
  }

  #attach(slot:Slot):void{
    if(!this.#started||!this.#foreground||slot.unsubscribe)return;
    slot.unsubscribe=slot.resource.subscribe(this.#changed);
  }

  #detach(slot:Slot):void{
    slot.unsubscribe?.();slot.unsubscribe=undefined;
    this.#pollers.get(slot.name)?.off();
    this.#pollers.delete(slot.name);
  }

  #applyPollers():void{
    if(!this.#started||!this.#foreground)return;
    const running=Boolean(read<{items:HomeInsightRun[]}>(this.#slots.get('insightRuns')?.resource).data?.items.some(run=>run.status==='running'));
    const wanted=new Map<HomeReadName,number>([['features',5000]]);
    if(this.#slots.has('cards'))wanted.set('cards',5000);
    if(running)wanted.set('insightRuns',5000);
    for(const [name,poller]of this.#pollers)if(wanted.get(name)!==poller.interval){poller.off();this.#pollers.delete(name);}
    for(const [name,interval]of wanted){
      if(this.#pollers.has(name))continue;
      const slot=this.#slots.get(name);
      if(!slot||!slot.unsubscribe)continue;
      this.#pollers.set(name,{interval,off:slot.resource.poll(interval)});
    }
  }

  #updateFirstUse():void{
    if(this.#firstUse)return;
    const first=read<FirstDeviceData>(this.#slots.get('firstData')?.resource);
    const catalog=read<HomeCatalogPage>(this.#slots.get('catalog')?.resource);
    if(first.error===undefined&&!first.loading&&first.data&&['waiting','unverified'].includes(first.data.state)&&catalog.error===undefined&&catalog.data?.items.length===0)this.#firstUse=true;
  }

  #buildSnapshot():HomeSnapshot{
    const features=read<FeatureInventory>(this.#slots.get('features')?.resource);
    const availability:DiscoveryState={
      pages:webFeatures.pages(),collections:webFeatures.collections(),
      inventory:features.data,inventoryError:features.error,inventoryLoading:features.loading,
    };
    return {
      api:this.api,availability,homeEntries:webFeatures.homes(),firstUse:this.#firstUse,feedError:this.#feedError,
      features,
      sources:read(this.#slots.get('sources')?.resource),
      connections:read(this.#slots.get('connections')?.resource),
      catalog:read(this.#slots.get('catalog')?.resource),
      conversations:read(this.#slots.get('conversations')?.resource),
      questions:read(this.#slots.get('questions')?.resource),
      insightRuns:read(this.#slots.get('insightRuns')?.resource),
      actions:read(this.#slots.get('actions')?.resource),
      todos:read(this.#slots.get('todos')?.resource),
      firstData:read(this.#slots.get('firstData')?.resource),
      firstPreview:read(this.#slots.get('firstPreview')?.resource),
      cards:read(this.#slots.get('cards')?.resource),
      cardPaging:{page:this.#cardCursors.length,previous:this.previousCards,next:this.nextCards,reset:this.resetCards},
    };
  }
}

export function createHomeController(options:HomeControllerOptions):HomeController{return new HomeController(options);}
