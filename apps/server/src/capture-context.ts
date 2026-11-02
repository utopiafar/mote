import {z} from 'zod';
import type {SourceConnection,SourceContextSnapshot} from '@mote/shared';
import {sourceConnectionSchema} from '@mote/shared';
import {sha256,StoreError,type Store} from './store.js';
import type {SourceStore} from './sources.js';
import {moteText} from './i18n.js';

export const captureContextChannelSchema=z.enum(['screen','structured','activity','notifications']);
type Channel=z.infer<typeof captureContextChannelSchema>;
const sourceByChannel={screen:'screen',structured:'ui_page',activity:'activity',notifications:'notification'} as const;
const prefixBySource={screen:'screen',ui_page:'ui-page',activity:'activity',notification:'notification'} as const;
export const isCaptureContextSourceId=(id:string)=>/^(screen|ui-page|activity|notification):[a-f0-9]{64}$/.test(id);
/** Match existing screen and structured identities; this never grants Memory intake. */
export function captureContextSourceId(source:string,deviceId:string):string|undefined {
  const prefix=prefixBySource[source as keyof typeof prefixBySource];
  return prefix?`${prefix}:${sha256(JSON.stringify(deviceId))}`:undefined;
}
function matchingSource(store:Store,id:string,deviceId:string,platform:string){
  const row=store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(id);
  if(!row)return false;
  // Stored sources also carry lifecycle fields; select the trusted identity explicitly.
  const source=JSON.parse(String(row.json)) as SourceConnection;
  return source.kind==='custom'&&source.deviceId===deviceId&&source.platform===platform;
}
/** Exact original lineage only. A neighboring record sharing the same app, file
 * or Material never acquires another device/channel's description. */
export function captureContextMembers(store:Store,captureIds:string[]):Map<string,string[]> {
  const groups=new Map<string,string[]>();if(!captureIds.length)return groups;
  const rows=store.db.prepare(`WITH RECURSIVE originals(id) AS (
    SELECT value FROM json_each(?) UNION SELECT capture_id FROM file_chunks WHERE id IN (SELECT value FROM json_each(?)) UNION SELECT l.parent_id FROM file_evidence_links l JOIN originals o ON l.capture_id=o.id)
    SELECT DISTINCT c.id,c.device_id,json_extract(c.json,'$.source') source,json_extract(c.json,'$.platform') platform
    FROM originals o JOIN captures c ON c.id=o.id ORDER BY c.id`).all(JSON.stringify(captureIds),JSON.stringify(captureIds));
  for(const row of rows){
    const id=captureContextSourceId(String(row.source),String(row.device_id));
    if(!id||!matchingSource(store,id,String(row.device_id),String(row.platform)))continue;
    const members=groups.get(id)??[];members.push(String(row.id));groups.set(id,members);
  }
  return groups;
}
export function captureContextOriginals(store:Store,sourceId:string):string[]{
  if(!isCaptureContextSourceId(sourceId))return [];
  const row=store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);if(!row)return [];
  const source=JSON.parse(String(row.json)) as SourceConnection;
  const channel=Object.values(sourceByChannel).find(kind=>captureContextSourceId(kind,source.deviceId)===sourceId);
  if(!channel||source.kind!=='custom')return [];
  return store.db.prepare("SELECT id FROM captures WHERE device_id=? AND json_extract(json,'$.source')=? AND json_extract(json,'$.platform')=? ORDER BY id").all(source.deviceId,channel,source.platform).map(row=>String(row.id));
}
function sourceIdentity(store:Store,deviceId:string,channel:Channel){
  const row=store.db.prepare('SELECT json FROM devices WHERE id=?').get(deviceId);
  if(!row)throw new StoreError('Capture context device is not registered',404);
  const device=JSON.parse(String(row.json)),id=captureContextSourceId(sourceByChannel[channel],deviceId)!;
  const platform=sourceConnectionSchema.shape.platform.safeParse(device.platform);
  if(!platform.success)throw new StoreError('Capture context is unavailable for this device platform',400);
  const names={screen:moteText('屏幕记录'),structured:moteText('内容'),activity:moteText('应用活动'),notifications:moteText('通知')};
  const name=`${String(device.deviceName||deviceId).slice(0,160)} · ${names[channel]}`.slice(0,200);
  return {id,deviceId,platform:platform.data,kind:'custom' as const,name,retention:'archive' as const,enabled:true};
}
/** Owner routes call authorization before these methods. Device state and
 * processing grants are untouched; GET does not create a source. */
export function readCaptureContext(store:Store,sources:SourceStore,deviceId:string,channel:Channel):SourceContextSnapshot {
  const source=sourceIdentity(store,deviceId,channel);
  if(!store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(source.id))return {sourceId:source.id,version:0,description:''};
  if(!matchingSource(store,source.id,source.deviceId,source.platform))throw new StoreError('Capture context source identity changed',409);
  return sources.contexts.current(source.id);
}
export function updateCaptureContext(store:Store,sources:SourceStore,deviceId:string,channel:Channel,patch:{expectedVersion:number;description:string},authorize?:()=>void):SourceContextSnapshot {
  const source=sourceIdentity(store,deviceId,channel),db=store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{authorize?.();sources.register(source,()=>authorize?.());const result=sources.updateContext(source.id,patch,authorize);authorize?.();if(own)db.exec('COMMIT');return result;}
  catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
}
