import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {MaterialRecord,MaterialStore} from '../materials.js';
import {StoreError,sha256} from '../store.js';
import type {OutboundExportDescriptor} from './service-plugin-loader.js';

type OutboundStatement={run(...values:unknown[]):unknown;get(...values:unknown[]):unknown;all(...values:unknown[]):unknown[]};
type OutboundDatabase={exec(sql:string):void;prepare(sql:string):OutboundStatement};
type OutboundStore={readonly db:OutboundDatabase;registerStorage(plugin:string,meters:Readonly<Record<string,string>>):void};

/** Screenshots and Coding Agent transcripts keep their existing Central
 * exposure restriction. An outbound package cannot widen that policy. */
const sensitiveMaterialKinds=new Set(['mote.screen-segment','mote.coding-session','mote.capture-event']);
const sensitiveSourceKinds=new Set(['screen','coding-agent']);
const defaultDescriptor:OutboundExportDescriptor=Object.freeze({
  apiVersion:1,id:'mote.host.markdown-export',
  format:Object.freeze({extension:'md',frontmatter:'yaml',folder:'Mote'}),
});
const maxMaterialCharacters=4_000_000;
const maxReadPages=400;

export type OutboundExportConflict={
  materialId:string;relativePath:string;revision:string;
  expectedHash:string|null;actualHash:string;at:string;
};
export type OutboundExportStatus={
  instanceId:string;active:boolean;targetConfigured:boolean;targetFolder?:string;
  scopeSourceIds:string[];lastSyncAt?:string;lastError?:string;
  exported:number;conflicts:OutboundExportConflict[];issues:string[];
};
export type OutboundExportTarget={ok:true;root:string;exists:boolean}|{ok:false;reason:string};
type ExportItemRow={
  instance_id:string;material_id:string;relative_path:string;revision:string|null;content_hash:string|null;
  state:'exported'|'conflict';conflict_hash:string|null;conflict_at:string|null;updated_at:string;
};

export interface OutboundExportHostDependencies {
  readonly store:OutboundStore;
  readonly materials:MaterialStore;
  readonly repoRoot:string;
  readonly dataDir:string;
  readonly home?:string;
  readonly sourceKind?:(sourceId:string)=>string|undefined;
  /** Background passes are deliberately slow: every pass re-reads targets to
   * detect edits, but unchanged material is never rewritten. */
  readonly intervalMs?:number;
}

const within=(parent:string,child:string)=>{
  const value=relative(parent,child);
  return value===''||(value!=='..'&&!value.startsWith('..'+sep)&&!isAbsolute(value));
};
const safeSlug=(value:string,limit:number)=>{
  const cleaned=value.normalize('NFC').replace(/[\\/\0-\x1f\x7f]+/g,'-').replace(/^\.+/,'').replace(/[. ]+$/,'').replace(/\s+/g,' ').trim();
  const limited=Array.from(cleaned).slice(0,limit).join('');
  return limited||'material';
};
const pathSegments=(value:string)=>value.split('/');

/** Central-owned continuous Markdown/Obsidian export. The package may name a
 * safe sub-folder, extension and frontmatter choice; this host owns the
 * revision cursor, the target sandbox, sensitive-source filtering and every
 * decision about overwriting a file the owner has edited. */
export class OutboundExportHost {
  private readonly active=new Map<string,{configuration:Record<string,string|number|boolean>;descriptor:OutboundExportDescriptor}>();
  private readonly queues=new Map<string,Promise<OutboundExportStatus>>();
  private timer?:NodeJS.Timeout;
  private closed=false;
  private readonly home:string;

