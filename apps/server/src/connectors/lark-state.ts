import type {Store} from '../store.js';
import {installSchemaPlan,type SchemaInstallation} from '../schema-installation.js';

export const larkStateSchemaInstallation={owner:'lark-document-sync',requires:[],install:db=>{db.exec('CREATE TABLE IF NOT EXISTS lark_document_sync(account TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(account,scope,key));');}} as const satisfies SchemaInstallation;


export interface LarkSourceReadModel {
  sourceExists(sourceId:string):boolean;
  forgotten(sourceId:string,externalId:string):boolean;
}
export interface LarkDocumentState {
  get<T>(key:string):T|undefined;
  set(key:string,value:unknown):void;
  drop(key:string):void;
  rows<T>(prefix:string,limit?:number,errorOnly?:boolean):Array<{key:string;value:T}>;
  count(prefix:string,errorOnly?:boolean):number;
  forgotten(externalId:string):boolean;
  sweepForgotten():void;
  currentKinds():Array<{kind:string;count:number}>;
  sourceExists():boolean;
  versionExists(externalId:string):boolean;
}
export function larkSourceReadModel(store:Pick<Store,'db'>):LarkSourceReadModel {
  const {db}=store;
  return {
    sourceExists:sourceId=>Boolean(db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId)),
    forgotten:(sourceId,externalId)=>Boolean(db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(sourceId,externalId)),
  };
}
/** Per-account/scope transport state; source/file facts remain explicit read projections. */
export function larkDocumentState(store:Pick<Store,'db'>,account:string,sourceId:string,scope:string):LarkDocumentState {
  const {db}=store,read=larkSourceReadModel(store);
  installSchemaPlan(db,[larkStateSchemaInstallation]);
  return {
    get:<T>(key:string):T|undefined=>{const row=db.prepare('SELECT json FROM lark_document_sync WHERE account=? AND scope=? AND key=?').get(account,(key.startsWith('alias:')||key.startsWith('signal:'))?'identity':scope,key) as {json:string}|undefined;return row?JSON.parse(row.json) as T:undefined;},
    set:(key,value)=>{db.prepare('INSERT INTO lark_document_sync VALUES(?,?,?,?) ON CONFLICT(account,scope,key) DO UPDATE SET json=excluded.json').run(account,(key.startsWith('alias:')||key.startsWith('signal:'))?'identity':scope,key,JSON.stringify(value));},
    drop:key=>{db.prepare('DELETE FROM lark_document_sync WHERE account=? AND scope=? AND key=?').run(account,scope,key);},
    rows:<T>(prefix:string,limit=-1,errorOnly=false):Array<{key:string;value:T}> => (db.prepare(`SELECT key,json FROM lark_document_sync WHERE account=? AND scope=? AND key LIKE ?${errorOnly?" AND json_extract(json,'$.error') IS NOT NULL":''} ORDER BY key LIMIT ?`).all(account,prefix.startsWith('signal:')?'identity':scope,`${prefix}%`,limit) as {key:string;json:string}[]).map(row=>({key:row.key,value:JSON.parse(row.json) as T})),
    count:(prefix,errorOnly=false)=>Number((db.prepare(`SELECT COUNT(*) AS count FROM lark_document_sync WHERE account=? AND scope=? AND key LIKE ?${errorOnly?" AND json_extract(json,'$.error') IS NOT NULL":''}`).get(account,scope,`${prefix}%`) as {count:number}).count),
    forgotten:externalId=>read.forgotten(sourceId,externalId),
    sweepForgotten:()=>{
      const rows=db.prepare('SELECT external_id FROM file_forgotten WHERE source_id=?').all(sourceId) as {external_id:string}[];
      for(const row of rows){const aliases=db.prepare("SELECT key FROM lark_document_sync WHERE account=? AND scope='identity' AND key LIKE 'alias:%' AND json=?").all(account,JSON.stringify(row.external_id)) as {key:string}[];
        for(const token of [row.external_id,...aliases.map(alias=>alias.key.slice(6))])for(const prefix of ['pending:','found:'])db.prepare('DELETE FROM lark_document_sync WHERE account=? AND key=?').run(account,prefix+token);
      }
    },
    currentKinds:()=>db.prepare("SELECT json_extract(c.json,'$.source') AS kind,COUNT(*) AS count FROM source_heads h JOIN captures c ON c.id=h.capture_id WHERE h.source_id=? AND h.deleted=0 GROUP BY kind").all(sourceId) as {kind:string;count:number}[],
    sourceExists:()=>read.sourceExists(sourceId),
    versionExists:externalId=>Boolean(db.prepare('SELECT 1 FROM source_versions WHERE source_id=? AND external_id=?').get(sourceId,externalId)),
  };
}
