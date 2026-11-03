import {webFeatures} from './features/registry';
/** Navigation is contributed by installed, trusted UI entries; never inferred from content. */
export type Page=string;
function live<T extends object>(read:()=>T):T {return new Proxy({} as T,{get:(_target,key)=>Reflect.get(read(),key),ownKeys:()=>Reflect.ownKeys(read()),getOwnPropertyDescriptor:(_target,key)=>Object.getOwnPropertyDescriptor(read(),key)});}
export const routes:Record<string,string>=live(()=>Object.fromEntries(webFeatures.pages().map(page=>[page.id,page.route??page.id])));
export const pageLabels:Record<string,string>=live(()=>Object.fromEntries(webFeatures.pages().map(page=>[page.id,page.label??page.id])));
export const sections=live(()=>Object.fromEntries(['library','connections','system'].map(section=>[section,webFeatures.pages().filter(page=>page.section===section).sort((a,b)=>(a.order??0)-(b.order??0)).map(page=>page.id)])) as Record<'library'|'connections'|'system',string[]>);
const rescueRoutes:Record<string,Page>={'system/plugins':'extensions','system/extensions':'extensions'};
export function readPage(hash:string):Page{const route=hash.replace(/^#\/?/,'').split('?')[0];return webFeatures.pages().find(page=>(page.route??page.id)===route||page.aliases?.includes(route))?.id??rescueRoutes[route]??(Object.hasOwn(routes,route)?route:'unavailable');}
export function sectionFor(page:Page){return webFeatures.pages().find(entry=>entry.id===page)?.section??page;}
