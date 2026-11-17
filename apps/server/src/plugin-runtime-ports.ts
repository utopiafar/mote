import type {BackgroundModelAuthorization,ModelConnection,ModelDisclosure,ModelAuthorityView} from './background-model-authorization.js';
import type {ModelAuthorizationHost} from './model-authorization-host.js';
import type {Connections,ConnectionCredential} from './connections.js';
import type {IngressService} from './ingress.js';
import type {LoginHandoffs} from './login-handoffs.js';
import type {ExecutionEngine,ExecutionHandler,ExecutionStep} from './execution-engine.js';
import type {ProviderAdmission} from './provider-admission.js';
import type {Operations} from './operations.js';

type Control=BackgroundModelAuthorization;
type Host=ModelAuthorizationHost;
type Conn=Connections;
type Ingress=IngressService;
type Handoffs=LoginHandoffs;
type Engine=ExecutionEngine;
type Admission=ProviderAdmission;
type Ops=Operations;

/** Fixed host-bound capabilities. Runtime objects are frozen function-only
 * closures over the exact instance created by the Vault; no class, Store, DB,
 * getter, prototype method or mutable service bag escapes. */
export interface AuthorizationControlPort {
  view:Control['view']; assertCurrent:Control['assertCurrent']; assertDisclosure:Control['assertDisclosure'];
  allowsDisclosure:Control['allowsDisclosure']; capture:Control['capture']; manual:Control['manual'];
  manualCommand:Control['manualCommand']; run:Control['run']; workState:Control['workState'];
  currentId():string|undefined; ownerIntent:Control['ownerIntent']; assertOwnerIntent:Control['assertOwnerIntent'];
  deniedOriginal:Control['deniedOriginal']; bindBatchStop:Control['bindBatchStop'];
  automaticCommand:Control['automaticCommand']; commitStep:Control['commitStep']; inheritStep:Control['inheritStep'];
  bindCurrentStep:Control['bindCurrentStep']; stepAuthority:Control['stepAuthority']; freshTriggers:Control['freshTriggers'];
  receiveRoutineOccurrence:Control['receiveRoutineOccurrence'];
}
export interface AuthorizationControlInternal extends AuthorizationControlPort {
  command:Control['command']; revalidateActive:Control['revalidateActive']; close:Control['close'];
}
export interface AuthorizationHostPort {
  capture:Host['capture']; source:Host['source']; conversation:Host['conversation'];
  evidenceTriggers:Host['evidenceTriggers']; queryTriggers:Host['queryTriggers']; disclosure:Host['disclosure'];
  assertEvidence:Host['assertEvidence']; automatic:Host['automatic']; manual:Host['manual'];
  control():AuthorizationControlPort;
}
export interface ConnectionsPort {
  invite:Conn['invite']; cancelInvitation:Conn['cancelInvitation']; redeem:Conn['redeem'];
  authenticate:Conn['authenticate']; assertActive:Conn['assertActive']; publicCredential:Conn['publicCredential'];
  inventory:Conn['inventory']; revoke:Conn['revoke']; mintMcp:Conn['mintMcp']; mintDeveloper:Conn['mintDeveloper'];
  mintMcpOAuth:Conn['mintMcpOAuth']; rotateMcpOAuth:Conn['rotateMcpOAuth']; mcpAuthorization:Conn['mcpAuthorization'];
  isOwner:Conn['isOwner']; hasActiveDeveloper:Conn['hasActiveDeveloper']; session:Conn['session'];
  assertCollectorRoute:Conn['assertCollectorRoute']; assertOwnDevice:Conn['assertOwnDevice']; assertPlatform:Conn['assertPlatform'];
  assertOwnSource:Conn['assertOwnSource']; assertCapture:Conn['assertCapture']; routes:Conn['routes'];
  /** Fixed Vault identity check; never returns Store or grants access. */
  sameVault(store:unknown):boolean;
}
export interface ConnectionsInternal extends ConnectionsPort {
  init:Conn['init']; onChange:Conn['onChange']; bindRoutes:Conn['bindRoutes']; close:Conn['close'];
}
export interface IngressPort { capture:Ingress['capture']; captureSettled:Ingress['captureSettled']; sourceItem:Ingress['sourceItem']; sourceBatch:Ingress['sourceBatch']; }
export interface HandoffsPort {
  ticket:Handoffs['ticket']; exchange:Handoffs['exchange']; create:Handoffs['create']; detail:Handoffs['detail'];
  approve:Handoffs['approve']; reject:Handoffs['reject']; poll:Handoffs['poll']; close:Handoffs['close'];
}
export interface ExecutionPort {
  closed():boolean; bindObserver:Engine['bindObserver']; configurePool:Engine['configurePool']; poolSnapshot:Engine['poolSnapshot'];
  register:Engine['register']; enqueue:Engine['enqueue']; recordCancellation:Engine['recordCancellation']; get:Engine['get'];
  failure:Engine['failure']; failureDiagnostics:Engine['failureDiagnostics']; list:Engine['list']; project:Engine['project'];
  deferLocalEffects:Engine['deferLocalEffects']; localEffect:Engine['localEffect']; cancel:Engine['cancel'];
  bindCancellationAlias:Engine['bindCancellationAlias']; cancellationAliasRevoked:Engine['cancellationAliasRevoked'];
  fail:Engine['fail']; cancelKind:Engine['cancelKind']; retry:Engine['retry']; recoverAttemptCount:Engine['recoverAttemptCount'];
  abortLocal:Engine['abortLocal']; isCurrentGrant:Engine['isCurrentGrant']; isCurrentInputGrant:Engine['isCurrentInputGrant'];
  isCurrentInputAuthority:Engine['isCurrentInputAuthority']; isActiveStep:Engine['isActiveStep']; drain:Engine['drain'];
  tick:Engine['tick']; runStep:Engine['runStep']; close:Engine['close'];
  /** Fixed Vault identity check; never returns Store or grants access. */
  sameVault(store:unknown):boolean;
}
export interface AdmissionPort { check:Admission['check']; run:Admission['run']; snapshot:Admission['snapshot']; }
export interface OperationsPort { page:Ops['page']; detail:Ops['detail']; changes:Ops['changes']; }
export interface ExecutionModelAuthority {
  captureStep(step:ExecutionStep):void; assertStep(step:ExecutionStep):void;
  commitStep<T>(step:ExecutionStep,task:()=>T):T;
  runStep<T>(step:ExecutionStep,task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>;
}

type FunctionName<T>=Extract<keyof T,string>;
const bindFunctions=<T extends object>(target:T,names:readonly FunctionName<T>[])=>{
  const result:Record<string,unknown>={};
  for(const name of names){const value=(target as unknown as Record<string,unknown>)[name];if(typeof value!=='function')throw Error('Capability method is unavailable');result[name]=(...args:unknown[])=>(value as (...input:unknown[])=>unknown).apply(target,args);}
  return Object.freeze(result);
};
const controlMethods=['view','assertCurrent','assertDisclosure','allowsDisclosure','capture','manual','manualCommand','run','workState','ownerIntent','assertOwnerIntent','deniedOriginal','bindBatchStop','automaticCommand','commitStep','inheritStep','bindCurrentStep','stepAuthority','freshTriggers','receiveRoutineOccurrence'] as const;
const controlInternalMethods=[...controlMethods,'command','revalidateActive','close'] as const;
const hostMethods=['capture','source','conversation','evidenceTriggers','queryTriggers','disclosure','assertEvidence','automatic','manual'] as const;
const connectionsMethods=['invite','cancelInvitation','redeem','authenticate','assertActive','publicCredential','inventory','revoke','mintMcp','mintDeveloper','mintMcpOAuth','rotateMcpOAuth','mcpAuthorization','isOwner','hasActiveDeveloper','session','assertCollectorRoute','assertOwnDevice','assertPlatform','assertOwnSource','assertCapture','routes'] as const;
const connectionsInternalMethods=[...connectionsMethods,'init','onChange','bindRoutes','close'] as const;
const ingressMethods=['capture','captureSettled','sourceItem','sourceBatch'] as const;
const handoffMethods=['ticket','exchange','create','detail','approve','reject','poll','close'] as const;
const executionMethods=['bindObserver','configurePool','poolSnapshot','register','enqueue','recordCancellation','get','failure','failureDiagnostics','list','project','deferLocalEffects','localEffect','cancel','bindCancellationAlias','cancellationAliasRevoked','fail','cancelKind','retry','recoverAttemptCount','abortLocal','isCurrentGrant','isCurrentInputGrant','isCurrentInputAuthority','isActiveStep','drain','tick','runStep','close'] as const;
const admissionMethods=['check','run','snapshot'] as const;
const operationsMethods=['page','detail','changes'] as const;

export function authorizationControlPort(control:Control):AuthorizationControlPort{
  const functions=bindFunctions(control,controlMethods) as unknown as AuthorizationControlPort;
  return Object.freeze({...functions,currentId:()=>control.currentId}) as AuthorizationControlPort;
}
export function authorizationControlInternal(control:Control):AuthorizationControlInternal{
  return Object.freeze({...bindFunctions(control,controlInternalMethods),currentId:()=>control.currentId}) as AuthorizationControlInternal;
}
export function authorizationHostPort(host:Host,control:AuthorizationControlPort):AuthorizationHostPort{
  return Object.freeze({...bindFunctions(host,hostMethods),control:()=>control}) as AuthorizationHostPort;
}
export function connectionsPort(connections:Conn):ConnectionsPort{return Object.freeze({...bindFunctions(connections,connectionsMethods),sameVault:(store:unknown)=>connections.usesStore(store as never)}) as ConnectionsPort;}
export function connectionsInternal(connections:Conn):ConnectionsInternal{return Object.freeze({...bindFunctions(connections,connectionsInternalMethods),sameVault:(store:unknown)=>connections.usesStore(store as never)}) as ConnectionsInternal;}
export function ingressPort(ingress:Ingress):IngressPort{return bindFunctions(ingress,ingressMethods) as unknown as IngressPort;}
export function handoffsPort(handoffs:Handoffs):HandoffsPort{return bindFunctions(handoffs,handoffMethods) as unknown as HandoffsPort;}
export function executionPort(engine:Engine):ExecutionPort{
  const functions=bindFunctions(engine,executionMethods) as unknown as ExecutionPort;
  return Object.freeze({...functions,closed:()=>engine.closed,sameVault:(store:unknown)=>engine.store===store}) as ExecutionPort;
}
export function admissionPort(admission:Admission):AdmissionPort{return bindFunctions(admission,admissionMethods) as unknown as AdmissionPort;}
export function operationsPort(operations:Ops):OperationsPort{return bindFunctions(operations,operationsMethods) as unknown as OperationsPort;}
export type {ExecutionHandler,ConnectionCredential};
