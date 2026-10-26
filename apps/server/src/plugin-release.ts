import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {unzipSync} from 'fflate';
import {z} from 'zod';
import {calendarPluginCapabilitySchema} from '@mote/shared';
import type {PluginConfigurationField,PluginReleasePreview} from '@mote/shared';
import {StoreError} from './store.js';

const relativePath=z.string().min(1).refine(value=>!value.startsWith('/')&&!value.includes('\\')&&!value.split('/').some(part=>part==='..'||part==='.'||part===''),'Invalid package path');
const fieldSchema=z.object({id:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),label:z.string().min(1),type:z.enum(['text','number','boolean','select','model-profile','secret-reference']),required:z.boolean().optional(),options:z.array(z.object({value:z.string(),label:z.string()}).strict()).optional(),description:z.string().optional()}).strict();
/** The release is an executable Mote adapter, not an arbitrary GitHub project.
 * All dependencies must be bundled; the host never runs package install scripts. */
export const pluginManifestSchema=z.object({
  schemaVersion:z.literal(1),id:z.string().regex(/^[a-z][a-z0-9.-]{2,127}$/),name:z.string().min(1),version:z.string().min(1),
  runtime:z.literal('worker'),entry:relativePath,archive:z.object({asset:z.string().regex(/^[^/\\]+\.zip$/),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  capabilities:z.array(z.enum(['repository','retrieval','engine','calendar.create'])).nonempty(),actionCapabilities:z.array(calendarPluginCapabilitySchema).max(1).optional(),configuration:z.array(fieldSchema),dependencies:z.array(z.string()),access:z.array(z.string()),
}).strict().superRefine((value,context)=>{if(value.capabilities.includes('calendar.create')!==Boolean(value.actionCapabilities?.length))context.addIssue({code:'custom',message:'Calendar capability requires its complete host execution declaration'});});
export type PluginManifest=z.infer<typeof pluginManifestSchema>;
export type ResolvedPluginRelease={preview:PluginReleasePreview;manifest:PluginManifest;archiveUrl:string;hostAdapter?:'mote.mem0@1'|'mote.hindsight@1'};
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

export class GitHubPluginReleases {
  constructor(readonly directory:string,private transport:PluginReleaseTransport=publicTransport){}
  async resolve(raw:{repository:string;tag?:string}):Promise<ResolvedPluginRelease>{
    const repo=repository(raw.repository),tag=raw.tag?.trim()||(repo==='mem0ai/mem0'?'ts-v3.3.1':repo==='vectorize-io/hindsight'?'v0.10.2':undefined);
    const path=`https://api.github.com/repos/${repo}`;
    const release=z.object({tag_name:z.string(),draft:z.boolean(),assets:z.array(z.object({id:z.number().int().positive().optional(),name:z.string(),browser_download_url:z.string().url()}))}).passthrough().parse(parseJson((await this.transport(`${path}/releases/${tag?'tags/'+encodeURIComponent(tag):'latest'}`)).bytes));
    if(release.draft)throw new StoreError('Choose a published, fixed GitHub release');
    const commit=z.object({sha:z.string().regex(/^[a-f0-9]{40}$/)}).passthrough().parse(parseJson((await this.transport(`${path}/commits/${encodeURIComponent(release.tag_name)}`)).bytes)).sha;
    const trustedAsset=(url:string)=>{const value=new URL(url);if(value.protocol!=='https:'||value.hostname!=='github.com'||!value.pathname.startsWith('/'+repo+'/releases/download/'+encodeURIComponent(release.tag_name)+'/')||value.username||value.password)throw new StoreError('The adapter asset is outside the selected GitHub release');return url;};
    const manifestAsset=release.assets.find(asset=>asset.name==='mote-plugin.json');
    if(!manifestAsset&&((repo==='mem0ai/mem0'&&release.tag_name==='ts-v3.3.1')||(repo==='vectorize-io/hindsight'&&release.tag_name==='v0.10.2'))){
      // Tested compatibility recipes ship with this exact Mote build. The
      // upstream source archive is pinned and installed for provenance; the
      // executable adapter and SDK are locked host distribution dependencies.
      const mem0=repo==='mem0ai/mem0';
      // The official Hindsight repository zipball includes >177 MiB of docs
      // and build tooling. Pin its released API source wheel (a ZIP container)
      // instead; the controlled runtime still comes from the pinned host image.
      // This exact recipe keeps every generic transport/expansion bound intact.
      const apiSource=mem0?undefined:release.assets.find(asset=>asset.name==='hindsight_api_slim-0.10.2-py3-none-any.whl');
      if(!mem0&&!apiSource)throw new StoreError('The pinned Hindsight API source wheel is absent from the release',422);
      if(apiSource)trustedAsset(apiSource.browser_download_url);
      const archiveUrl=mem0?`${path}/zipball/${commit}`:apiSource!.id?`${path}/releases/assets/${apiSource!.id}`:apiSource!.browser_download_url,bytes=(await this.transport(archiveUrl)).bytes,digest=hash(bytes);
      const configuration:PluginManifest['configuration']=mem0?[
        {id:'embeddingBaseUrl',label:'Embedding endpoint',type:'text',required:true},
        {id:'embeddingModel',label:'Embedding model',type:'text',required:true},
        {id:'embeddingDimension',label:'Embedding dimension',type:'number',required:true},
        {id:'embeddingSecretReference',label:'Embedding secret reference',type:'secret-reference'},
      ]:[{id:'modelProfileId',label:'Model profile',type:'model-profile',required:true}];
      const manifest:PluginManifest={schemaVersion:1,id:mem0?'mote.mem0':'mote.hindsight',name:mem0?'Mem0 (Mote adapter)':'Hindsight (Mote adapter)',version:mem0?'3.3.1':'0.10.2',runtime:'worker',entry:'host-adapter.mjs',archive:{asset:mem0?'upstream-source.zip':'upstream-api-source.zip',sha256:digest},capabilities:mem0?['repository','retrieval']:['engine'],configuration,dependencies:mem0?['Bundled Mote adapter@1','mem0ai@3.3.1','better-sqlite3@12.10.0']:['Bundled Mote adapter@1','Docker with the pinned Hindsight service@0.10.2 image and an owned scoped worker'],access:['Central private plugin storage','Configured provider endpoints']};
      this.validateArchive(bytes,manifest,true);
      return {manifest,archiveUrl,hostAdapter:mem0?'mote.mem0@1':'mote.hindsight@1',preview:{id:randomUUID(),name:manifest.name,version:manifest.version,source:{repository:repo,tag:release.tag_name,commit,digest},runtime:'service',restartRequired:false,capabilities:manifest.capabilities.map(id=>({id,state:'unknown',reason:'Requires an actual instance capability check'})),dependencies:manifest.dependencies,access:manifest.access,issues:[mem0?'The upstream source is pinned. This Mote build supplies the executable compatibility adapter.':'The pinned upstream API source is hindsight_api_slim-0.10.2-py3-none-any.whl. This Mote build supplies the executable compatibility adapter and pinned Docker runtime.'],installable:true}};
    }
    if(!manifestAsset)throw new StoreError('This release has no Mote adapter manifest (mote-plugin.json). Install a compatible adapter release.',422);
    const manifest=pluginManifestSchema.parse(parseJson((await this.transport(trustedAsset(manifestAsset.browser_download_url))).bytes));
    const asset=release.assets.find(asset=>asset.name===manifest.archive.asset);if(!asset)throw new StoreError('The adapter archive is absent from the release',422);
    const archiveUrl=trustedAsset(asset.browser_download_url),bytes=(await this.transport(archiveUrl)).bytes,digest=hash(bytes);
    if(digest!==manifest.archive.sha256)throw new StoreError('The adapter archive failed integrity verification',422);
    this.validateArchive(bytes,manifest);
    return {manifest,archiveUrl,preview:{id:randomUUID(),name:manifest.name,version:manifest.version,source:{repository:repo,tag:release.tag_name,commit,digest},runtime:'worker',restartRequired:false,capabilities:manifest.capabilities.map(id=>({id,state:'unknown',reason:'Requires an instance capability check'})),dependencies:manifest.dependencies,access:manifest.access,issues:[],installable:true}};
  }
  private validateArchive(bytes:Uint8Array,manifest:PluginManifest,hostAdapter=false){
    if(bytes.length>archiveBytes)throw new StoreError('Plugin archive exceeds the host resource budget',413);
    let entries:ReturnType<typeof unzipSync>,total=0,count=0;try{entries=unzipSync(bytes,{filter:file=>{
      if(++count>entryCount||file.originalSize>entryBytes||(total+=file.originalSize)>expandedBytes)throw new StoreError('Plugin archive exceeds the host expansion resource budget',413);
      if(!relativePath.safeParse(file.name.endsWith('/')?file.name.slice(0,-1):file.name).success)throw new StoreError('Invalid package path',422);return true;
    }});}catch(error){if(error instanceof StoreError)throw error;throw new StoreError('The adapter archive is invalid',422);}
    for(const path of Object.keys(entries))if(!path.endsWith('/'))relativePath.parse(path);
    if(!hostAdapter&&!entries[manifest.entry])throw new StoreError('The adapter entry is missing from its archive',422);
    return entries;
  }
  async install(release:ResolvedPluginRelease){
    const bytes=(await this.transport(release.archiveUrl)).bytes;if(hash(bytes)!==release.preview.source.digest)throw new StoreError('The release asset changed after review; resolve it again',409);
    const entries=this.validateArchive(bytes,release.manifest,Boolean(release.hostAdapter)),destination=join(this.directory,release.preview.source.digest),temporary=destination+'.'+randomUUID();
    await mkdir(this.directory,{recursive:true,mode:0o700});
    try{
      // An installed immutable artifact may be reused only after rechecking its lock.
      try{await readFile(join(destination,'mote-install-lock.json'));this.verifyInstalled(destination,release.preview.source.digest,release.manifest,Boolean(release.hostAdapter));return destination;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await mkdir(temporary,{mode:0o700});
      for(const [path,data] of Object.entries(entries)){if(path.endsWith('/'))continue;const target=join(temporary,path);await mkdir(join(target,'..'),{recursive:true,mode:0o700});await writeFile(target,data,{mode:0o600});}
      await writeFile(join(temporary,'mote-install-lock.json'),JSON.stringify({digest:release.preview.source.digest,source:release.preview.source,manifest:release.manifest}),{mode:0o600});
      await writeFile(join(temporary,'mote-source.zip'),bytes,{mode:0o600});
      await rename(temporary,destination);return destination;
    }finally{await rm(temporary,{recursive:true,force:true});}
  }
  verifyInstalled(directory:string,digest:string,manifest:PluginManifest,hostAdapter=false){
    try{
      const source=readFileSync(join(directory,'mote-source.zip'));if(hash(source)!==digest)throw Error('archive_hash');
      const entries=this.validateArchive(source,manifest,hostAdapter),expected=new Set(Object.keys(entries).filter(path=>!path.endsWith('/')));
      expected.add('mote-install-lock.json');expected.add('mote-source.zip');
      const walk=(relative='')=>{for(const file of readdirSync(join(directory,relative))){const path=relative?relative+'/'+file:file,stat=lstatSync(join(directory,path));if(stat.isSymbolicLink())throw Error('link');if(stat.isDirectory())walk(path);else if(!stat.isFile()||!expected.has(path))throw Error('unexpected_file');}};walk();
      for(const [path,data] of Object.entries(entries))if(!path.endsWith('/')&&hash(readFileSync(join(directory,path)))!==hash(data))throw Error('entry_hash');
      if(JSON.parse(readFileSync(join(directory,'mote-install-lock.json'),'utf8')).digest!==digest)throw Error('lock_hash');
    }catch{throw new StoreError('Installed adapter integrity mismatch; remove the cached artifact and resolve it again',409);}
  }
  schema(manifest:PluginManifest):PluginConfigurationField[]{return manifest.configuration;}
}
