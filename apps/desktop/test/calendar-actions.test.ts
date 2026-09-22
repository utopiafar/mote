import {describe,it,expect} from 'vitest';
import {CalendarActions,type CalendarActionIO} from '../src/calendar-actions';
const id='11111111-1111-4111-8111-111111111111',operationId='22222222-2222-4222-8222-222222222222';
const action={id,operationId,mutationAllowed:true,kind:'calendar.create',status:'executing',target:{deviceId:'mac',calendarId:'existing'},event:{title:'合成评审',start:'2099-09-18T15:00:00+08:00',end:'2099-09-18T16:00:00+08:00',timeZone:'Asia/Shanghai',allDay:false,location:'',description:''}};
describe('calendar execution fixtures (no real calendar access)',()=>{
 it('lost HTTP receipt retries the ledger without another native insertion',async()=>{const ledger=new Map<string,string>();let inserts=0,receipts=0;const io:CalendarActionIO={request:async path=>{if(path.endsWith('claim'))return action;if(++receipts===1)throw Error('offline');return {};},native:async(_c,input:any)=>{expect(input.description).toContain(`[Mote:${id}]`);inserts++;return {externalId:'fixture-event'};},read:async k=>ledger.get(k),write:async(k,v)=>{ledger.set(k,v);}};const client=new CalendarActions({deviceId:'mac',deviceName:'合成 Mac'},io);await expect(client.execute(id)).rejects.toThrow();await client.execute(id);expect(inserts).toBe(1);expect(ledger.get(operationId)).toBe('fixture-event');});
 it('crash after starting native write may only reconcile, including across process restart',async()=>{const ledger=new Map<string,string>();const allowed:boolean[]=[];const io:CalendarActionIO={request:async path=>path.endsWith('claim')?action:{},native:async(_c,input:any)=>{allowed.push(input.createAllowed);throw Error('process stopped');},read:async k=>ledger.get(k),write:async(k,v)=>{ledger.set(k,v);}};await expect(new CalendarActions({deviceId:'mac',deviceName:'fixture'},io).execute(id)).rejects.toThrow();await expect(new CalendarActions({deviceId:'mac',deviceName:'fixture'},io).execute(id)).rejects.toThrow();expect(allowed).toEqual([true,false]);});
 it('refuses a foreign device and serializes double clicks',async()=>{const ledger=new Map<string,string>();let count=0;const io:CalendarActionIO={request:async()=>action,native:async()=>{count++;return {externalId:'fixture'};},read:async k=>ledger.get(k),write:async(k,v)=>{ledger.set(k,v);}};const client=new CalendarActions({deviceId:'mac',deviceName:'fixture'},io);const secondWindow=new CalendarActions({deviceId:'mac',deviceName:'fixture'},io);await Promise.all([client.execute(id),secondWindow.execute(id)]);expect(count).toBe(1);await expect(new CalendarActions({deviceId:'other',deviceName:'fixture'},io).execute(id)).rejects.toThrow();});
});

describe('calendar update execution fixtures',()=>{
 it('updates only the host-pinned original event and keeps its stable origin marker',async()=>{
  const root='33333333-3333-4333-8333-333333333333',ledger=new Map<string,string>(),calls:any[]=[];
  const changed={...action,kind:'calendar.update',related:{actionId:root,version:2,status:'succeeded',event:{...action.event},target:action.target,externalId:'original-calendar-event'}};
  const io:CalendarActionIO={request:async path=>path.endsWith('claim')?changed:{},native:async(command,input:any)=>{calls.push({command,...input});return {externalId:'original-calendar-event'};},read:async k=>ledger.get(k),write:async(k,v)=>{ledger.set(k,v);}};
  await new CalendarActions({deviceId:'mac',deviceName:'fixture'},io).execute(id);
  expect(calls).toHaveLength(1);expect(calls[0].command).toBe('calendar-change');expect(calls[0].externalId).toBe('original-calendar-event');expect(calls[0].id).toBe(root);expect(calls[0].description).toContain(`[Mote:${root}]`);expect(calls[0].description).toContain(`[Mote-operation:${operationId}]`);expect(calls[0].expected.description).toContain(`[Mote:${root}]`);expect(calls[0].expected.description).not.toContain('Mote-operation');
 });
 it('a lost cancel receipt uses the completed ledger, and an interrupted native change only reconciles',async()=>{
  const ledger=new Map<string,string>(),allowed:boolean[]=[];let fail=true;
  const changed={...action,kind:'calendar.cancel',related:{actionId:id,version:2,status:'succeeded',event:action.event,target:action.target,externalId:'original'}};
  const io:CalendarActionIO={request:async path=>path.endsWith('claim')?changed:{},native:async(command,input:any)=>{expect(command).toBe('calendar-change');allowed.push(input.mutationAllowed);if(fail)throw Error('interrupted');return {externalId:'original'};},read:async k=>ledger.get(k),write:async(k,v)=>{ledger.set(k,v);}};
  const client=new CalendarActions({deviceId:'mac',deviceName:'fixture'},io);await expect(client.execute(id)).rejects.toThrow();fail=false;await client.execute(id);await client.execute(id);expect(allowed).toEqual([true,false]);
 });
 it('a mutation cannot substitute the original device or calendar',async()=>{
  let writes=0;const changed={...action,kind:'calendar.update',related:{actionId:id,version:2,status:'succeeded',event:action.event,target:{deviceId:'mac',calendarId:'different'},externalId:'original'}};
  const io:CalendarActionIO={request:async()=>changed,native:async()=>{writes++;return{};},read:async()=>undefined,write:async()=>{}};await expect(new CalendarActions({deviceId:'mac',deviceName:'fixture'},io).execute(id)).rejects.toThrow();expect(writes).toBe(0);
 });
});

it('loss of the local ledger never grants a second host write for uncertain or re-claimed operations',async()=>{
 for(const kind of ['calendar.create','calendar.update','calendar.cancel']){
  const allowed:boolean[]=[];const reclaimed={...action,kind,status:'uncertain',mutationAllowed:false,...(kind==='calendar.create'?{}:{related:{actionId:id,version:2,status:'succeeded',event:action.event,target:action.target,externalId:'original'}})};
  const io:CalendarActionIO={request:async path=>path.endsWith('claim')?reclaimed:{},native:async(_command,input:any)=>{allowed.push(input.createAllowed??input.mutationAllowed);throw Error('Only reconcile');},read:async()=>undefined,write:async()=>{}};
  await expect(new CalendarActions({deviceId:'mac',deviceName:'fixture'},io).execute(id)).rejects.toThrow();expect(allowed).toEqual([false]);
 }
});
