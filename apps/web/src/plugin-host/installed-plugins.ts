import {desktopUiLayout,validateUiLayoutProfile,validateUiTheme,type PluginPresentationInventory,type UiPresentationHost,type UiReference} from '@mote/shared';
import type {Api} from '../api';
import {resources} from '../resource-cache';
import type {WebFeatureHost} from '../features/host';
import {WorkspaceShell,type WebShellRenderer} from '../presentation';
import {bootstrapPlugins} from './bootstrap';
import type {PluginContributionScope} from './contributions';

export const installedPresentationPath='/api/plugins/presentation';
type Choice={key:string;label:string;reference:UiReference};
type Choices={theme:readonly Choice[];layout:readonly Choice[]};
type Mounted={fingerprint:string;epoch:number;scope:PluginContributionScope;choices:Choices};

/** The authenticated application's dynamic inventory consumer. Only host-owned
 * renderers enter React; a package contributes isolated documents or data.
 * Serialized reconciliation and connection epochs fence late mounts/results. */
export class InstalledWebPlugins {
  #mounted=new Map<string,Mounted>();
  #choices:Choices={theme:[],layout:[]};
  #listeners=new Set<()=>void>();
  #pending:Promise<unknown>=Promise.resolve();
  #epoch=0;
  #disconnect?:()=>void;
  #closed=false;
  #errors:unknown[]=[];
  #preferenceKey?:string;
  #desired={theme:'',layout:''};
  readonly defaults:{theme:UiReference;layout:UiReference};
  constructor(readonly host:WebFeatureHost,readonly presentation:UiPresentationHost<WebShellRenderer>){
    const initial=presentation.getSnapshot();this.defaults={theme:initial.theme,layout:initial.layout};
  }
  getSnapshot=()=>this.#choices;
  subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};
  getErrors=()=>this.#errors;
  get scopes(){return new Map([...this.#mounted].map(([id,value])=>[id,value.scope]));}
  #publish(){
    this.#choices={theme:[...this.#mounted.values()].flatMap(value=>value.choices.theme),layout:[...this.#mounted.values()].flatMap(value=>value.choices.layout)};
    for(const listener of this.#listeners)listener();
  }
  select(surface:'theme'|'layout',key:string){
    const reference=key?this.#choices[surface].find(value=>value.key===key)?.reference:this.defaults[surface];
    if(!reference)throw new Error('Presentation provider unavailable');
    const current=this.presentation.getSnapshot();this.presentation.activate({theme:current.theme,layout:current.layout,[surface]:reference});
    this.#desired[surface]=key;
    try{if(this.#preferenceKey)localStorage.setItem(this.#preferenceKey,JSON.stringify(this.#desired));}catch{/* The live selection remains usable when preference storage is unavailable. */}
  }
  /** A binding belongs to one verified Api object. Navigation never releases
   * it; signing out or application teardown does. */
  connect(api:Api,viewScope?:string):()=>void {
    if(this.#closed)throw new Error('Installed plugin consumer is closed');
    this.#disconnect?.();const epoch=++this.#epoch;
    this.#preferenceKey=viewScope?'mote.plugin-presentation.'+viewScope:undefined;this.#desired={theme:'',layout:''};
    try{
      const saved=this.#preferenceKey&&JSON.parse(localStorage.getItem(this.#preferenceKey)??'null');
      if(saved&&typeof saved.theme==='string'&&typeof saved.layout==='string')this.#desired={theme:saved.theme,layout:saved.layout};
    }catch{/* Corrupt or unavailable preference storage uses the built-in presentation. */}
    const resource=resources(api).get<PluginPresentationInventory>(installedPresentationPath);
    const update=()=>{
      if(epoch!==this.#epoch)return;
      const snapshot=resource.getSnapshot();
      if(snapshot.error)void this.reconcile({instances:[]},api,epoch);
      else if(!snapshot.loading&&snapshot.data)void this.reconcile(snapshot.data,api,epoch);
    };
    resource.invalidate(true);
    const unsubscribe=resource.subscribe(update),stopPoll=resource.poll(1500);
    update();
    let connected=true;
    const disconnect=()=>{
      if(!connected)return;connected=false;unsubscribe();stopPoll();
      if(epoch!==this.#epoch)return;
      ++this.#epoch;
      // Bridge admission closes synchronously, before asynchronous fibers drain.
      for(const value of this.#mounted.values())value.scope.customPages?.revoke();
      void this.reconcile({instances:[]},api,this.#epoch);
    };
    this.#disconnect=disconnect;return disconnect;
  }
  reconcile(inventory:PluginPresentationInventory,api:Api,epoch=this.#epoch):Promise<unknown>{
    const work=this.#pending.then(()=>this.#apply(inventory,api,epoch));
    this.#pending=work.catch(error=>{this.#errors.push(error);});return this.#pending;
  }
  async #apply(inventory:PluginPresentationInventory,api:Api,epoch:number){
    if(epoch!==this.#epoch||this.#closed)return;
    let instances=inventory?.instances;
    if(!Array.isArray(instances)||instances.some(value=>!value||typeof value.instanceId!=='string')||new Set(instances.map(value=>value.instanceId)).size!==instances.length){
      this.#errors.push(new Error('Invalid installed presentation inventory'));instances=[];
    }
    const incoming=new Map(instances.map(value=>[value.instanceId,value]));
    let changed=false;
    for(const [id,mounted] of this.#mounted){
      if(mounted.epoch===epoch&&JSON.stringify(incoming.get(id))===mounted.fingerprint)continue;
      this.#mounted.delete(id);changed=true;const result=await mounted.scope.rollback();this.#errors.push(...result.errors);
    }
    for(const instance of instances){
      if(epoch!==this.#epoch||this.#closed)break;
      if(this.#mounted.has(instance.instanceId))continue;
      let scope:PluginContributionScope|undefined;
      try{
        const fingerprint=JSON.stringify(instance),choices:Choices={theme:[],layout:[]};
        const customPages=instance.pages.map(page=>{
          const expected=`/plugin-pages/${encodeURIComponent(instance.instanceId)}/${encodeURIComponent(instance.activationId)}/${encodeURIComponent(page.id)}`;
          if(page.version!=='1'||page.entryUrl!==expected||!Array.isArray(page.methods)||page.methods.length>32||page.methods.some(value=>!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value)||['constructor','prototype','__proto__'].includes(value)))throw new Error('Invalid installed page');
          return {id:page.id,version:page.version,title:page.title,entryUrl:page.entryUrl,declared:page.methods,
            // The request is independent of the view signal. Closing the page
            // fences its reply, while already authorized server work continues.
            invoke:(method:string,payload:unknown)=>api.request(`/api/plugin-instances/${encodeURIComponent(instance.instanceId)}/pages/${encodeURIComponent(page.id)}/invoke`,{method:'POST',body:JSON.stringify({activationId:instance.activationId,method,...(payload===undefined?{}:{payload})})})};
        });
        const result=await bootstrapPlugins(this.host,[{packageId:instance.packageId,installationId:instance.installationId,instanceId:instance.instanceId,desired:'active',compatible:true,loader:'external',contributions:[],customPages}],{
          isolatedLoaders:new Map([[instance.instanceId,{mount:owned=>{
            for(const {contributionId,pack} of instance.themes){
              const scoped=validateUiTheme({...pack,id:`installed.${instance.instanceId}.${pack.id}`});
              owned.defer(this.presentation.registerTheme(scoped));(choices.theme as Choice[]).push({key:instance.instanceId+'/'+contributionId,label:instance.name+' · '+pack.id,reference:scoped});
            }
            for(const {contributionId,pack} of instance.layouts){
              const profile=validateUiLayoutProfile({...pack,id:`installed.${instance.instanceId}.${pack.id}`});
              owned.defer(this.presentation.registerLayout({...profile,implementation:WorkspaceShell}));(choices.layout as Choice[]).push({key:instance.instanceId+'/'+contributionId,label:instance.name+' · '+pack.id,reference:profile});
            }
          }}]]),
        });
        scope=result.scopes.get(instance.instanceId)!;
        const outcome=result.reports[0]!.outcome;
        if(outcome.observed!=='mounted')throw outcome.observed==='failed'?outcome.error.cause:new Error('Installed presentation did not mount');
        if(epoch!==this.#epoch||this.#closed){await scope.rollback();break;}
        this.#mounted.set(instance.instanceId,{fingerprint,epoch,scope,choices});changed=true;
      }catch(error){if(scope)await scope.rollback();this.#errors.push(error);}
    }
    if(changed){
      this.#publish();
      for(const surface of ['theme','layout'] as const)if(this.#desired[surface]&&this.#choices[surface].some(value=>value.key===this.#desired[surface]))this.select(surface,this.#desired[surface]);
    }
  }
  async close(){
    this.#disconnect?.();this.#closed=true;++this.#epoch;await this.#pending;
    for(const mounted of this.#mounted.values()){const result=await mounted.scope.rollback();this.#errors.push(...result.errors);}
    this.#mounted.clear();this.#publish();return {errors:this.#errors};
  }
}
