import type {Store} from '../store.js';
import {installSchemaPlan,type SchemaInstallation} from '../schema-installation.js';

export const gmailStateSchemaInstallation={owner:'gmail-sync',requires:[],install:db=>{db.exec('CREATE TABLE IF NOT EXISTS gmail_sync_members(source_id TEXT NOT NULL,message_id TEXT NOT NULL,epoch TEXT NOT NULL,PRIMARY KEY(source_id,message_id))');}} as const satisfies SchemaInstallation;


/** Gmail's durable full-sync membership and read model of current message parts. */
export interface GmailSyncState {
  partIds(sourceId:string,messageId:string):string[];
  forgetMember(sourceId:string,messageId:string):void;
  touchMember(sourceId:string,messageId:string,epoch:string):void;
  staleMembers(sourceId:string,epoch:string):string[];
}
export function gmailSyncState(store:Pick<Store,'db'>):GmailSyncState {
  const {db}=store;
  installSchemaPlan(db,[gmailStateSchemaInstallation]);
  return {
    partIds:(sourceId,messageId)=>(db.prepare('SELECT external_id FROM source_heads WHERE source_id=? AND substr(external_id,1,?)=? AND deleted=0').all(sourceId,messageId.length+1,`${messageId}:`) as {external_id:string}[]).map(row=>row.external_id),
    forgetMember:(sourceId,messageId)=>{db.prepare('DELETE FROM gmail_sync_members WHERE source_id=? AND message_id=?').run(sourceId,messageId);},
    touchMember:(sourceId,messageId,epoch)=>{db.prepare('INSERT INTO gmail_sync_members VALUES(?,?,?) ON CONFLICT(source_id,message_id) DO UPDATE SET epoch=excluded.epoch').run(sourceId,messageId,epoch);},
    staleMembers:(sourceId,epoch)=>(db.prepare('SELECT message_id FROM gmail_sync_members WHERE source_id=? AND epoch!=?').all(sourceId,epoch) as {message_id:string}[]).map(row=>row.message_id),
  };
}
