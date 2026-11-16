import {createHash} from 'node:crypto';
import {extname,isAbsolute,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {LocalSource,SourceItem} from './source-types';

/** Deterministic facts needed to revalidate saved input, separate from a running lease. */
export interface SourceScope {kind:string;path?:string;calendarId?:string;retention:string;allowRead:boolean;trackDeletions:boolean;redaction:string;extensions:string[];excludedPaths:string[]}
export function sourceScope(source:LocalSource):SourceScope{return {kind:source.kind,path:source.path,calendarId:source.calendarId,retention:source.retention,allowRead:Boolean(source.allowRead),trackDeletions:source.trackDeletions,redaction:createHash('sha256').update(JSON.stringify(source.redactLiterals)).digest('hex'),extensions:[...source.extensions],excludedPaths:[...source.excludedPaths]};}
export function pendingInScope(item:Pick<SourceItem,'uri'|'deleted'>,previous:SourceScope|undefined,current:SourceScope,canonicalRoot?:string):boolean{
 if(!previous||previous.kind!==current.kind||previous.path!==current.path||previous.calendarId!==current.calendarId||previous.retention!==current.retention||previous.allowRead!==current.allowRead||previous.redaction!==current.redaction)return false;
 if(item.deleted&&!current.trackDeletions)return false;
 if(current.kind!=='local-files')return JSON.stringify(previous)===JSON.stringify(current);
 if(!current.path||!item.uri)return false;
 try{
  const url=new URL(item.uri);if(url.protocol!=='file:'||url.host||url.search||url.hash)return false;
  const path=fileURLToPath(url),delta=relative(canonicalRoot??current.path,path),local=delta.split(sep).join('/');
  if(delta==='..'||delta.startsWith('..'+sep)||isAbsolute(delta)||!current.extensions.includes(extname(path).toLowerCase()))return false;
  return !current.excludedPaths.some(excluded=>local===excluded||local.startsWith(excluded+'/'));
 }catch{return false;}
}
