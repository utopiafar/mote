import {builtinPages} from './features/entries';
/** Navigation is contributed by installed, trusted UI entries; never inferred from content. */
export type Page=string;
export const routes:Record<string,string>=Object.fromEntries(builtinPages.map(page=>[page.id,page.route??page.id]));
export const pageLabels:Record<string,string>=Object.fromEntries(builtinPages.map(page=>[page.id,page.label??page.id]));
export const sections=Object.fromEntries(['library','connections','system'].map(section=>[section,builtinPages.filter(page=>page.section===section).sort((a,b)=>(a.order??0)-(b.order??0)).map(page=>page.id)])) as Record<'library'|'connections'|'system',string[]>;
export function readPage(hash:string):Page{const route=hash.replace(/^#\/?/,'').split('?')[0];return Object.keys(routes).find(page=>routes[page]===route)??(Object.hasOwn(routes,route)?route:'overview');}
export function sectionFor(page:Page){return builtinPages.find(entry=>entry.id===page)?.section??page;}
