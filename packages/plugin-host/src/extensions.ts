import {
  extensionContract,serviceBindingSchema,serviceRefSchema,
  type ExtensionContract,type ExtensionDefinition,type ExtensionKind,type ExtensionMember,type ExtensionPoint,type ExtensionPublication,
  type ServiceBinding,type ServiceContract,type ServiceLease,type ServiceRef,type Awaitable,type PluginLifecycle,
} from '@mote/plugin-api';
import {PluginHost,type PluginDefinition,type PluginHandle,type HostPluginContext,type HostScope} from './host.js';
import {PluginHostError} from './scope.js';

type NativeOptions=Omit<PluginDefinition,'factory'|'contributions'> & {readonly contributions?:readonly ServiceRef[]};
export interface DefineExtensionOptions<T,K extends ExtensionKind> extends NativeOptions {
  readonly contract:ExtensionContract<T,K>;
  readonly contributionId:string;
  readonly factory?:PluginDefinition['factory'];
}
export interface ProvideExtensionOptions<T,K extends ExtensionKind> extends NativeOptions {
  readonly contributionId:string;
  readonly publication:ExtensionPublication<K>;
  readonly factory:(context:HostPluginContext)=>Awaitable<{readonly value:T;readonly lifecycle:PluginLifecycle}>;
}
export interface ExtensionConsumerOptions<T> extends NativeOptions {
  readonly factory:(context:HostPluginContext,selection:T)=>Awaitable<PluginLifecycle>;
}
export interface ExtensionLeaseMember<T> extends ExtensionMember {readonly lease:ServiceLease<T>}
export type ExtensionSelectionReason='binding_required'|'ambiguous_binding'|'unknown_member'|'duplicate_member'|'invalid_selection';
export class ExtensionSelectionError extends PluginHostError {
  constructor(readonly reason:ExtensionSelectionReason){
    super(reason==='unknown_member'?'dependency_unavailable':reason==='invalid_selection'?'invalid_contract':'conflict');
    this.name='ExtensionSelectionError';
  }
}
interface MemberRecord {readonly info:ExtensionMember;readonly scope:HostScope;active:boolean}
interface PointRecord {
  readonly kind:ExtensionKind;readonly service:ServiceRef;readonly scope:HostScope;
  readonly members:Map<string,MemberRecord>;active:boolean;
}
const key=(binding:ServiceBinding)=>JSON.stringify(serviceBindingSchema.parse(binding));
const memberKey=(member:Pick<ExtensionMember,'namespace'|'name'>)=>JSON.stringify([member.namespace,member.name]);
function fail(reason:ExtensionSelectionReason):never{throw new ExtensionSelectionError(reason);}
const lifecycle:PluginLifecycle={prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
function pinContract<T,K extends ExtensionKind>(input:ExtensionContract<T,K>){
  const contract=extensionContract<T,K>(input.kind,input.service.id,input.service.apiVersion);
  if(contract.definition.id!==input.definition.id||contract.definition.apiVersion!==input.definition.apiVersion)fail('invalid_selection');
  return contract;
}
function pinPoint<T,K extends ExtensionKind>(point:ExtensionPoint<T,K>):ExtensionPoint<T,K>{
  return Object.freeze({contract:pinContract(point.contract),binding:serviceBindingSchema.parse(point.binding)});
}
function publication(kind:ExtensionKind,input:ExtensionPublication<ExtensionKind>,fallback:string){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype)fail('invalid_selection');
  const fields=Object.keys(input),name='name' in input?input.name:fallback;
  serviceRefSchema.parse({id:name,apiVersion:'1'});
  if(kind==='single'){
    if(fields.length)fail('invalid_selection');
    return {name:fallback};
  }
  if(kind==='collection'){
    if(fields.length!==1||fields[0]!=='name')fail('invalid_selection');
    return {name:name!};
  }
  const order='order' in input?input.order:undefined;
  if(fields.length!==2||!fields.includes('name')||!fields.includes('order')||!Number.isSafeInteger(order))fail('invalid_selection');
  return {name:name!,order:order!};
}

