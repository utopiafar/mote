import {z} from 'zod';
export const stateSeriesSchema = z.object({version:z.literal(1),samples:z.array(z.object({at:z.string().datetime({offset:true}),durationMs:z.number().int().min(0).max(300000),idleSeconds:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),availableStorageBytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()}).strict()).min(1).max(720)}).strict();
/** Exact state comparison only. Clocks identify observations, not state changes. */
export interface StateSample {at:string;durationMs:number;idleSeconds?:number;availableStorageBytes?:number}
export interface StateSeries {version:1;samples:StateSample[]}
type StateEvent={id:string;deviceId:string;capturedAt:string;durationMs:number;source:string;imageBase64?:string;imageMime?:string|null;ocrText?:string;stateSeries?:StateSeries;metadata?:any};
function canonical(value:any):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function stateOnly(event:StateEvent):boolean {return !event.imageBase64&&!event.imageMime&&!event.ocrText&& (event.source==='activity'||event.source==='screen'&&event.metadata?.capture?.deduplication?.duplicate===true);}
export function stateKey(event:StateEvent):string {
 const {id,capturedAt,durationMs,stateSeries,...rest}=structuredClone(event);
 if(rest.metadata){delete rest.metadata.observedAt;if(rest.metadata.state){delete rest.metadata.state.idleSeconds;delete rest.metadata.state.availableStorageBytes;}if(rest.metadata.observation)delete rest.metadata.observation.elapsedRealtimeMs;if(rest.metadata.media)delete rest.metadata.media.observedAt;}
 return canonical(rest);
}
function observation(event:StateEvent):StateSample {const s=event.metadata?.state;return {at:event.capturedAt,durationMs:event.durationMs,...(s?.idleSeconds===undefined?{}:{idleSeconds:s.idleSeconds}),...(s?.availableStorageBytes===undefined?{}:{availableStorageBytes:s.availableStorageBytes})};}
export function samples(event:StateEvent):StateSample[] {return event.stateSeries?.samples??[observation(event)];}
export function extendState<T extends StateEvent>(previous:T|undefined,next:T):T {
 if(!stateOnly(next))return next;
 const observations=previous?samples(previous):[];const last=observations.at(-1);const gap=last?Date.parse(next.capturedAt)-Date.parse(last.at):Infinity;
 if(previous&&stateOnly(previous)&&stateKey(previous)===stateKey(next)&&gap>0&&gap<=300000&&observations.length<720&&Date.parse(next.capturedAt)-Date.parse(previous.capturedAt)<=21600000){return {...previous,stateSeries:{version:1,samples:[...observations,observation(next)]}};}
 return {...next,stateSeries:{version:1,samples:[observation(next)]}};
}
export function isStateExtension(previous:StateEvent,next:StateEvent):boolean {
 if(!previous.stateSeries||!next.stateSeries||previous.id!==next.id||previous.capturedAt!==next.capturedAt||!stateOnly(next)||stateKey(previous)!==stateKey(next))return false;
 const a=samples(previous),b=samples(next);return b.length>=a.length&&a.every((v,i)=>canonical(v)===canonical(b[i]));
}
