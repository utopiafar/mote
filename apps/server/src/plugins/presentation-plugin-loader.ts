import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {desktopUiLayout,validateUiLayoutProfile,validateUiTheme,type UiLayoutProfile,type UiThemePack} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginManifest} from '../plugin-release.js';
import {StoreError} from '../evidence-store.js';

export const presentationSurfaces=new Set(['page','theme','layout']);
export const presentationContributions=(manifest:PluginManifest)=>manifest.contributions?.filter(value=>presentationSurfaces.has(value.surface))??[];
export const presentationDependencies=(manifest:PluginManifest)=>[...manifest.dependencies,...presentationContributions(manifest).flatMap(value=>value.requires??[])];
export const PLUGIN_PAGE_CSP="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; sandbox allow-scripts";
const identity={id:z.string(),version:z.string()};
const themeSchema=z.object({...identity,tokens:z.record(z.string()),schemes:z.object({light:z.record(z.string()),dark:z.record(z.string())}).strict().optional()}).strict();
const destination=z.enum(['home','library','ask','sources','connections','activity']);
const layoutSchema=z.object({...identity,primary:z.array(destination),secondary:z.array(destination).optional(),initial:destination,navigation:z.enum(['sidebar','adaptive','top']),detail:z.enum(['split','stack'])}).strict();
export type LoadedPresentation={
  declarations:readonly ManifestContribution[];
  pages:{declaration:ManifestContribution;html:string}[];
  themes:{contributionId:string;pack:UiThemePack}[];
  layouts:{contributionId:string;pack:UiLayoutProfile}[];
};

/** Read data from the already integrity-verified artifact. HTML is self-contained
 * and later served with an independent CSP; JSON can never name executable UI. */
export function loadPresentationPackage(directory:string,manifest:PluginManifest):LoadedPresentation {
  const declarations=presentationContributions(manifest),result:LoadedPresentation={declarations,pages:[],themes:[],layouts:[]};
  for(const declaration of declarations){
    if(declaration.runtime!=='host'||declaration.version!=='1'||!declaration.entry||declaration.provides?.length
      ||declaration.capabilities?.some(id=>!manifest.capabilities.includes(id)))throw new StoreError('unsupported_presentation:'+declaration.id,422);
    const path=join(directory,declaration.entry),limit=declaration.surface==='page'?1024*1024:128*1024;
    if(statSync(path).size>limit)throw new StoreError('presentation_entry_too_large:'+declaration.id,422);
    const text=readFileSync(path,'utf8');
    if(declaration.surface==='page'){
      if(!/\.html?$/.test(declaration.entry))throw new StoreError('unsupported_page_document:'+declaration.id,422);
      const bridge=declaration.bridge;
      if(bridge){
        const provider=manifest.contributions?.find(value=>value.id===bridge.contributionId&&value.surface==='data'&&value.runtime==='service');
        if(!provider?.provides?.some(port=>port.kind==='service'&&port.cardinality==='single'&&port.id===bridge.service.id&&port.apiVersion===bridge.service.apiVersion)
          ||!declaration.requires?.some(value=>value.kind==='contribution'&&value.id===provider.id&&value.version===provider.version&&value.required!==false))throw new StoreError('page_bridge_dependency_invalid:'+declaration.id,422);
      }
      result.pages.push({declaration,html:text});
    }else{
      if(!declaration.entry.endsWith('.json'))throw new StoreError('unsupported_presentation_data:'+declaration.id,422);
      const value=JSON.parse(text);
      if(declaration.surface==='theme'){
        const pack=validateUiTheme(themeSchema.parse(value));
        if(result.themes.some(entry=>entry.pack.id===pack.id&&entry.pack.version===pack.version))throw new StoreError('duplicate_theme_identity:'+declaration.id,422);
        result.themes.push({contributionId:declaration.id,pack});
      }
      else{
        const pack=validateUiLayoutProfile(layoutSchema.parse(value),desktopUiLayout.primary);
        if(JSON.stringify([...(pack.secondary??[])].sort())!==JSON.stringify([...(desktopUiLayout.secondary??[])].sort()))throw new StoreError('unsupported_layout_destinations:'+declaration.id,422);
        if(result.layouts.some(entry=>entry.pack.id===pack.id&&entry.pack.version===pack.version))throw new StoreError('duplicate_layout_identity:'+declaration.id,422);
        result.layouts.push({contributionId:declaration.id,pack});
      }
    }
  }
  return result;
}

/** Check the declared methods during the domain's normal staged publication.
 * No method is executed by a capability check. */
export function validatePageBridgePort(manifest:PluginManifest,contributionId:string,serviceId:string,value:unknown){
  for(const page of presentationContributions(manifest))if(page.bridge?.contributionId===contributionId&&page.bridge.service.id===serviceId){
    for(const method of page.bridge.methods){
      const member=value!==null&&(typeof value==='object'||typeof value==='function')?Object.getOwnPropertyDescriptor(value,method):undefined;
      if(!member||!('value' in member)||typeof member.value!=='function')throw new StoreError('page_bridge_method_unavailable:'+page.id+':'+method,422);
    }
  }
}
