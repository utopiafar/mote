import {createHash,randomUUID} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,fsyncSync,lstatSync,openSync,readFileSync,readdirSync,readlinkSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve,sep} from 'node:path';
import type {StateRecord,StateStore,StateValue} from '@mote/plugin-api';
import type {NativeApplicationContext,NativeApplicationExposure,NativeDshApplication} from '@mote/agent/runtime/dsh';
import type {DshConfiguration} from './dsh-configuration.js';
import {dshInstanceKey,NATIVE_OUTPUT_CAPABILITY} from './dsh-configuration.js';
import {privateDirectory} from './private-storage.js';
import {MAX_FILE_BYTES,archiveRelativePath} from './archived-files.js';
import {StoreError,type Store} from './store.js';
import {bindInstanceStateCommit} from './plugins/instance-state.js';
import {replaceContentFile} from './content-encryption.js';

type Profile=DshConfiguration['profiles'][number];
export type NativeOutput={path:string;mimeType:string;bytes:Buffer};
export interface NativeOutputPublication {
  readonly sourceKey:string;
  readonly profileId:string;
  readonly conversationId:string;
  readonly outputs:readonly NativeOutput[];
  readonly receipts:readonly NativeApplicationExposure[];
  /** The actual issuer is a current installed Host activation plus the exact
   * owner profile/output grant. This is checked in the intake transaction. */
  assertCurrent():void;
  /** Called once inside the same SQLite transaction as all source products. */
  acceptCheckpoint():void;
}
export type PublishNativeOutputs=(publication:NativeOutputPublication)=>Promise<void>;
type Control={version:1;identity:string;accepted?:string;pending?:string;writer?:{pid:number;token:string}};
type WorkingMarker={version:1;identity:string;token:string;receiptHashes:string[]};
type ProtectedManifest=WorkingMarker&{files:{path:string;hash:string}[];unsupported:{path:string;kind:string;target?:string}[]};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const held=new Set<string>();
const live=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}};
const conflict=()=>new StoreError('Native application state is unavailable; its private input is retained',409);
const writerBusy=()=>Object.assign(new StoreError('Native application conversation already has a writer',409),{code:'native_application_busy'});
const value=<T>(record:StateRecord|undefined)=>record?.value as T|undefined;
const stateValue=(value:unknown)=>JSON.parse(JSON.stringify(value)) as StateValue;
const owned=(uid:number)=>!process.getuid||uid===process.getuid();

/** Exact regular-file reads after SDK quiescence. File descriptors pin bytes;
 * parent and leaf identities are checked again before they can be published. */
