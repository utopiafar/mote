import {navigationFor,pageRoutes,type NavItem,type NavItemId} from '@mote/shared';
import {webFeatures} from './features/registry';
/** Navigation is contributed by installed, trusted UI entries; never inferred from content. */
export type Page=string;
/** Shared destination identities map to the web workspace routes that render them. */
export const destinationPages={home:'ask',library:'archive',sources:'sources',connections:'connections',ask:'ask',activity:'activity'};

export type WorkspaceNavItem=NavItem&{page:Page};

export function workspaceNavigation(host=webFeatures):{daily:WorkspaceNavItem[];manage:WorkspaceNavItem[]} {
  const pageByItem=new Map<NavItemId,Page>();
  for(const page of host.pages())if(page.navItem)pageByItem.set(page.navItem,page.id);
  const enabledPackages=new Set(host.registry.inventory().features.map(feature=>feature.id));
  const {daily,manage}=navigationFor({enabledPackages,registered:new Set(pageByItem.keys())});
  const bindPages=(items:typeof daily)=>items.flatMap(item=>{
    if(!('id' in item))return [];
    const page=pageByItem.get(item.id);
    return page?[{...item,page}]:[];
  });
  return {daily:bindPages(daily),manage:bindPages(manage)};
}
function live<T extends object>(read:()=>T):T {return new Proxy({} as T,{get:(_target,key)=>Reflect.get(read(),key),ownKeys:()=>Reflect.ownKeys(read()),getOwnPropertyDescriptor:(_target,key)=>Object.getOwnPropertyDescriptor(read(),key)});}
export const routes:Record<string,string>=live(()=>Object.fromEntries(webFeatures.pages().map(page=>[page.id,page.route??page.id])));
export const pageLabels:Record<string,string>=live(()=>Object.fromEntries(webFeatures.pages().map(page=>[page.id,page.label??page.id])));
export const sections=live(()=>Object.fromEntries(['library','connections','system'].map(section=>[section,webFeatures.pages().filter(page=>page.section===section).sort((a,b)=>(a.order??0)-(b.order??0)).map(page=>page.id)])) as Record<'library'|'connections'|'system',string[]>);
const rescueRoutes:Record<string,Page>={[pageRoutes.skills]:'extensions','system/extensions':'extensions'};
const retiredRoutes=new Set(['today','overview','ask','guide','featureGuide']);
export function readPage(hash:string):Page{
  const route=hash.replace(/^#\/?/,'').split('?')[0]||pageRoutes.chat;
  if(retiredRoutes.has(route))return 'unavailable';
  return webFeatures.pages().find(page=>(page.route??page.id)===route||page.aliases?.includes(route))?.id
    ??(Object.hasOwn(rescueRoutes,route)?rescueRoutes[route]:undefined)
    ??(Object.hasOwn(routes,route)?route:'unavailable');
}
export function sectionFor(page:Page){return webFeatures.pages().find(entry=>entry.id===page)?.section??page;}
