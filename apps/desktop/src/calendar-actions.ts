import { moteText } from '@mote/shared/i18n';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {moteActionMarker,calendarEventSchema,calendarDescription,type ActionProposal} from '@mote/shared/actions';
import {calendarHelper} from './source-calendar';
import {validateServerUrl} from './config';
import type {Config} from './contracts';
export interface CalendarActionIO {request:(path:string,body?:unknown)=>Promise<any>;native:(command:'calendar-permission'|'calendar-create'|'calendar-change',input?:unknown)=>Promise<any>;read:(key:string)=>Promise<string|undefined>;write:(key:string,value:string)=>Promise<void>}
/** Native ledger is written before creation; a crash can only reconcile, never blindly insert again. */
const executionQueues=new Map<unknown,Promise<unknown>>();
export class CalendarActions {
 constructor(private config:Pick<Config,'deviceId'|'deviceName'>,private io:CalendarActionIO,private queueKey:unknown=io){}
 connect(){return this.serial(async()=>{const value=await this.io.native('calendar-permission');if(value.permission!=='granted')throw Error(moteText("请允许日历访问后重试"));await this.io.request('/api/actions/targets',{deviceId:this.config.deviceId,deviceName:this.config.deviceName,calendars:value.calendars.filter((c:any)=>c.writable===true).map((c:any)=>({id:c.id,title:c.title}))});await this.io.write('enabled','1');return {deviceId:this.config.deviceId};});}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const task=(executionQueues.get(this.queueKey)??Promise.resolve()).catch(()=>{}).then(fn);executionQueues.set(this.queueKey,task);void task.finally(()=>{if(executionQueues.get(this.queueKey)===task)executionQueues.delete(this.queueKey);}).catch(()=>{});return task;}
 async deliver(){if(await this.io.read('enabled')!=='1')return;const data=await this.io.request('/api/actions/deliveries?deviceId='+encodeURIComponent(this.config.deviceId));for(const a of data.items)await this.execute(a.id);}
 execute(id:string){return this.serial(async()=>{
  if(!/^[0-9a-f-]{36}$/i.test(id))throw Error(moteText("日程编号无效"));
  const action=await this.io.request(`/api/actions/${id}/claim`,{deviceId:this.config.deviceId}) as ActionProposal&{mutationAllowed?:boolean};
  if(action.id!==id||!['calendar.create','calendar.update','calendar.cancel'].includes(action.kind)||action.target?.deviceId!==this.config.deviceId||!action.operationId)throw Error(moteText("日程确认信息无效"));
  moteActionMarker(action.operationId);
  if(action.status==='succeeded')return;
  if(!['executing','uncertain'].includes(action.status))throw Error(moteText("日程尚未获准执行"));
  calendarEventSchema.parse(action.event);if(action.kind!=='calendar.create'&&(!action.related?.externalId||action.related.target?.deviceId!==this.config.deviceId||action.related.target.calendarId!==action.target.calendarId))throw Error(moteText('原日程确认信息无效'));
  const previous=await this.io.read(action.operationId);let externalId=previous&&previous!=='attempting'?previous:undefined;
  try{
   if(!externalId){await this.io.write(action.operationId,'attempting');const result=action.kind==='calendar.create'?await this.io.native('calendar-create',{id:action.id,calendarId:action.target.calendarId,...action.event,description:calendarDescription(action),createAllowed:action.mutationAllowed===true&&!previous}):await this.io.native('calendar-change',{id:action.related!.actionId,operationId:action.operationId,kind:action.kind,externalId:action.related!.externalId,calendarId:action.target.calendarId,...action.event,description:calendarDescription(action),expected:{...action.related!.event,description:calendarDescription({id:action.related!.actionId,event:action.related!.event,operationId:action.related!.operationId})},mutationAllowed:action.mutationAllowed===true&&!previous});if(typeof result.externalId!=='string'||!result.externalId)throw Error(moteText("保存结果待核实，请查看系统日历后重试"));externalId=result.externalId;await this.io.write(action.operationId,externalId!);}
   await this.io.request(`/api/actions/${id}/receipt`,{deviceId:this.config.deviceId,operationId:action.operationId,status:'succeeded',externalId});
  }catch{await this.io.request(`/api/actions/${id}/receipt`,{deviceId:this.config.deviceId,operationId:action.operationId,status:'uncertain'}).catch(()=>{});throw Error(moteText("保存结果待核实。请检查日历权限与网络后再次核实；不会重复插入。"));}
 });}
}
export function nativeCalendarActions(config:Config,helper:string,directory:string){
 const origin=validateServerUrl(config.serverUrl),root=join(directory,'calendar-actions',createHash('sha256').update(origin+config.deviceId).digest('hex'));
 return new CalendarActions(config,{
  async request(path,body){const r=await fetch(origin+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(moteText("中央日程操作失败，请刷新或重新授权"));return r.json();},
  native:(command,input)=>calendarHelper(helper,command,input),
  async read(key){try{return await readFile(join(root,key),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}},
  async write(key,value){await mkdir(root,{recursive:true,mode:0o700});const path=join(root,key);await writeFile(path+'.tmp',value,{mode:0o600,flush:true});await rename(path+'.tmp',path);},
 },root);
}