export function readNativeFile(root:string,path:string,limit=MAX_FILE_BYTES):Buffer|undefined {
  return readStoredFile(root,path,limit,false);
}
function readStoredFile(root:string,path:string,limit:number,retainHardlink:boolean):Buffer|undefined {
  archiveRelativePath(path);
  const base=resolve(root),target=join(base,path),parents:string[]=[base];
  for(let directory=dirname(target);directory!==base;directory=dirname(directory)){
    if(!directory.startsWith(base+sep))throw conflict();parents.push(directory);
  }
  let pins:{directory:string;info:NonNullable<ReturnType<typeof lstatSync>>}[];
  try{pins=parents.map(directory=>{const info=lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink()||!owned(info.uid))throw conflict();return {directory,info};});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  let fd:number;
  try{fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  try{
    const before=fstatSync(fd),leaf=lstatSync(target);
    if(!before.isFile()||!retainHardlink&&before.nlink!==1||!owned(before.uid)||leaf.isSymbolicLink()||before.dev!==leaf.dev||before.ino!==leaf.ino||!realpathSync(target).startsWith(realpathSync(base)+sep))throw conflict();
    if(before.size>limit)throw new StoreError('Native application file exceeds the file processing limit',413);
    const bytes=readFileSync(fd),after=fstatSync(fd),current=lstatSync(target);
    if(bytes.length!==before.size||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||current.dev!==before.dev||current.ino!==before.ino||current.isSymbolicLink())throw conflict();
    for(const {directory,info} of pins){const current=lstatSync(directory);if(!current.isDirectory()||current.isSymbolicLink()||current.dev!==info.dev||current.ino!==info.ino)throw conflict();}
    return bytes;
  }finally{closeSync(fd);}
}

/** Host-only persistence over the existing instance StateStore and private
 * ContentEncryption. The original SDK owns its JSONL session/workspace format. */
export function openNativeApplication(input:{store:Store;state:StateStore;profile:Profile;context:NativeApplicationContext;assertCurrent():void;publish:PublishNativeOutputs}):NativeDshApplication {
  const {store,state,profile,context}=input,selection=profile.application;
  if(!selection||!profile.grants.some(grant=>dshInstanceKey(grant.instance)===dshInstanceKey(selection.instance)&&grant.capabilities.includes(NATIVE_OUTPUT_CAPABILITY)))throw new StoreError('Native application outputs require an explicit installed capability and owner grant',403);
  const identity=digest([selection.instance,profile.modelProfileId,context.conversationId,profile.assembly,selection]),prefix='dsh-app/'+identity+'/',controlKey=prefix+'control',receiptPrefix=prefix+'exposure/';
  const parent=join(store.directory,'native-applications'),root=join(parent,identity),working=join(root,'working'),home=join(working,'home'),workspace=join(working,'workspace'),generations=join(root,'generations');
  const lease=randomUUID(),localKey=store.directory+'\0'+identity,receipts=new Map<string,NativeApplicationExposure>(),baseline=new Map<string,string|undefined>();
  const commitState=bindInstanceStateCommit(state,controlKey);
  let control:StateRecord|undefined,prepared=false,admitted=false,released=false,token:string|undefined,baseToken:string|undefined,accepted=false;
  const assertCurrent=()=>{input.assertCurrent();for(const receipt of receipts.values())context.assertExposure(receipt);};
  const receiptHashes=()=>[...receipts.keys()].map(key=>key.slice(receiptPrefix.length)).sort();
  const assertReceipts=(marker:WorkingMarker)=>{
    if(marker.version!==1||marker.identity!==identity||!Array.isArray(marker.receiptHashes)||marker.receiptHashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash)||!receipts.has(receiptPrefix+hash)))throw conflict();
  };
  const markWorking=()=>replaceContentFile(join(working,'interaction'),Buffer.from(JSON.stringify({version:1,identity,token:token!,receiptHashes:receiptHashes()} satisfies WorkingMarker)));
  const cas=async(next:Control)=>{assertCurrent();const saved=await state.compareAndSet(controlKey,control?.revision??null,stateValue(next));control=saved;assertCurrent();return saved;};
  async function loadReceipts(suffix=''){
    const rows=await state.list(receiptPrefix+suffix,1000);input.assertCurrent();
    if(rows.length===1000){for(const hex of '0123456789abcdef')await loadReceipts(suffix+hex);return;}
    for(const row of rows){const receipt=value<NativeApplicationExposure>(row);if(!receipt||row.key!==receiptPrefix+digest(receipt))throw conflict();context.assertExposure(receipt);receipts.set(row.key,receipt);}
  }
  async function retain(receipt:NativeApplicationExposure){
    assertCurrent();const captured=context.captureExposure(receipt),key=receiptPrefix+digest(captured);context.assertExposure(captured);
    if(!receipts.has(key)){const existing=await state.get(key);assertCurrent();if(existing){if(digest(existing.value)!==digest(captured))throw conflict();}else await state.compareAndSet(key,null,stateValue(captured));context.assertExposure(captured);receipts.set(key,captured);}
    if(prepared)markWorking();
    assertCurrent();
  }
  const makeDirectories=()=>{for(const directory of [parent,root,generations])privateDirectory(directory);};
  const collect=():Pick<ProtectedManifest,'files'|'unsupported'>=>{
    const files:ProtectedManifest['files']=[],unsupported:ProtectedManifest['unsupported']=[];
    const walk=(directory:string)=>{privateDirectory(directory);for(const entry of readdirSync(directory).sort()){
      const path=join(directory,entry),info=lstatSync(path),name=relative(working,path).split(sep).join('/');
      if(info.isSymbolicLink())unsupported.push({path:name,kind:'symlink',target:readlinkSync(path)});
      else if(info.isDirectory())walk(path);
      else if(info.isFile()&&owned(info.uid)){files.push({path:name,hash:''});if(info.nlink!==1)unsupported.push({path:name,kind:'hardlink'});}
      else throw conflict();
    }};walk(working);return {files,unsupported};
  };
  function protectPending(){
    if(!prepared||!token||!existsSync(working))return false;
    const destination=join(generations,token);privateDirectory(destination);
    const {files,unsupported}=collect();
    for(const [index,file] of files.entries()){
      // A hardlink's bytes are retained privately, but the manifest is marked
      // unsupported and cannot resume/publish. Symlink targets are never read.
      const bytes=readStoredFile(working,file.path,Number.MAX_SAFE_INTEGER,true);if(!bytes)throw conflict();file.hash=bytesHash(bytes);store.contentEncryption.write(join(destination,String(index)),bytes);
    }
    store.contentEncryption.write(join(destination,'manifest'),Buffer.from(JSON.stringify({version:1,identity,token,receiptHashes:receiptHashes(),files,unsupported} satisfies ProtectedManifest)));
    // This removes only the exact quiesced working copy after a durable private
    // replacement exists. It grants no accepted checkpoint or output authority.
    rmSync(working,{recursive:true});
    return unsupported.length>0;
  }
  function restore(selected:string|undefined){
    if(existsSync(working)){
      const raw=readNativeFile(working,'interaction');if(!raw)throw conflict();const marker=JSON.parse(raw.toString()) as WorkingMarker;assertReceipts(marker);
      if(![value<Control>(control)?.pending,value<Control>(control)?.accepted].includes(marker.token))throw conflict();
      return; // interrupted active input is newer than its accepted snapshot
    }
    const staging=join(root,'restore-'+lease);privateDirectory(staging);
    let restored=false;
    try{
    if(selected){
      const directory=join(generations,selected);privateDirectory(directory);
      const manifest=JSON.parse(store.contentEncryption.read(join(directory,'manifest')).toString()) as ProtectedManifest;
      assertReceipts(manifest);
      if(manifest.version!==1||manifest.identity!==identity||manifest.token!==selected||!Array.isArray(manifest.files)||!Array.isArray(manifest.unsupported)||manifest.unsupported.length)throw conflict();
      const seen=new Set<string>();
      for(const [index,file] of manifest.files.entries()){
        archiveRelativePath(file.path);if(seen.has(file.path)||!['home','workspace','interaction'].includes(file.path.split('/')[0]!))throw conflict();seen.add(file.path);
        const bytes=store.contentEncryption.read(join(directory,String(index)));if(bytesHash(bytes)!==file.hash)throw conflict();
        const target=join(staging,file.path);privateDirectory(dirname(target));writeFileSync(target,bytes,{mode:0o600,flag:'wx'});
      }
    }
    renameSync(staging,working);restored=true;
    }finally{if(!restored)rmSync(staging,{recursive:true,force:true});}
  }
  return {sessionId:'mote-app-'+identity,home,workspace,assertCurrent,
    async prepare(seed){
      if(prepared||released)throw conflict();input.assertCurrent();
      if(held.has(localKey))throw writerBusy();
      held.add(localKey);admitted=true;
      try{
        control=await state.get(controlKey);input.assertCurrent();const prior=value<Control>(control);
        if(prior&&(prior.version!==1||prior.identity!==identity))throw conflict();
        if(prior?.writer&&prior.writer.pid!==process.pid&&live(prior.writer.pid))throw writerBusy();
        await loadReceipts();assertCurrent();
        // The whole ledger is checked before decrypting even the first history
        // file, including disclosures from failed and cancelled interactions.
        for(const receipt of context.initialExposures)await retain(receipt);await retain(seed);
        makeDirectories();baseToken=prior?.pending??prior?.accepted;restore(baseToken);
        if(collect().unsupported.length)throw conflict();
        privateDirectory(home);privateDirectory(workspace);
        for(const output of selection.outputs){const bytes=readNativeFile(workspace,output.path);baseline.set(output.path,bytes&&bytesHash(bytes));}
        token=randomUUID();await cas({version:1,identity,...(prior?.accepted?{accepted:prior.accepted}:{}),pending:token,writer:{pid:process.pid,token:lease}});
        prepared=true;markWorking();assertCurrent();
      }catch(error){if(!prepared){held.delete(localKey);admitted=false;}throw error;}
    },
    async retainExposure(receipt){if(!prepared||released)throw conflict();await retain(receipt);},
    async finish(){
      if(!prepared||released||accepted)throw conflict();assertCurrent();
      const outputs=selection.outputs.flatMap(output=>{const bytes=readNativeFile(workspace,output.path);return bytes&&bytesHash(bytes)!==baseline.get(output.path)?[{...output,bytes}]:[];});
      // Only files changed by this successful interaction are candidates. A
      // cancelled run's pending product never becomes a new run's output.
      if(protectPending())throw conflict();assertCurrent();
      const previous=value<Control>(control)?.accepted;
      let committed:StateRecord|undefined;
      await input.publish({sourceKey:identity,profileId:profile.modelProfileId,conversationId:context.conversationId,outputs,receipts:[...receipts.values()],assertCurrent,acceptCheckpoint(){
        assertCurrent();if(committed||!control)throw conflict();
        committed=commitState(control.revision,stateValue({version:1,identity,accepted:token!,writer:{pid:process.pid,token:lease}}));assertCurrent();
      }});
      if(!committed)throw conflict();control=committed;accepted=true;assertCurrent();
      // The previous snapshot has a durable successor. No age-based recovery
      // removes the sole active/pending input.
      for(const prior of new Set([previous,baseToken]))if(prior&&prior!==token)rmSync(join(generations,prior),{recursive:true,force:true});
    },
    async release(){
      if(released)return;released=true;
      try{
        protectPending();
        if(control&&admitted){const current=value<Control>(control)!;await cas({...current,writer:undefined});}
      }finally{if(admitted)held.delete(localKey);admitted=false;}
    },
  };
}
