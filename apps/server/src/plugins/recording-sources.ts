import {z} from 'zod';
import type {RecordingStatus} from '@mote/shared';
import type {ConnectorManifest} from '../connectors/registry.js';
import type {ConnectorContext} from '../connectors/types.js';
import type {MemoryStrategies} from '../memory-strategies.js';
import {RecordingConnector,type RecordingProvider} from '../connectors/recordings.js';
import {createFeishuRecordings} from '../connectors/lark-recordings.js';
import {createDingtalkRecordings} from '../connectors/dingtalk-recordings.js';
import {installRecordingMemory} from '../connectors/recording-memory.js';
import {initializeRecordingMedia} from '../connectors/recording-state.js';
import {RecordingAuthorization} from './recording-authorization.js';

export {RecordingConnector} from '../connectors/recordings.js';
export type {RecordingProvider,RecordingAccount,RecordingMetadata} from '../connectors/recordings.js';

/** C15's Feishu and DingTalk recording sources. This module owns
 * connectors/recordings.ts, lark-recordings.ts, dingtalk-recordings.ts,
 * recording-staging.ts, recording-state.ts and recording-memory.ts, plus the
 * non-replayable authorization cache and its retirement. The shared
 * synchronization runtime, provider adapters, staged downloads, durable
 * receipts/cursors, authorization receipts and the recording Memory recipe
 * live and die with the instance. Each provider runs as one instance under the
 * connector host adapter, which supplies binding grants, owner routes and
 * per-instance stop/restart; the Memory recipe is installed once per host,
 * never per poll or activation. */
export function recordingManifest(id:string,create:(ctx:ConnectorContext)=>RecordingProvider,options:Pick<RecordingStatus,'label'|'setup'>={}):ConnectorManifest{return {
 apiVersion:1,id:`${id}-recordings`,statusKey:`${id}-recordings`,sourceKinds:[{kind:`${id}.recordings`,capabilities:{lifecycle:'continuous',discovery:'provider-list',listening:'polling',readOriginal:'explicit-provider-read',synchronization:'revisions',externalWrite:false}}],
 create:ctx=>{
  initializeRecordingMedia(ctx.store);
  // The authorization belongs to this activation. Retiring it cancels checks
  // and in-flight grants before the connector stops publishing; a restart
  // constructs a fresh receipt/environment cache instead of replaying one.
  const provider=create(ctx);if(provider.id!==id)throw Error('Recording manifest and provider identity differ');const connector=new RecordingConnector(ctx,provider),authorization=provider.authorization?new RecordingAuthorization(connector,provider.authorization):undefined,status=()=>({...connector.status(),...(authorization?{authorization:authorization.status()}:{}),category:'recordings' as const,...options});
  const retire=async()=>{const errors:unknown[]=[];for(const dispose of [()=>authorization?.close(),()=>connector.close()])try{await dispose();}catch(error){errors.push(error);}if(errors.length)throw errors.length===1?errors[0]:new AggregateError(errors,'Recording source disposal failed');};
  return {status,init:()=>connector.init(),configureSyncInterval:interval=>connector.configureSyncInterval(interval),close:retire,configure:host=>{
   const path=`/api/connectors/${id}-recordings` as const;
   host.ownerRoute({method:'GET',path,handler:status});
   host.ownerRoute({method:'GET',path:`${path}/items`,handler:req=>connector.items(z.object({includeExports:z.enum(['true','false']).optional()}).strict().parse(req.query).includeExports==='true')});
   host.ownerRoute({method:'GET',path:`${path}/steps`,handler:req=>connector.steps(z.object({cursor:z.coerce.number().int().positive().optional(),limit:z.coerce.number().int().min(1).max(100).optional()}).strict().parse(req.query))});
   if(authorization){
    host.ownerRoute({method:'POST',path:`${path}/check`,handler:async()=>{await authorization.check();return status();}});
    for(const kind of ['setup','configure','login'] as const)host.ownerRoute({method:'POST',path:`${path}/${kind}`,handler:req=>{authorization.start(kind,req.body);return status();}});
    host.ownerRoute({method:'POST',path:`${path}/authorization/cancel`,handler:async req=>{await authorization.cancel(z.object({taskId:z.string().uuid(),expectedRevision:z.string().uuid()}).strict().parse(req.body));return status();}});
   }
   host.ownerRoute({method:'POST',path:`${path}/connect`,handler:()=>connector.connect()});
   host.ownerRoute({method:'PUT',path:`${path}/selection`,handler:req=>connector.select(req.body)});
   host.ownerRoute({method:'POST',path:`${path}/sync`,handler:()=>connector.sync()});
   host.ownerRoute({method:'POST',path:`${path}/retry`,handler:()=>connector.retry()});
   host.ownerRoute({method:'DELETE',path,handler:async()=>{await authorization?.cancel();return connector.disconnect();}});
  }};
 },
};}
export function recordingSourceManifests(testing?:readonly RecordingProvider[]):ConnectorManifest[] {
  return [
    recordingManifest('feishu',ctx=>testing?.find(provider=>provider.id==='feishu')??createFeishuRecordings(ctx.config.connectors!.directory)),
    recordingManifest('dingtalk',ctx=>testing?.find(provider=>provider.id==='dingtalk')??createDingtalkRecordings(ctx.config.connectors!.directory)),
  ];
}
/** The recording recipe belongs to the host, not a provider instance: install
 * once and reuse it across connector disable/re-enable and poll restarts. */
export function installRecordingSources(strategies?:MemoryStrategies){
  return strategies?installRecordingMemory(strategies):undefined;
}