  constructor(private readonly dependencies:OutboundExportHostDependencies){
    this.home=dependencies.home??homedir();
    const {store}=dependencies;
    store.db.exec(`CREATE TABLE IF NOT EXISTS outbound_export_items(
      instance_id TEXT NOT NULL,material_id TEXT NOT NULL,relative_path TEXT NOT NULL,
      revision TEXT,content_hash TEXT,state TEXT NOT NULL,conflict_hash TEXT,conflict_at TEXT,updated_at TEXT NOT NULL,
      PRIMARY KEY(instance_id,material_id));
      CREATE TABLE IF NOT EXISTS outbound_export_instances(
      instance_id TEXT PRIMARY KEY,last_sync_at TEXT,last_error TEXT);`);
    store.registerStorage('outbound-export',{
      outbound_export_items:"length(CAST(instance_id AS BLOB))+length(CAST(material_id AS BLOB))+length(CAST(relative_path AS BLOB))+length(CAST(COALESCE(revision,'') AS BLOB))+length(CAST(COALESCE(content_hash,'') AS BLOB))+length(CAST(COALESCE(conflict_hash,'') AS BLOB))+length(CAST(updated_at AS BLOB))+128",
      outbound_export_instances:"length(CAST(instance_id AS BLOB))+length(CAST(COALESCE(last_sync_at,'') AS BLOB))+length(CAST(COALESCE(last_error,'') AS BLOB))+64",
    });
  }

  /** Whether a configured root can ever become a write sandbox. This never
   * creates the directory and never requires it to exist. */
  inspectTarget(raw:string):OutboundExportTarget {
    const input=raw.trim();
    if(!input)return {ok:false,reason:'empty_path'};
    if(input.length>4096||/[\0\r\n]/.test(input)||input.includes('\\')||!isAbsolute(input))return {ok:false,reason:'not_absolute'};
    if(input.split(sep).some(part=>part==='.'||part==='..'))return {ok:false,reason:'parent_segment'};
    const absolute=resolve(input),root=resolve(absolute,sep);
    if(absolute===root)return {ok:false,reason:'filesystem_root'};
    let existing=absolute;
    while(!existsSync(existing)){
      const parent=dirname(existing);
      if(parent===existing)return {ok:false,reason:'unavailable'};
      existing=parent;
    }
    let realExisting:string,stat:ReturnType<typeof statSync>;
    try{realExisting=realpathSync(existing);stat=statSync(realExisting);}
    catch{return {ok:false,reason:'unavailable'};}
    if(!stat.isDirectory())return {ok:false,reason:'not_directory'};
    const suffix=relative(existing,absolute),resolved=resolve(realExisting,suffix),exists=existsSync(resolved);
    if(exists&&!statSync(resolved).isDirectory())return {ok:false,reason:'not_directory'};
    const repo=this.realOrResolve(this.dependencies.repoRoot),data=this.realOrResolve(this.dependencies.dataDir),home=this.realOrResolve(this.home);
    // The target may be a real Obsidian vault below the home directory, but it
    // may not be the repository, the Central data directory, the home folder
    // itself (or one of its ancestors), or a known credential directory.
    if(within(repo,resolved)||within(resolved,repo))return {ok:false,reason:'repository_overlap'};
    if(within(data,resolved)||within(resolved,data))return {ok:false,reason:'data_directory_overlap'};
    if(within(resolved,home))return {ok:false,reason:'home_or_ancestor'};
    for(const denied of [join(home,'.ssh'),join(home,'.aws'),join(home,'.gnupg'),join(home,'Library','Keychains')])
      if(within(this.realOrResolve(denied),resolved))return {ok:false,reason:'sensitive_directory'};
    return {ok:true,root:resolved,exists};
  }

  async activate(instanceId:string,input:{descriptor:OutboundExportDescriptor;configuration:Record<string,string|number|boolean>}){
    if(this.closed)throw new StoreError('Outbound export host is closed',503);
    this.active.set(instanceId,{descriptor:input.descriptor,configuration:{...input.configuration}});
    this.ensureTimer();
    // Enable opens the gate; it does not promise that this first pass wrote
    // anything. Failures stay visible through status instead of blocking the
    // durable enable command.
    void this.sync(instanceId,input.configuration).catch(error=>this.noteError(instanceId,error));
  }

  async deactivate(instanceId:string){
    this.active.delete(instanceId);
    if(!this.active.size)this.stopTimer();
  }

