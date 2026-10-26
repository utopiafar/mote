import {it,expect} from 'vitest';
import {CalendarActions,type CalendarActionIO} from '../src/calendar-actions';

it('connecting publishes only writable calendars and background permission loss does not prompt or claim',async()=>{
 let permission='granted',declaration:any=null;const commands:string[]=[],requests:string[]=[];const ledger=new Map<string,string>();
 const io:CalendarActionIO={
  native:async command=>{commands.push(command);return {permission,calendars:permission==='granted'?[{id:'generated',title:'Generated',writable:true}]:[]};},
  request:async(path,body:any)=>{requests.push(path);if(path==='/api/connections/self')return {credential:{deviceId:'mac'}};if(path==='/api/device-action-capabilities'){if(body)declaration={...body,revision:body.expectedRevision+1,connectionId:'paired',connectionActive:true};return body?declaration:{connectionId:'paired',declaration};}if(path.startsWith('/api/actions/deliveries'))return {items:[]};return {};},
  read:async key=>ledger.get(key),write:async(key,value)=>{ledger.set(key,value);},
 };
 const client=new CalendarActions({deviceId:'mac',deviceName:'Generated Mac'},io);
 await client.connect();expect(declaration.revision).toBe(1);expect(ledger.get('enabled')).toBe('1');
 await client.deliver();expect(declaration.revision).toBe(1);
 permission='required';requests.length=0;await client.deliver();expect(declaration.permission).toBe('required');expect(declaration.calendars).toEqual([]);expect(declaration.revision).toBe(2);
 expect(commands).toEqual(['calendar-permission','calendar-list','calendar-list']);expect(requests.some(path=>path.includes('/deliveries')||path.includes('/claim'))).toBe(false);
});

it('an unbound owner session preserves manual calendar connection without declaring another device',async()=>{
 const paths:string[]=[];const io:CalendarActionIO={native:async()=>({permission:'granted',calendars:[{id:'generated',title:'Generated',writable:true}]}),request:async path=>{paths.push(path);return {credential:{scope:'owner'}};},read:async()=>undefined,write:async()=>{}};
 await new CalendarActions({deviceId:'mac',deviceName:'Generated Mac'},io).connect();expect(paths).toContain('/api/actions/targets');expect(paths).not.toContain('/api/device-action-capabilities');
});