/** One host's extension metadata adapter, not another DI/value container or
 * authorization registry. All values stay in Cordis; all scopes, exact leases,
 * required-dependent teardown and late-result fences remain H04's authority.
 * Domain services must still revalidate their actual grants at sensitive calls
 * and commits. Selecting an implementation never creates such a grant. */
export class ExtensionHost {
  private readonly points=new Map<string,PointRecord>();
  constructor(private readonly host:PluginHost){}
  private native(options:NativeOptions,required:readonly ServiceBinding[],provided:readonly ServiceRef[],factory:PluginDefinition['factory']):PluginDefinition{
    const requires=[...(options.requires??[]),...required];
    return {identity:options.identity,contributions:[...(options.contributions??[]),...provided],requires:[...new Map(requires.map(binding=>[key(binding),binding])).values()],
      ...(options.optional?{optional:options.optional}:{}),...(options.restartRequired!==undefined?{restartRequired:options.restartRequired}:{}),factory};
  }
  private point<T,K extends ExtensionKind>(point:ExtensionPoint<T,K>,kind?:ExtensionKind){
    const contract=pinContract(point.contract),record=this.points.get(key(point.binding));
    if(!record||!record.active)fail('unknown_member');
    if(record.kind!==contract.kind||kind&&kind!==record.kind||record.service.id!==contract.service.id||record.service.apiVersion!==contract.service.apiVersion)fail('invalid_selection');
    record.scope.assertCurrent();
    return record;
  }
  private async acquire<T>(context:HostPluginContext,contract:ServiceContract<T>,binding:ServiceBinding){
    const lease=await context.services.acquire(contract,binding);
    try{context.scope.defer(()=>lease.release());context.scope.assertCurrent();lease.assertCurrent();return lease;}
    catch(error){await lease.release();throw error;}
  }
  private async definition<T,K extends ExtensionKind>(context:HostPluginContext,point:ExtensionPoint<T,K>){
    const lease=await this.acquire(context,point.contract.definition,point.binding),value=lease.value;
    if(value.kind!==point.contract.kind||value.service.id!==point.contract.service.id||value.service.apiVersion!==point.contract.service.apiVersion)fail('invalid_selection');
  }
  async define<T,K extends ExtensionKind>(options:DefineExtensionOptions<T,K>){
    const contract=pinContract(options.contract),contributionId=options.contributionId,factory=options.factory;
    let point!:ExtensionPoint<T,K>,record!:PointRecord;
    const handle=await this.host.install(this.native(options,[],[{id:contributionId,apiVersion:contract.definition.apiVersion}],async context=>{
      const binding=context.provide(contributionId,contract.definition,Object.freeze<ExtensionDefinition>({kind:contract.kind,service:contract.service}));
      point=Object.freeze({contract,binding});record={kind:contract.kind,service:contract.service,scope:context.scope,members:new Map(),active:false};
      const identity=key(binding);this.points.set(identity,record);
      context.scope.retire(()=>{if(this.points.get(identity)===record)this.points.delete(identity);});
      return factory?await factory(context):lifecycle;
    }));
    record.scope.assertCurrent();record.active=true;
    return Object.freeze({point,handle});
  }
  async provide<T,K extends ExtensionKind>(point:ExtensionPoint<T,K>,options:ProvideExtensionOptions<T,K>){
    point=pinPoint(point);
    const record=this.point(point),details=publication(record.kind,options.publication,options.contributionId),factory=options.factory,contributionId=options.contributionId;
    let member!:MemberRecord;
    const handle=await this.host.install(this.native(options,[point.binding],[{id:contributionId,apiVersion:point.contract.service.apiVersion}],async context=>{
      await this.definition(context,point);
      const namespace=Object.freeze({scope:context.scope.identity,contributionId}),identity=memberKey({namespace,name:details.name});
      if(record.members.has(identity))fail('duplicate_member');
      const result=await factory(context);context.scope.assertCurrent();record.scope.assertCurrent();
      const binding=context.provide(contributionId,point.contract.service,result.value);
      member={info:Object.freeze({namespace,name:details.name,binding,...('order' in details?{order:details.order}:{})}),scope:context.scope,active:false};
      record.members.set(identity,member);
      context.scope.retire(()=>{if(record.members.get(identity)===member)record.members.delete(identity);});
      return result.lifecycle;
    }));
    member.scope.assertCurrent();member.active=true;
    return Object.freeze({member:member.info,handle});
  }
  /** Registered metadata only. Acquiring/installing still checks actual H04
   * availability. A projection is never proof of an open resource or grant. */
  members<T,K extends ExtensionKind>(point:ExtensionPoint<T,K>){
    return Object.freeze([...this.point(point).members.values()].filter(member=>member.active&&!member.scope.signal.aborted).map(member=>member.info)
      .sort((a,b)=>key(a.binding)<key(b.binding)?-1:key(a.binding)>key(b.binding)?1:0));
  }
  private selected<T,K extends ExtensionKind>(point:ExtensionPoint<T,K>,bindings:readonly ServiceBinding[],kind:ExtensionKind){
    this.point(point,kind);
    if(new Set(bindings.map(key)).size!==bindings.length)fail('invalid_selection');
    const members=this.members(point);
    return bindings.map(binding=>{const member=members.find(member=>key(member.binding)===key(binding));if(!member)fail('unknown_member');return member;});
  }
  private installConsumer<T,K extends ExtensionKind,S>(point:ExtensionPoint<T,K>,members:readonly ExtensionMember[],options:ExtensionConsumerOptions<S>,selection:(leases:readonly ExtensionLeaseMember<T>[])=>S):Promise<PluginHandle>{
    const factory=options.factory;
    return this.host.install(this.native(options,[point.binding,...members.map(member=>member.binding)],[],async context=>{
      await this.definition(context,point);
      const leases:ExtensionLeaseMember<T>[]=[];
      for(const member of members)leases.push(Object.freeze({...member,lease:await this.acquire(context,point.contract.service,member.binding)}));
      context.scope.assertCurrent();
      return factory(context,selection(Object.freeze(leases)));
    }));
  }
  single<T>(point:ExtensionPoint<T,'single'>,binding:ServiceBinding,options:ExtensionConsumerOptions<ServiceLease<T>>){
    point=pinPoint(point);
    this.point(point,'single');
    if(!binding)fail(this.members(point).length>1?'ambiguous_binding':'binding_required');
    const members=this.selected(point,[binding],'single');
    return this.installConsumer(point,members,options,leases=>leases[0]!.lease);
  }
  collection<T>(point:ExtensionPoint<T,'collection'>,bindings:readonly ServiceBinding[],options:ExtensionConsumerOptions<readonly ExtensionLeaseMember<T>[]>) {
    point=pinPoint(point);
    const members=this.selected(point,bindings,'collection').sort((a,b)=>memberKey(a)<memberKey(b)?-1:memberKey(a)>memberKey(b)?1:0);
    return this.installConsumer(point,members,options,leases=>leases);
  }
  chain<T>(point:ExtensionPoint<T,'ordered'>,bindings:readonly ServiceBinding[],options:ExtensionConsumerOptions<readonly ExtensionLeaseMember<T>[]>) {
    point=pinPoint(point);
    const members=this.selected(point,bindings,'ordered').sort((a,b)=>(a.order!-b.order!)||(key(a.binding)<key(b.binding)?-1:key(a.binding)>key(b.binding)?1:0));
    return this.installConsumer(point,members,options,leases=>leases);
  }
}
