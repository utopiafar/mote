import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {QueryInput} from '@mote/agent';
import {calendarExpired,isCentralConnectorActionTarget,type ActionProposal,type CentralConnectorActionTarget,type ExternalCalendarOrigin} from '@mote/shared';
import type {Actions} from './actions.js';
import {ConnectionError,type Connections,type McpCalendarGrant} from './connections.js';
import {ConnectorError} from './connectors/types.js';
import type {EvidenceStore} from './evidence-store.js';
import {externalCalendarCreateSchema,type ExternalCalendarContext,type ExternalCalendarCreate,type ExternalCalendarReceipt,type ExternalCalendarReview} from './external-calendar-contract.js';
import {moteText} from './i18n.js';
import type {ActionCapabilities} from './plugins/action-capabilities.js';
import {decodeMemoryPrivate,encodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {recipeFingerprint} from './recipe-contract.js';

export interface ExternalCalendarAuthority {
  enabled:()=>boolean;
  review:ExternalCalendarReview;
  assertContext:(input:QueryInput)=>void;
}
type Admission={
  actionId:string;
  inputHash:string;
  eventHash:string;
  context:ExternalCalendarContext;
};
const receiptKey=({connectionId,requestId}:ExternalCalendarOrigin)=>`external-calendar:${connectionId}:${requestId}`;
const unavailable=()=>new ConnectorError('calendar_target_unavailable',409);
const conflict=()=>new ConnectorError('calendar_request_conflict',409);

/** The connection pins one target. Only an accepted current instruction can
 * add a create to the regular Actions queue for that target. */
export class ExternalCalendarActions {
  private readonly pending=new Map<string,{inputHash:string;work:Promise<ExternalCalendarReceipt>}>();
  private readonly stop=new AbortController();

  constructor(
    private readonly store:EvidenceStore,
    private readonly actions:Actions,
    private readonly capabilities:Pick<ActionCapabilities,'centralConnectors'|'resolveCentralTarget'>,
    private readonly connections:Connections,
    private readonly authority:ExternalCalendarAuthority,
    private readonly wake:(actionId:string)=>void,
  ){}

  targets(){
    if(!this.authority.enabled())return [];
    return this.capabilities.centralConnectors().filter(({target})=>Boolean(target.calendarId)&&target.capabilityId==='calendar.manage'&&target.capabilityVersion===1);
  }
  mint(raw:unknown,assertOwner:()=>void){
    return this.connections.mintMcpCalendar(raw,target=>{
      assertOwner();
      if(!this.authority.enabled())throw new ConnectionError('mcp_disabled',409,moteText('在 mote.yaml 配置 connectors.mcpReadToken 并开启 connectors.mcpEnabled，再重启节点。'));
      const choice=this.targets().find(choice=>isDeepStrictEqual(choice.target,target));
      const provider=choice&&this.capabilities.resolveCentralTarget(target);
      if(!choice||!provider)throw new ConnectionError('calendar_target_unavailable',409,moteText('目标连接器不可用，刷新后重试'));
      return {target,name:choice.name,identity:provider.identity};
    });
  }
  private grant(connectionId:string){
    if(!this.authority.enabled())throw new ConnectorError('mcp_disabled',503);
    try{
      const grant=this.connections.mcpCalendarGrant(connectionId);
      if(grant)return grant;
    }catch(error){
      if(!(error instanceof ConnectionError))throw error;
    }
    throw new ConnectorError('connection_revoked',401);
  }
  private targetCurrent(grant:McpCalendarGrant){
    const provider=this.capabilities.resolveCentralTarget(grant.target);
    return Boolean(provider&&isDeepStrictEqual(provider.identity,grant.identity));
  }
  target(connectionId:string){
    const grant=this.grant(connectionId);
    return {calendarName:grant.name,available:this.targetCurrent(grant)};
  }
  private read(origin:ExternalCalendarOrigin){
    const row=this.store.db.prepare('SELECT json FROM action_meta WHERE key=?').get(receiptKey(origin));
    return row?decodeMemoryPrivate<Admission>(this.store,JSON.parse(String(row.json)).private):undefined;
  }
  private present(origin:ExternalCalendarOrigin,record:Admission):ExternalCalendarReceipt{
    const action=this.actions.get(record.actionId);
    if(action.kind!=='calendar.create'||!isDeepStrictEqual(action.externalCalendar,origin)||!action.operationId)throw new ConnectorError('calendar_receipt_unavailable',409);
    return {
      requestId:origin.requestId,actionId:action.id,operationId:action.operationId,status:action.status,
      ...(action.status==='succeeded'&&action.externalId?{externalId:action.externalId}:{}),
    };
  }
  receipt(connectionId:string,requestId:string){
    this.grant(connectionId);
    const origin={connectionId,requestId},record=this.read(origin);
    if(!record)throw new ConnectorError('calendar_receipt_not_found',404);
    return this.present(origin,record);
  }
  async create(connectionId:string,raw:ExternalCalendarCreate,signal:AbortSignal){
    const {requestId,instruction,event}=externalCalendarCreateSchema.parse(raw);
    const origin={connectionId,requestId},key=receiptKey(origin),inputHash=recipeFingerprint({instruction,event});
    const grant=this.grant(connectionId),prior=this.read(origin);
    if(prior){
      if(prior.inputHash!==inputHash)throw conflict();
      return this.present(origin,prior);
    }
    const pending=this.pending.get(key);
    if(pending){
      if(pending.inputHash!==inputHash)throw conflict();
      return pending.work;
    }
    const currentSignal=AbortSignal.any([signal,this.stop.signal]);
    const assertCurrent=()=>{
      currentSignal.throwIfAborted();
      if(!isDeepStrictEqual(grant,this.grant(connectionId))||!this.targetCurrent(grant)||calendarExpired(event))throw unavailable();
    };
    assertCurrent();
    const work=(async()=>{
      const context=await this.authority.review({instruction,event,calendarName:grant.name,signal:currentSignal,assertCurrent});
      if(!context)throw new ConnectorError('calendar_instruction_not_authorized',409);
      assertCurrent();
      const admission=this.accept(origin,{actionId:randomUUID(),inputHash,eventHash:recipeFingerprint(event),context},event,grant.target);
      this.wake(admission.actionId);
      return admission;
    })();
    this.pending.set(key,{inputHash,work});
    try{return await work;}finally{this.pending.delete(key);}
  }
  private accept(origin:ExternalCalendarOrigin,record:Admission,event:ExternalCalendarCreate['event'],target:CentralConnectorActionTarget){
    const db=this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.read(origin);
      if(prior){
        if(prior.inputHash!==record.inputHash)throw conflict();
        const result=this.present(origin,prior);
        db.exec('COMMIT');
        return result;
      }
      db.prepare('INSERT INTO action_meta VALUES(?,?)').run(receiptKey(origin),JSON.stringify({private:encodeMemoryPrivate(this.store,record)}));
      const action=this.actions.proposeExternalCalendar(record.actionId,event,target,origin);
      this.actions.confirm(action.id,{version:action.version,event:action.event,target:action.target});
      const result=this.present(origin,record);
      db.exec('COMMIT');
      return result;
    }catch(error){
      if(db.isTransaction)db.exec('ROLLBACK');
      throw error;
    }
  }
  current(action:ActionProposal){
    const origin=action.externalCalendar;
    if(!origin||action.kind!=='calendar.create'||action.evidence.length||action.ownerInstruction||action.related||
      !isCentralConnectorActionTarget(action.target)||calendarExpired(action.event))return false;
    try{
      const grant=this.grant(origin.connectionId),record=this.read(origin);
      if(record?.actionId!==action.id||record.eventHash!==recipeFingerprint(action.event)||!isDeepStrictEqual(grant.target,action.target)||!this.targetCurrent(grant))return false;
      this.authority.assertContext({question:'',executionLane:'interactive',...record.context});
      return true;
    }catch{return false;}
  }
  quiesce(){
    this.stop.abort();
  }
  async close(){
    this.quiesce();
    await Promise.allSettled([...this.pending.values()].map(({work})=>work));
  }
}
