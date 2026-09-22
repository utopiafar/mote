import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,readSync,writeSync,fsyncSync,lstatSync,realpathSync,existsSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {resolve,relative,isAbsolute,sep,join} from 'node:path';
import {sourceItemSchema,type ArchivedFile,type ImportDispositions} from '@mote/shared';
import {importRecordSchema,importDispositionsSchema} from './import-record.js';
import {privateFile} from './private-storage.js';
export type ManifestTask={kind:'manifest';workspace:string;path:string;output:string;inputs:{path:string;file:ArchivedFile}[];expectedHash?:string;dispositions?:boolean;temporary?:string};
export class ManifestValidationError extends Error {constructor(message:string,readonly status=422){super(message);}}
const fail=(message:string,status=422):never=>{throw new ManifestValidationError(message,status);};
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith(`..${sep}`)&&rel!=='..'&&!isAbsolute(rel));};
function* bytes(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65536);try{let size:number;while((size=readSync(fd,buffer,0,buffer.length,null))>0)yield buffer.subarray(0,size);}finally{closeSync(fd);}}
function regular(path:string,root:string){if(!inside(root,path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||realpathSync(path)!==path)fail('Records manifest must be a regular file inside the import workspace');}
function hash(path:string){const digest=createHash('sha256');let size=0;for(const part of bytes(path)){digest.update(part);size+=part.length;}return {hash:digest.digest('hex'),size};}
function* lines(path:string,digest:ReturnType<typeof createHash>){const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',count=0;for(const chunk of bytes(path)){digest.update(chunk);count+=chunk.length;if(count>32*1024*1024)fail('Records manifest exceeds 32 MiB',413);pending+=decoder.decode(chunk,{stream:true});let newline:number;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line.trim())yield line;}if(pending.length>2*1024*1024)fail('Manifest record exceeds 2 MiB',413);}pending+=decoder.decode();if(pending.trim())yield pending;}
export function validateImportManifest(task:ManifestTask){
 const path=resolve(task.workspace,task.path);regular(path,task.workspace);if(lstatSync(path).size>32*1024*1024)fail('Records manifest exceeds 32 MiB',413);
 if(task.expectedHash&&hash(path).hash!==task.expectedHash)fail('The preview changed; analyze the files again before importing',409);
 const inputs=new Map(task.inputs.map(input=>[input.path,input])),checked=new Map<string,{path:string;file:ArchivedFile}>();
 const verify=(input:{path:string;file:ArchivedFile})=>{if(!existsSync(input.path))return;regular(input.path,join(task.workspace,'inputs'));const value=hash(input.path);if(value.hash!==input.file.hash||value.size!==input.file.sizeBytes)fail('An input file changed during analysis; retry from the archived original',409);};
 const input=(given:string)=>{const absolute=resolve(task.workspace,given),value=inputs.get(absolute);if(!value||!inside(join(task.workspace,'inputs'),absolute))return fail('Manifest references a file outside the supplied inputs');if(!checked.has(absolute)){verify(value);checked.set(absolute,value);}return value;};
 const warnings:string[]=[];let dispositions:ImportDispositions|undefined;
 if(task.dispositions){const dispositionPath=join(task.workspace,'dispositions.json');if(!existsSync(dispositionPath))warnings.push('The analysis did not provide a per-file disposition list. Unlisted files must not be assumed to have been parsed.');else{
  regular(dispositionPath,task.workspace);if(lstatSync(dispositionPath).size>8*1024*1024)fail('File disposition manifest is too large',413);
  const parsed=importDispositionsSchema.parse(JSON.parse(readFileSync(dispositionPath,'utf8'))),seen=new Set<string>(),counts:ImportDispositions['counts']={parsed:0,attachment:0,container:0,excluded:0,unsupported:0};
  const items=parsed.items.map(item=>{const value=input(item.path);if(seen.has(value.path))fail('Disposition manifest lists a file more than once');seen.add(value.path);counts[item.status]++;return {fileId:value.file.id,path:value.file.relativePath,status:item.status,reason:item.reason};});
  if(seen.size!==inputs.size)fail('Disposition manifest must account for every supplied file');if(counts.unsupported)warnings.push(`${counts.unsupported} archived file(s) remain unsupported and were not fully parsed.`);dispositions={counts,items};
 }}
 const roles=dispositions?new Map(dispositions.items.map(item=>[item.fileId,item.status])):undefined;
 const temporary=task.temporary??join(task.workspace,'validated-'+randomUUID()+'.tmp');if(!inside(task.workspace,temporary))fail('Temporary manifest must remain inside the import workspace');privateFile(temporary,true);const fd=openSync(temporary,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW),digest=createHash('sha256'),identities=new Set<string>();
 const inputDigest=createHash('sha256');const samples:{title:string;text:string;kind:string;attachmentCount:number}[]=[];let count=0,outputBytes=0,closed=false;
 try{
  for(const line of lines(path,inputDigest)){
   if(++count>10000)fail('Records manifest exceeds 10000 records',413);let raw:unknown;try{raw=JSON.parse(line);}catch{fail(`Invalid JSON on manifest line ${count}`);}
   const parsed=importRecordSchema.safeParse(raw);if(!parsed.success)fail(`Invalid record on manifest line ${count}`);
   const record=parsed.data!,key=JSON.stringify([record.item.externalId,record.item.revision]);if(identities.has(key))fail(`Duplicate record identity on manifest line ${count}`);identities.add(key);
   const evidence=record.evidencePaths.map(input),attachments=record.attachments.map(input);
   if(roles){for(const value of evidence)if(roles.get(value.file.id)!=='parsed')fail('Evidence paths must be marked parsed in the file disposition list');for(const value of attachments)if(!['parsed','attachment'].includes(roles.get(value.file.id)??''))fail('Excluded or unsupported files cannot be silently attached to evidence');}
   const item=sourceItemSchema.parse({...record.item,document:{...record.item.document,fileId:evidence[0].file.id,path:evidence[0].file.relativePath,attachments:attachments.map(value=>({id:value.file.id,name:value.file.name,path:value.file.relativePath,mimeType:value.file.mimeType}))}});
   const normalized=Buffer.from(JSON.stringify({item,evidencePaths:evidence.map(value=>value.path),attachments:attachments.map(value=>value.path)})+'\n');outputBytes+=normalized.length;if(outputBytes>32*1024*1024)fail('Records manifest exceeds 32 MiB',413);writeSync(fd,normalized);digest.update(normalized);if(samples.length<12)samples.push({title:item.title,text:item.text.slice(0,1800),kind:item.kind,attachmentCount:attachments.length});
  }
  if(task.expectedHash&&inputDigest.digest('hex')!==task.expectedHash)fail('The preview changed; analyze the files again before importing',409);
  for(const value of checked.values())verify(value);
  if(task.expectedHash&&hash(path).hash!==task.expectedHash)fail('The preview changed; analyze the files again before importing',409);
  fsyncSync(fd);closeSync(fd);closed=true;
  const output=resolve(task.workspace,task.output);if(!inside(task.workspace,output))fail('Validated manifest must remain inside the import workspace');renameSync(temporary,output);privateFile(output);
  return {count,samples,hash:digest.digest('hex'),dispositions,warnings};
 }finally{if(!closed)closeSync(fd);rmSync(temporary,{force:true});}
}