  status(instanceId:string,configuration?:Record<string,string|number|boolean>):OutboundExportStatus {
    const values=configuration??this.active.get(instanceId)?.configuration??{};
    const target=typeof values.targetFolder==='string'?values.targetFolder.trim():'';
    const scope=this.scope(values),row=this.instanceRow(instanceId);
    const issues:[string,string|null][]=[];
    if(!target)issues.push(['outbound_target_not_configured',null]);
    else{
      const inspected=this.inspectTarget(target);
      if(!inspected.ok)issues.push(['outbound_target_unsafe',inspected.reason]);
    }
    if(scope.issue)issues.push(['outbound_scope_invalid',scope.issue]);
    else if(!scope.ids.length)issues.push(['outbound_scope_empty',null]);
    const conflicts=(this.dependencies.store.db.prepare(`SELECT material_id,relative_path,revision,content_hash,conflict_hash,conflict_at
      FROM outbound_export_items WHERE instance_id=? AND state='conflict' ORDER BY conflict_at DESC LIMIT 100`).all(instanceId) as Pick<ExportItemRow,'material_id'|'relative_path'|'revision'|'content_hash'|'conflict_hash'|'conflict_at'>[])
      .map(row=>({materialId:row.material_id,relativePath:row.relative_path,revision:row.revision??'',expectedHash:row.content_hash,actualHash:row.conflict_hash??'',at:row.conflict_at??''}));
    const exported=Number((this.dependencies.store.db.prepare(`SELECT count(*) AS value FROM outbound_export_items WHERE instance_id=? AND state='exported'`).get(instanceId) as {value:number}).value);
    return {instanceId,active:this.active.has(instanceId),targetConfigured:Boolean(target),...(target?{targetFolder:target}:{}),
      scopeSourceIds:scope.ids,lastSyncAt:row?.last_sync_at??undefined,lastError:row?.last_error??undefined,
      exported,conflicts,issues:issues.map(([name,detail])=>detail?`${name}:${detail}`:name)};
  }

  sync(instanceId:string,configuration?:Record<string,string|number|boolean>):Promise<OutboundExportStatus> {
    if(this.closed)return Promise.reject(new StoreError('Outbound export host is closed',503));
    const prior=this.queues.get(instanceId)??Promise.resolve();
    const task=prior.catch(()=>{}).then(()=>this.runSync(instanceId,configuration));
    this.queues.set(instanceId,task);
    void task.finally(()=>{if(this.queues.get(instanceId)===task)this.queues.delete(instanceId);}).catch(()=>{});
    return task;
  }

  async close(){
    this.closed=true;
    this.active.clear();
    this.stopTimer();
    await Promise.allSettled([...this.queues.values()]);
  }

  private async runSync(instanceId:string,configuration?:Record<string,string|number|boolean>):Promise<OutboundExportStatus> {
    const values=configuration??this.active.get(instanceId)?.configuration??{};
    const descriptor=this.active.get(instanceId)?.descriptor??defaultDescriptor;
    const targetValue=typeof values.targetFolder==='string'?values.targetFolder.trim():'',target=targetValue?this.inspectTarget(targetValue):undefined;
    const scope=this.scope(values);
    if(!target?.ok||!scope.ids.length){
      this.saveInstance(instanceId);
      return this.status(instanceId,values);
    }
    try{
      for(const sourceId of scope.ids){
        const kind=this.dependencies.sourceKind?.(sourceId);
        if(kind&&sensitiveSourceKinds.has(kind))continue;
        let cursor:string|undefined,pages=0;
        do{
          if(++pages>1000)throw new StoreError('Outbound export source exceeds the host page budget',413);
          const page=this.dependencies.materials.list({sourceId,limit:100,cursor});
          for(const material of page.items)this.exportMaterial(instanceId,target.root,descriptor,material);
          cursor=page.nextCursor??undefined;
        }while(cursor);
      }
      this.saveInstance(instanceId);
      return this.status(instanceId,values);
    }catch(error){
      this.noteError(instanceId,error);
      throw error;
    }
  }

