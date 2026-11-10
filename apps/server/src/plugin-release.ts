import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {lstatSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {unzipSync,zipSync} from 'fflate';
import {z} from 'zod';
import {actionPluginCapabilitySchema} from '@mote/shared';
import type {ActionPluginCapability,PluginConfigurationField,PluginReleasePreview} from '@mote/shared';
import {
  packageManifestSchema, PluginContractError,
  type ManifestDependency, type PackageManifest,
} from '@mote/plugin-api';
import {StoreError} from './store.js';
import {isOfficialLocalPluginRepository,officialLocalPluginEntry,type OfficialPluginCatalogEntry} from './official-plugin-catalog.js';

/** The one current package Manifest is owned by @mote/plugin-api. This wrapper
 * adds host-validated action declarations; the archive/source identity remains
 * in the resolver below. */
export type PluginManifest = Omit<PackageManifest,'actionCapabilities'> & {actionCapabilities?:readonly ActionPluginCapability[]};
const parsePluginManifest=(input:unknown):PluginManifest=>{
  const base=packageManifestSchema.parse(input),actions=base.actionCapabilities?.map(value=>actionPluginCapabilitySchema.parse(value));
  if(actions&&new Set(actions.map(value=>value.id+'@'+value.version)).size!==actions.length)throw new PluginContractError('invalid_contract','$.actionCapabilities');
  const calendar=actions?.some(value=>value.id==='calendar.manage')??false;
  if(base.capabilities.includes('calendar.manage')!==calendar)throw new PluginContractError('invalid_contract','$.actionCapabilities');
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
export type ResolvedPluginRelease={preview:PluginReleasePreview;manifest:PluginManifest;archiveUrl:string;localDirectory?:string};
export type PluginReleaseTransport=(url:string)=>Promise<{bytes:Uint8Array}>;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const repositoryRoot=()=>resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
// Fixed metadata timestamp keeps the in-process local archive reproducible
// between resolve and install. 1980-01-01 is the ZIP epoch.
const localArchiveMtime=315532800000;
const localSourcePrefix='mote-local:';
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

function assertSupportedManifest(manifest:PluginManifest){
  if(manifest.runtime==='service'){
    const surfaces=new Set((manifest.contributions??[]).map(contribution=>contribution.surface));
    // Central activates connector/processing service packages; other service
    // ABIs still require a host that publishes them.
    if(!surfaces.has('ingress')&&!surfaces.has('processing'))throw new StoreError('This release requires a service runtime that this host does not provide',422);
  }
}

/** Resolve one catalog-declared repository-relative directory. The caller can
 * only supply an identity; this is the sole path from an API request to the
 * filesystem. realpath equality rejects symlinks and traversal. */
export function officialPluginLocalDirectory(repoRoot:string,relativeDirectory:string){
  if(!relativeDirectory||isAbsolute(relativeDirectory)||relativeDirectory.includes('\\')||relativeDirectory.split('/').some(part=>!part||part==='.'||part==='..'))throw new StoreError('Official plugin directory is invalid',422);
  let root:string,directory:string;
  try{root=realpathSync(repoRoot);directory=realpathSync(join(root,...relativeDirectory.split('/')));}
  catch{throw new StoreError('Official plugin directory is unavailable',422);}
  const expected=join(root,...relativeDirectory.split('/')),fromRoot=relative(root,directory);
  if(directory!==expected||!fromRoot||fromRoot==='..'||fromRoot.startsWith('..'+sep)||isAbsolute(fromRoot))throw new StoreError('Official plugin directory escapes the repository',422);
  if(!statSync(directory).isDirectory())throw new StoreError('Official plugin directory is unavailable',422);
  return directory;
}

function readOfficialLocalManifest(directory:string):PluginManifest{
  let input:unknown;
  try{input=JSON.parse(readFileSync(join(directory,'mote-plugin.json'),'utf8'));}
  catch{throw new StoreError('The official plugin manifest is unavailable',422);}
  try{return pluginManifestSchema.parse(input);}
  catch(error){if(error instanceof PluginContractError)throw new StoreError('The plugin manifest is invalid or uses an unsupported contract version',400);throw error;}
}

/** Pack only the declared executable entries. No npm/git/shell/network call,
 * and every file is checked against the already-realpath'ed directory. */
function officialLocalArchive(directory:string,manifest:PluginManifest){
  const paths=[manifest.entry,...(manifest.contributions??[]).map(contribution=>contribution.entry).filter((entry):entry is string=>Boolean(entry))];
  const files:Record<string,Uint8Array>={};
  for(const name of [...new Set(paths)].sort()){
    const value=relativePath.parse(name),target=join(directory,...value.split('/'));
    let real:string;
    try{real=realpathSync(target);}
    catch{throw new StoreError('The adapter entry is missing from its official directory',422);}
    if(real!==target||!statSync(real).isFile())throw new StoreError('The adapter entry escapes its official directory',422);
    files[name]=readFileSync(real);
  }
  const bytes=zipSync(files,{level:9,mtime:localArchiveMtime});
  validatePluginArchive(bytes,manifest);
  return bytes;
}

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
  constructor(readonly directory:string,private transport:PluginReleaseTransport=publicTransport,readonly repoRoot=repositoryRoot()){}
  private resolveLocal(entry:OfficialPluginCatalogEntry&{localDirectory:string}):ResolvedPluginRelease{
    const directory=officialPluginLocalDirectory(this.repoRoot,entry.localDirectory),stored=readOfficialLocalManifest(directory);
    if(entry.packageId&&stored.id!==entry.packageId)throw new StoreError('The official plugin manifest identity does not match its catalog entry',422);
    assertSupportedManifest(stored);
    const bytes=officialLocalArchive(directory,stored),digest=hash(bytes),manifest:PluginManifest={...stored,archive:{...stored.archive,sha256:digest}};
    return {manifest,localDirectory:entry.localDirectory,archiveUrl:localSourcePrefix+entry.localDirectory,preview:{id:randomUUID(),name:manifest.name,version:manifest.version,source:{repository:entry.repository,tag:entry.tag!,commit:digest.slice(0,40),digest},runtime:manifest.runtime,restartRequired:false,capabilities:manifest.capabilities.map(id=>({id,state:'unknown',reason:'Requires an instance capability check'})),dependencies:manifest.dependencies.map(dependencyLabel),access:[...manifest.access],issues:[],installable:true}};
  }
  private localReleaseArchive(release:ResolvedPluginRelease){
    const entry=officialLocalPluginEntry(release.preview.source.repository,release.preview.source.tag);
    if(!entry||entry.localDirectory!==release.localDirectory)throw new StoreError('The official plugin source is no longer in the catalog',409);
    const directory=officialPluginLocalDirectory(this.repoRoot,entry.localDirectory),stored=readOfficialLocalManifest(directory);
    if(entry.packageId&&stored.id!==entry.packageId)throw new StoreError('The official plugin manifest identity does not match its catalog entry',422);
    const bytes=officialLocalArchive(directory,stored),digest=hash(bytes),manifest:PluginManifest={...stored,archive:{...stored.archive,sha256:digest}};
    if(digest!==release.preview.source.digest||!isDeepStrictEqual(manifest,release.manifest))throw new StoreError('The release asset changed after review; resolve it again',409);
    return bytes;
  }
  async resolve(raw:{repository:string;tag?:string}):Promise<ResolvedPluginRelease>{
    const repo=repository(raw.repository),tag=raw.tag?.trim(),local=officialLocalPluginEntry(repo,tag);
    // The in-repository official artifact is addressed by its pinned synthetic
    // identity. A wrong tag is rejected here, never forwarded to GitHub.
    if(local)return this.resolveLocal(local);
    if(isOfficialLocalPluginRepository(repo))throw new StoreError('This official plugin source only resolves its pinned catalog release',422);
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
    assertSupportedManifest(manifest);
    const asset=release.assets.find(asset=>asset.name===manifest.archive.asset);if(!asset)throw new StoreError('The adapter archive is absent from the release',422);
    const archiveUrl=trustedAsset(asset.browser_download_url),bytes=(await this.transport(archiveUrl)).bytes,digest=hash(bytes);
    if(digest!==manifest.archive.sha256)throw new StoreError('The adapter archive failed integrity verification',422);
    validatePluginArchive(bytes,manifest);
    return {manifest,archiveUrl,preview:{id:randomUUID(),name:manifest.name,version:manifest.version,source:{repository:repo,tag:release.tag_name,commit,digest},runtime:manifest.runtime,restartRequired:false,capabilities:manifest.capabilities.map(id=>({id,state:'unknown',reason:'Requires an instance capability check'})),dependencies:manifest.dependencies.map(dependencyLabel),access:[...manifest.access],issues:[],installable:true}};
  }
  async install(release:ResolvedPluginRelease){
    const bytes=release.localDirectory?this.localReleaseArchive(release):(await this.transport(release.archiveUrl)).bytes;
    if(hash(bytes)!==release.preview.source.digest)throw new StoreError('The release asset changed after review; resolve it again',409);
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
