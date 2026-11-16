import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import type {PluginManifest} from '../plugin-release.js';
import type {ConnectorManifest} from '../connectors/registry.js';
import {StoreError} from '../store.js';
import type {Plugin} from '@deepseek-ai/cordis';
import {packageManifestSchema,type ManifestContribution,type ManifestDependency} from '@mote/plugin-api';
import type {HostPluginContext} from '@mote/plugin-host';
import type {Awaitable,PluginLifecycle,ServiceBinding} from '@mote/plugin-api/contracts';

/** Load a trusted installed service package entry. Official packages have host
 * privileges; the installer never runs npm/shell lifecycle scripts. */
export async function loadServicePackageModule(directory: string, manifest: PluginManifest) {
  const entry = join(directory, manifest.entry);
  try {
    return await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new StoreError(`Failed to load service package entry: ${error instanceof Error ? error.message : 'unknown'}`, 422);
  }
}

export function connectorFromModule(module: Record<string, unknown>, contributionId?: string): ConnectorManifest {
  const connector = (module.connector ?? module.default) as ConnectorManifest | undefined;
  if (!connector || typeof connector !== 'object' || connector.apiVersion !== 1 || typeof connector.id !== 'string' || typeof connector.create !== 'function') {
    throw new StoreError(contributionId
      ? `Ingress contribution ${contributionId} has no connector export`
      : 'Service package has no connector export', 422);
  }
  return connector;
}

export const isProcessingCapability=(id:string)=>id==='processing.pack'||id.startsWith('processing.');
export function processingPluginFromModule(module:Record<string,unknown>):Plugin {
  const plugin=module.backendPlugin??module.default;
  if(typeof plugin!=='function'&&(!plugin||typeof plugin!=='object'||typeof (plugin as {apply?:unknown}).apply!=='function'))throw new StoreError('Service package has no valid processing export',422);
  return plugin as Plugin;
}

/** Current service entry ABI. Dependencies are exact host-resolved live pins;
 * configuration never chooses an implementation or supplies a namespace. */
export type DomainPluginOptions={readonly configuration:Readonly<Record<string,string|number|boolean>>;readonly required:readonly ServiceBinding[];readonly optional:readonly ServiceBinding[]};
export type DomainPluginFactory=(context:HostPluginContext,options:DomainPluginOptions)=>Awaitable<PluginLifecycle>;
export const domainContributions=(manifest:PluginManifest)=>manifest.contributions?.filter(value=>value.surface==='data'&&value.runtime==='service')??[];
export const domainDependencies=(manifest:PluginManifest)=>[...manifest.dependencies,...domainContributions(manifest).flatMap(value=>value.requires??[])];
const dependencyKey=(value:ManifestDependency)=>JSON.stringify([value.kind,value.id,value.version,value.required!==false]);
const contributionKey=(value:ManifestContribution)=>JSON.stringify([value.id,value.version,value.surface,value.runtime,value.entry,value.provides??[],value.requires??[],value.capabilities??[]]);
export function domainPluginFromModule(module:Record<string,unknown>,manifest:PluginManifest):DomainPluginFactory {
  const exported=module.manifest as Record<string,unknown>|undefined;
  if(typeof module.createPlugin!=='function'||!exported||exported.apiVersion!==1||exported.id!==manifest.id||exported.version!==manifest.version||!Array.isArray(exported.required)||!Array.isArray(exported.optional))throw new StoreError('Service package has no valid domain export',422);
  let declared:PluginManifest;
  try{declared=packageManifestSchema.parse({...manifest,contributions:exported.contributions,capabilities:exported.capabilities,dependencies:[...exported.required,...exported.optional]}) as PluginManifest;}
  catch{throw new StoreError('Invalid domain module declaration',422);}
  const contributions=domainContributions(manifest),dependencies=domainDependencies(manifest);
  if(!contributions.length||declared.contributions?.length!==contributions.length||declared.contributions.some(value=>!contributions.some(expected=>contributionKey(expected)===contributionKey(value)))
    ||declared.capabilities.some(id=>!contributions.some(value=>value.capabilities?.includes(id))||!manifest.capabilities.includes(id))
    ||declared.dependencies.some(value=>!dependencies.some(expected=>dependencyKey(expected)===dependencyKey(value)))
    ||exported.required.some((value:ManifestDependency)=>value.required===false)||exported.optional.some((value:ManifestDependency)=>value.required!==false))throw new StoreError('Domain module exceeds the verified package declaration',422);
  for(const value of contributions){
    if(!value.provides?.length||value.provides.some(port=>port.kind!=='service'||port.cardinality!=='single')||new Set(value.provides.map(port=>port.id)).size!==value.provides.length||new Set(value.provides.map(port=>port.apiVersion)).size!==1)throw new StoreError('Domain contribution requires distinct typed service ports with one API version',422);
    if(value.entry!==undefined&&value.entry!==manifest.entry||value.capabilities?.some(id=>!manifest.capabilities.includes(id)))throw new StoreError('Domain contribution does not match the package entry or capabilities',422);
  }
  return module.createPlugin as DomainPluginFactory;
}

/** An outbound package declares presentation choices only. The Central host
 * still owns the export cursor, target sandbox, sensitive filtering and all
 * conflict decisions; this descriptor never contains a path to write. */
export type OutboundExportDescriptor = {
  apiVersion: 1;
  id: string;
  format: {extension: 'md'; frontmatter: 'yaml' | 'none'; folder: string};
};
export const isOutboundExportCapability = (id: string) => id === 'outbound.export' || id.startsWith('outbound.');
export function outboundExportFromModule(module: Record<string, unknown>): OutboundExportDescriptor {
  const value = (module.outboundExport ?? module.default) as Partial<OutboundExportDescriptor> | undefined;
  const format = value?.format;
  if (!value || value.apiVersion !== 1 || typeof value.id !== 'string' || !/^[a-z][a-z0-9.-]{2,127}$/.test(value.id)
    || !format || format.extension !== 'md' || !['yaml', 'none'].includes(format.frontmatter)
    || typeof format.folder !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(format.folder) || format.folder.includes('..'))
    throw new StoreError('Outbound export contribution has no valid host contract', 422);
  return Object.freeze({apiVersion: 1, id: value.id, format: Object.freeze({extension: 'md', frontmatter: format.frontmatter, folder: format.folder})});
}

/** Surfaces this Central host can activate for service-runtime packages. */
export function servicePackageSurfaces(manifest: PluginManifest) {
  const surfaces = new Set((manifest.contributions ?? []).map(contribution => contribution.surface));
  return {
    ingress: surfaces.has('ingress'),
    processing: surfaces.has('processing'),
    data: domainContributions(manifest).length>0,
    native: (manifest.contributions ?? []).some(contribution => contribution.surface === 'agent' && contribution.runtime === 'native'),
    presentation: [...surfaces].some(surface=>['page','theme','layout'].includes(surface)),
  };
}

export function assertServicePackageSupported(manifest: PluginManifest) {
  if (manifest.runtime !== 'service') return;
  const surfaces = servicePackageSurfaces(manifest);
  if (!surfaces.ingress && !surfaces.processing && !surfaces.data && !surfaces.presentation && !surfaces.native) {
    throw new StoreError('This release requires a service runtime that this host does not provide', 422);
  }
}