  private exportMaterial(instanceId:string,root:string,descriptor:OutboundExportDescriptor,material:MaterialRecord){
    if(sensitiveMaterialKinds.has(material.kind))return;
    const previous=this.item(instanceId,material.id),relativePath=previous?.relative_path??this.relativePath(descriptor,material);
    const existing=this.readTarget(root,relativePath),existingHash=existing===undefined?undefined:sha256(existing);
    if(existingHash!==undefined){
      if(!previous||previous.content_hash===null){
        this.recordConflict(instanceId,material,relativePath,null,existingHash);
        return;
      }
      if(existingHash!==previous.content_hash){
        this.recordConflict(instanceId,material,relativePath,previous.content_hash,existingHash);
        return;
      }
    }
    if(previous?.state==='exported'&&previous.revision===material.revision&&existingHash===previous.content_hash)return;
    const text=this.materialText(material),content=this.render(descriptor,material,text),hash=sha256(content);
    this.writeTarget(root,relativePath,content);
    this.dependencies.store.db.prepare(`INSERT INTO outbound_export_items(instance_id,material_id,relative_path,revision,content_hash,state,conflict_hash,conflict_at,updated_at)
      VALUES(?,?,?,?,?,'exported',NULL,NULL,?) ON CONFLICT(instance_id,material_id) DO UPDATE SET
      relative_path=excluded.relative_path,revision=excluded.revision,content_hash=excluded.content_hash,state='exported',conflict_hash=NULL,conflict_at=NULL,updated_at=excluded.updated_at`)
      .run(instanceId,material.id,relativePath,material.revision,hash,new Date().toISOString());
  }

  private materialText(material:MaterialRecord){
    let offset=0,text='';
    for(let page=0;page<maxReadPages;page++){
      const read=this.dependencies.materials.read(material.ref,{offset,length:12000});
      text+=read.text;
      if(text.length>maxMaterialCharacters)throw new StoreError('Outbound export material exceeds the host text budget',413);
      const next=read.textRange.nextOffset;
      if(next===null)return text;
      if(next<=offset)throw new StoreError('Outbound export material read made no progress',500);
      offset=next;
    }
    throw new StoreError('Outbound export material exceeds the host read budget',413);
  }

  private render(descriptor:OutboundExportDescriptor,material:MaterialRecord,text:string){
    const title=material.title.replace(/[\r\n]+/g,' ').trim();
    const lines:string[]=[];
    if(descriptor.format.frontmatter==='yaml')lines.push('---',
      `mote_id: ${JSON.stringify(material.id)}`,`mote_revision: ${JSON.stringify(material.revision)}`,
      `title: ${JSON.stringify(title)}`,`source: ${JSON.stringify(material.origin.sourceId)}`,
      `kind: ${JSON.stringify(material.kind)}`,`updated_at: ${JSON.stringify(material.updatedAt)}`,
      `exported_at: ${JSON.stringify(new Date().toISOString())}`,'---','');
    lines.push(`# ${title||'Mote material'}`,'',text);
    return lines.join('\n');
  }

  private relativePath(descriptor:OutboundExportDescriptor,material:MaterialRecord){
    const id=material.id.replace(/^mat_/,'').slice(0,12);
    return [descriptor.format.folder,safeSlug(material.origin.sourceId,48),`${safeSlug(material.title,72)}-${id}.${descriptor.format.extension}`].join('/');
  }

  private item(instanceId:string,materialId:string){
    return this.dependencies.store.db.prepare('SELECT * FROM outbound_export_items WHERE instance_id=? AND material_id=?').get(instanceId,materialId) as ExportItemRow|undefined;
  }

  private recordConflict(instanceId:string,material:MaterialRecord,relativePath:string,expectedHash:string|null,actualHash:string){
    const now=new Date().toISOString();
    this.dependencies.store.db.prepare(`INSERT INTO outbound_export_items(instance_id,material_id,relative_path,revision,content_hash,state,conflict_hash,conflict_at,updated_at)
      VALUES(?,?,?,?,?,'conflict',?,?,?) ON CONFLICT(instance_id,material_id) DO UPDATE SET
      relative_path=excluded.relative_path,state='conflict',conflict_hash=excluded.conflict_hash,conflict_at=excluded.conflict_at,updated_at=excluded.updated_at`)
      .run(instanceId,material.id,relativePath,material.revision,expectedHash,actualHash,now,now);
  }

  private readTarget(root:string,relativePath:string){
    const target=this.targetPath(root,relativePath);
    if(!existsSync(target))return undefined;
    return readFileSync(target);
  }

