import {it,expect} from 'vitest';
import {CalendarActions,type CalendarActionIO} from '../src/calendar-actions';
const id='11111111-1111-4111-8111-111111111111',operation='22222222-2222-4222-8222-222222222222';
function fixture(){
 const disk=new Map<string,string>(),paths:string[]=[];let granted=false,permission='granted',declaration:any,claimed=false,writes=0,offline=false,permissionHook=()=>{};
 const action={id,operationId:operation,kind:'calendar.create',status:'executing',target:{deviceId:'mac',calendarId:'fixture-calendar'},event:{title:'Generated manual event',start:'2099-09-18T15:00:00Z',end:'2099-09-18T16:00:00Z',timeZone:'UTC',allDay:false,location:'',description:''}};
 const io:CalendarActionIO={read:async k=>disk.get(k),write:async(k,v)=>{disk.set(k,v);},native:async(command,input:any)=>{if(command==='calendar-permission'||command==='calendar-list'){if(command==='calendar-permission')permissionHook();return {permission,calendars:permission==='granted'?[{id:'fixture-calendar',title:'Generated',writable:true}]:[]};}expect(input.createAllowed).toBe(true);writes++;return {externalId:'generated-event'};},request:async(path,body:any)=>{
  paths.push(path);if(path==='/api/connections/self')return {credential:{scope:'collector',deviceId:'mac'}};
  if(path==='/api/device-action-capabilities'){if(body)declaration={...body,connectionId:'paired',revision:body.expectedRevision+1,connectionActive:true};return body?declaration:{connectionId:'paired',declaration:declaration??null};}
  if(path==='/api/managed-calendar-deliveries')return {items:granted?[{id,operationId:operation}]:[],manualReviewAllowed:false};
  if(path.endsWith('/claim')){if(!granted)throw Error('No grant');const mutationAllowed=!claimed;claimed=true;return {...action,mutationAllowed};}
  if(path.endsWith('/receipt')){if(offline)throw Error('Generated offline');return {};}
  throw Error('Unexpected route '+path);
 }};
 const config={deviceId:'mac',deviceName:'Generated manual Mac',syncMode:'manual'};
 return {client:()=>new CalendarActions(config,io),paths,get writes(){return writes;},grant:()=>{granted=true;},offline:(v:boolean)=>{offline=v;},permission:(v:string)=>{permission=v;},onPermission:(fn:()=>void)=>{permissionHook=fn;}};
}
it('explicit manual sync connects and delivers an authorized operation once across repeated clicks',async()=>{const f=fixture();f.grant();const client=f.client();await Promise.all([client.connectAndDeliver(()=>false),client.connectAndDeliver(()=>false)]);expect(f.writes).toBe(1);expect(f.paths).toContain('/api/managed-calendar/'+id+'/receipt');});
it('connection failure and lack of execution grant do not execute calendar writes',async()=>{const f=fixture();f.permission('required');await expect(f.client().connectAndDeliver(()=>false)).rejects.toThrow();expect(f.paths.some(p=>p.endsWith('/claim'))).toBe(false);f.permission('granted');await f.client().connectAndDeliver(()=>false);expect(f.writes).toBe(0);});
it('paused sync blocks before connection and a pause during connection blocks delivery',async()=>{const f=fixture();f.grant();await expect(f.client().connectAndDeliver(()=>true)).rejects.toThrow();expect(f.paths).toEqual([]);let paused=false;f.onPermission(()=>{paused=true;});await expect(f.client().connectAndDeliver(()=>paused)).rejects.toThrow();expect(f.paths).not.toContain('/api/managed-calendar-deliveries');expect(f.writes).toBe(0);});
it('manual retry after lost receipt returns the durable receipt without another native insertion',async()=>{const f=fixture();f.grant();f.offline(true);await expect(f.client().connectAndDeliver(()=>false)).rejects.toThrow();expect(f.writes).toBe(1);f.offline(false);await f.client().connectAndDeliver(()=>false);expect(f.writes).toBe(1);});
