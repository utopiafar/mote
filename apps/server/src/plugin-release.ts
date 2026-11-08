import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {z} from 'zod';
import {calendarPluginCapabilitySchema} from '@mote/shared';
import type {CalendarPluginCapability,PluginConfigurationField,PluginReleasePreview} from '@mote/shared';
import {
  packageManifestSchema, PluginContractError,
  type ManifestDependency, type PackageManifest,
} from '@mote/plugin-api';
import {StoreError} from './store.js';

/** The one current package Manifest is owned by @mote/plugin-api. This wrapper
 * adds the existing calendar host declaration only; the archive/source
 * identity remains in the resolver below. */
export type PluginManifest = Omit<PackageManifest,'actionCapabilities'> & {actionCapabilities?:readonly CalendarPluginCapability[]};
const parsePluginManifest=(input:unknown):PluginManifest=>{
  const base=packageManifestSchema.parse(input),actions=base.actionCapabilities?.map(value=>calendarPluginCapabilitySchema.parse(value));
  if(actions&&actions.length>1)throw new PluginContractError('invalid_contract','$.actionCapabilities');
  if(base.capabilities.includes('calendar.manage')!==Boolean(actions?.length))throw new PluginContractError('invalid_contract','$.actionCapabilities');
  return (actions?{...base,actionCapabilities:actions}:base) as PluginManifest;
};
export const pluginManifestSchema={
  parse:parsePluginManifest,
  safeParse(input:unknown):{success:true;data:PluginManifest}|{success:false;error:unknown}{
    try{return {success:true,data:parsePluginManifest(input)};}catch(error){return {success:false,error};}
  },
};
const dependencyLabel=(dependency:ManifestDependency)=>dependency.id+'@'+dependency.version;
const validPackagePath=(value:string)=>Boolean(value)&&!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>!part||part==='.'||part==='..');
const relativePath={
  safeParse:(value:string)=>validPackagePath(value)?{success:true as const}:{success:false as const},
  parse:(value:string)=>{if(!validPackagePath(value))throw new StoreError('Invalid package path',422);return value;},
};
export type ResolvedPluginRelease={preview:PluginReleasePreview;manifest:PluginManifest;archiveUrl:string};
export type PluginReleaseTransport=(url:string)=>Promise<{bytes:Uint8Array}>;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const repositorySchema=z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
// Resource bounds apply before allocating remote archives or inflated entries.
const archiveBytes=64*1024*1024,expandedBytes=256*1024*1024,entryBytes=64*1024*1024,entryCount=20000;
function repository(input:string){
  if(!input.startsWith('https://'))return repositorySchema.parse(input);
  const url=new URL(input);if(url.hostname!=='github.com'||url.port||url.username||url.password||url.search||url.hash)throw new StoreError('Choose a GitHub repository URL');
  return repositorySchema.parse(url.pathname.replace(/^\/|\/$/g,'').replace(/\.git$/,''));
}
const publicTransport:PluginReleaseTransport=async url=>{
  const response=await fetch(url,{headers:{Accept:/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(url)?'application/octet-stream':'application/vnd.github+json','User-Agent':'Mote-plugin-center'},redirect:'follow',signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new StoreError(`GitHub release request failed (${response.status})`,502);
  if(Number(response.headers.get('content-length'))>archiveBytes)throw new StoreError('Plugin download exceeds the host archive resource budget',413);
  const chunks:Uint8Array[]=[];let length=0;const reader=response.body!.getReader();
  try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>archiveBytes)throw new StoreError('Plugin download exceeds the host archive resource budget',413);chunks.push(next.value);}}finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return {bytes};
};
const parseJson=(bytes:Uint8Array)=>JSON.parse(new TextDecoder().decode(bytes)) as unknown;

/** Shared pure archive boundary used by release resolution and H09 pack/validate.
 * It only expands/checks the current archive; it never imports package code. */
export function validatePluginArchive(bytes:Uint8Array,manifest:PluginManifest){
  if(bytes.length>archiveBytes)throw new StoreError('Plugin archive exceeds the host resource budget',413);
  let entries:ReturnType<typeof unzipSync>,total=0,count=0;try{entries=unzipSync(bytes,{filter:file=>{
    if(++count>entryCount||file.originalSize>entryBytes||(total+=file.originalSize)>expandedBytes)throw new StoreError('Plugin archive exceeds the host expansion resource budget',413);
    if(!relativePath.safeParse(file.name.endsWith('/')?file.name.slice(0,-1):file.name).success)throw new StoreError('Invalid package path',422);return true;
  }});}catch(error){if(error instanceof StoreError)throw error;throw new StoreError('The adapter archive is invalid',422);}
  for(const path of Object.keys(entries))if(!path.endsWith('/'))relativePath.parse(path);
  if(!entries[manifest.entry])throw new StoreError('The adapter entry is missing from its archive',422);
  for(const contribution of manifest.contributions??[])if(contribution.entry&&!entries[contribution.entry])throw new StoreError('A contribution entry is missing from its archive',422);
  return entries;
}