  private writeTarget(root:string,relativePath:string,content:string){
    const target=this.targetPath(root,relativePath),parent=dirname(target);
    mkdirSync(parent,{recursive:true,mode:0o700});
    let parentReal:string;
    try{parentReal=realpathSync(parent);}catch{throw new StoreError('Outbound export target folder is unavailable',422);}
    if(!within(root,parentReal))throw new StoreError('Outbound export path escapes the configured target folder',422);
    const temporary=join(parent,`.mote-export-${randomUUID()}.tmp`);
    try{
      writeFileSync(temporary,content,{mode:0o600,flag:'wx'});
      renameSync(temporary,target);
    }finally{rmSync(temporary,{force:true});}
  }

  /** Every segment is checked before use. A symlink below the configured root
   * is rejected rather than followed; the root itself is already realpath'ed. */
  private targetPath(root:string,relativePath:string){
    const segments=pathSegments(relativePath);
    if(!segments.length||segments.some(part=>!part||part==='.'||part==='..'||part.includes('\\')||part.includes('\0')))throw new StoreError('Outbound export path is invalid',422);
    let target=root;
    for(const [index,part] of segments.entries()){
      target=join(target,part);
      if(!within(root,target))throw new StoreError('Outbound export path escapes the configured target folder',422);
      try{
        const stat=lstatSync(target);
        if(stat.isSymbolicLink())throw new StoreError('Outbound export path crosses a symbolic link',422);
        if(index<segments.length-1){if(!stat.isDirectory())throw new StoreError('Outbound export path has an invalid file type',422);}
        else if(!stat.isFile())throw new StoreError('Outbound export path has an invalid file type',422);
      }catch(error){if(error instanceof StoreError)throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    }
    const value=relative(root,target);
    if(!value||value.startsWith('..'+sep)||value==='..'||isAbsolute(value))throw new StoreError('Outbound export path escapes the configured target folder',422);
    return target;
  }

  private scope(configuration:Record<string,string|number|boolean>){
    const raw=typeof configuration.sourceIds==='string'?configuration.sourceIds:'';
    const values=[...new Set(raw.split(/[,;\n]/).map(value=>value.trim()).filter(Boolean))];
    if(values.some(value=>value==='*'))return {ids:[] as string[],issue:'wildcard' as const};
    if(values.some(value=>value.length>128||/[\0\r\n]/.test(value)))return {ids:[] as string[],issue:'invalid_source_id' as const};
    return {ids:values,issue:undefined};
  }

  private instanceRow(instanceId:string){
    return this.dependencies.store.db.prepare('SELECT last_sync_at,last_error FROM outbound_export_instances WHERE instance_id=?').get(instanceId) as {last_sync_at:string|null;last_error:string|null}|undefined;
  }

  private saveInstance(instanceId:string){
    const now=new Date().toISOString();
    this.dependencies.store.db.prepare(`INSERT INTO outbound_export_instances(instance_id,last_sync_at,last_error) VALUES(?,?,NULL)
      ON CONFLICT(instance_id) DO UPDATE SET last_sync_at=excluded.last_sync_at,last_error=NULL`).run(instanceId,now);
  }

  private noteError(instanceId:string,error:unknown){
    const message=error instanceof StoreError?error.message:error instanceof Error?error.message:'outbound_export_failed';
    this.dependencies.store.db.prepare(`INSERT INTO outbound_export_instances(instance_id,last_sync_at,last_error) VALUES(?,?,?)
      ON CONFLICT(instance_id) DO UPDATE SET last_error=excluded.last_error`).run(instanceId,new Date().toISOString(),message.slice(0,500));
  }

  private ensureTimer(){
    if(this.timer||this.closed)return;
    this.timer=setInterval(()=>{
      for(const instanceId of this.active.keys())void this.sync(instanceId).catch(error=>this.noteError(instanceId,error));
    },this.dependencies.intervalMs??60000);
    this.timer.unref?.();
  }

  private stopTimer(){if(this.timer){clearInterval(this.timer);this.timer=undefined;}}

  private realOrResolve(value:string){
    try{return realpathSync(value);}catch{return resolve(value);}
  }
}
