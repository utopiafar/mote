import {libraryMaterialTypes,type LibraryMaterialType} from '@mote/shared';
import type {CollectionEntry,PageEntry} from './features/types';

export const settingsCategories=['providers','model','processing','memory','audio','documents','file-processing','images','storage','embedding','connectors'] as const;
export type SettingsCategory=typeof settingsCategories[number];
export function settingsCategoryFromHash(hash:string):SettingsCategory|null {
 const value=new URLSearchParams(hash.split('?')[1]??'').get('category');
 return settingsCategories.includes(value as SettingsCategory)?value as SettingsCategory:null;
}
export function pluginTabFromHash(hash:string):'installed'|'discover' {
 const value=new URLSearchParams(hash.split('?')[1]??'').get('tab');
 return value==='installed'?'installed':'discover';
}
/** A return link is local navigation to an installed destination, never an arbitrary URL. */
export function validatedReturnTarget(candidate:string|null|undefined,pages:readonly PageEntry[],collections:readonly CollectionEntry[]):string|undefined {
 if(!candidate?.startsWith('#/')||/[\\\r\n]/.test(candidate)||candidate.includes('#',1))return;
 const [route,queryText]=candidate.slice(2).split('?');
 const page=pages.find(entry=>(entry.route??entry.id)===route||entry.aliases?.includes(route));
 if(!page)return;
 const query=new URLSearchParams(queryText);
 const allowed=new Set(['origin','view','evidence','source','sourceId','kind','type','device','after','before','search','asOf','category','setup','provider','tab','work','question','insight','query','cursor','memory','selected','memoryCursor','history','deviceId']);
 for(const [key,value] of query){
  if(!allowed.has(key)||query.getAll(key).length!==1)return;
  if(key==='selected'&&page.id!=='archive')return;
  if(key==='query'&&page.id!=='search')return;
  if(key==='memoryCursor'&&page.id!=='search')return;
  if(key==='history'&&(page.id!=='ask'||value!=='1'))return;
  if(key==='cursor'&&!['search','archive'].includes(page.id))return;
  if(key==='memory'&&page.id!=='archive')return;
  if(key==='origin'&&(page.id!=='archive'||value!=='notes'))return;
  if(key==='type'&&(page.id!=='archive'||!libraryMaterialTypes.includes(value as LibraryMaterialType)))return;
  if(key==='view'&&(page.id!=='archive'||!collections.some(entry=>entry.id===value)))return;
  if(key==='category'&&(page.id!=='settings'||!settingsCategories.includes(value as SettingsCategory)))return;
  if(key==='tab'&&!((page.id==='extensions'&&['installed','discover','memory'].includes(value))||(page.id==='agentView'&&value==='input')))return;
  if(key==='setup'&&(page.id!=='sources'||!['gmail','google','mcp','reference'].includes(value)))return;
  if(key==='provider'&&page.id!=='recordings')return;
  if(key==='work'&&page.id!=='activity')return;
  if(key==='question'&&page.id!=='ask')return;
  if(key==='insight'&&page.id!=='insights')return;
 }
 return candidate;
}