export class GitHubPluginReleases {
  constructor(readonly directory:string,private transport:PluginReleaseTransport=publicTransport){}
  async resolve(raw:{repository:string;tag?:string}):Promise<ResolvedPluginRelease>{
    const repo=repository(raw.repository),tag=raw.tag?.trim();
    const path=`https://api.github.com/repos/${repo}`;
    const release=z.object({tag_name:z.string(),draft:z.boolean(),assets:z.array(z.object({id:z.number().int().positive().optional(),name:z.string(),browser_download_url:z.string().url()}))}).passthrough().parse(parseJson((await this.transport(`${path}/releases/${tag?'tags/'+encodeURIComponent(tag):'latest'}`)).bytes));
    if(release.draft)throw new StoreError('Choose a published, fixed GitHub release');
    const commit=z.object({sha:z.string().regex(/^[a-f0-9]{40}$/)}).passthrough().parse(parseJson((await this.transport(`${path}/commits/${encodeURIComponent(release.tag_name)}`)).bytes)).sha;
    const trustedAsset=(url:string)=>{const value=new URL(url);if(value.protocol!=='https:'||value.hostname!=='github.com'||!value.pathname.startsWith('/'+repo+'/releases/download/'+encodeURIComponent(release.tag_name)+'/')||value.username||value.password)throw new StoreError('The adapter asset is outside the selected GitHub release');return url;};
    const manifestAsset=release.assets.find(asset=>asset.name==='mote-plugin.json');
    if(!manifestAsset)throw new StoreError('This release has no Mote adapter manifest (mote-plugin.json). Install a compatible adapter release.',422);
    let manifest:PluginManifest;
    try{manifest=pluginManifestSchema.parse(parseJson((await this.transport(trustedAsset(manifestAsset.browser_download_url))).bytes));}
    catch(error){if(error instanceof PluginContractError)throw new StoreError('The plugin manifest is invalid or uses an unsupported contract version',400);throw error;}
    if(manifest.runtime==='service')throw new StoreError('This release requires a service runtime that this host does not provide',422);
    const asset=release.assets.find(asset=>asset.name===manifest.archive.asset);if(!asset)throw new StoreError('The adapter archive is absent from the release',422);
    const archiveUrl=trustedAsset(asset.browser_download_url),bytes=(await this.transport(archiveUrl)).bytes,digest=hash(bytes);
    if(digest!==manifest.archive.sha256)throw new StoreError('The adapter archive failed integrity verification',422);
    validatePluginArchive(bytes,manifest);
    return {manifest,archiveUrl,preview:{id:randomUUID(),name:manifest.name,version:manifest.version,source:{repository:repo,tag:release.tag_name,commit,digest},runtime:manifest.runtime,restartRequired:false,capabilities:manifest.capabilities.map(id=>({id,state:'unknown',reason:'Requires an instance capability check'})),dependencies:manifest.dependencies.map(dependencyLabel),access:[...manifest.access],issues:[],installable:true}};
  }
  async install(release:ResolvedPluginRelease){
    const bytes=(await this.transport(release.archiveUrl)).bytes;if(hash(bytes)!==release.preview.source.digest)throw new StoreError('The release asset changed after review; resolve it again',409);
    const entries=validatePluginArchive(bytes,release.manifest),destination=join(this.directory,release.preview.source.digest),temporary=destination+'.'+randomUUID();
    await mkdir(this.directory,{recursive:true,mode:0o700});
    try{
      // An installed immutable artifact may be reused only after rechecking its lock.
      try{await readFile(join(destination,'mote-install-lock.json'));this.verifyInstalled(destination,release.preview.source.digest,release.manifest);return destination;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await mkdir(temporary,{mode:0o700});
      for(const [path,data] of Object.entries(entries)){if(path.endsWith('/'))continue;const target=join(temporary,path);await mkdir(join(target,'..'),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o600});}
      await writeFile(join(temporary,'mote-install-lock.json'),JSON.stringify({digest:release.preview.source.digest,source:release.preview.source,manifest:release.manifest}),{mode:0o600});
      await writeFile(join(temporary,'mote-source.zip'),bytes,{mode:0o600});
      await rename(temporary,destination);return destination;
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
  verifyInstalled(directory:string,digest:string,manifest:PluginManifest){
    try{
      const source=readFileSync(join(directory,'mote-source.zip'));if(hash(source)!==digest)throw Error('archive_hash');
      const entries=validatePluginArchive(source,manifest),expected=new Set(Object.keys(entries).filter(path=>!path.endsWith('/')));
      expected.add('mote-install-lock.json');expected.add('mote-source.zip');
      const walk=(relative='')=>{for(const file of readdirSync(join(directory,relative))){const path=relative?relative+'/'+file:file,stat=lstatSync(join(directory,path));if(stat.isSymbolicLink())throw Error('link');if(stat.isDirectory())walk(path);else if(!stat.isFile()||!expected.has(path))throw Error('unexpected_file');}};walk();
      for(const [path,data] of Object.entries(entries))if(!path.endsWith('/')&&hash(readFileSync(join(directory,path)))!==hash(data))throw Error('entry_hash');
      if(JSON.parse(readFileSync(join(directory,'mote-install-lock.json'),'utf8')).digest!==digest)throw Error('lock_hash');
    }catch{throw new StoreError('Installed adapter integrity mismatch; remove the cached artifact and resolve it again',409);}
  }
  schema(manifest:PluginManifest):PluginConfigurationField[]{return manifest.configuration as PluginConfigurationField[];}
}
