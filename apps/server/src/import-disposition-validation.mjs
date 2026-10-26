import {relative,resolve} from 'node:path';

// Inject schema dependencies so the generated helper uses the same contract
// without needing a TypeScript loader or inspecting repository source.
export function createImportSchemas(z,sourceItemSchema){
 return {
  recordSchema:z.object({item:sourceItemSchema,evidencePaths:z.array(z.string().min(1).max(4000)).min(1).max(100),attachments:z.array(z.string().min(1).max(4000)).max(100).default([])}).strict(),
  dispositionsSchema:z.object({items:z.array(z.object({path:z.string().min(1).max(4000),status:z.enum(['parsed','attachment','container','excluded','unsupported']),reason:z.string().min(1).max(1000)}).strict()).max(4000)}).strict(),
 };
}

const displayPath=(workspace,path)=>JSON.stringify(relative(workspace,path));

/** Shared by the model's preflight helper and the independent host validator. */
export function dispositionRoles(items,inputPaths,workspace,hostAttachmentPaths=[]) {
 const hosted=new Set(Array.from(hostAttachmentPaths,path=>resolve(workspace,path)));
 const supplied=new Set(Array.from(inputPaths,path=>resolve(workspace,path)).filter(path=>!hosted.has(path))),roles=new Map();
 for(const item of items){
  const path=resolve(workspace,item.path),display=displayPath(workspace,path);
  if(!supplied.has(path))throw Error(`Disposition manifest references a file outside the supplied inputs: ${display}`);
  if(roles.has(path))throw Error(`Disposition manifest lists a file more than once: ${display}`);
  roles.set(path,item.status);
 }
 for(const path of supplied)if(!roles.has(path))throw Error(`Disposition manifest must account for every supplied file; missing ${displayPath(workspace,path)}`);
 for(const path of hosted)roles.set(path,'attachment');
 return roles;
}

export function validateDispositionReferences(record,roles,workspace,line) {
 for(const [field,paths] of [['evidencePaths',record.evidencePaths],['attachments',record.attachments]]){
  for(const given of paths){
   const path=resolve(workspace,given),status=roles.get(path),allowed=field==='evidencePaths'?status==='parsed':status==='parsed'||status==='attachment';
   if(!allowed){
    const rule=field==='evidencePaths'?'Evidence paths must be marked parsed in the file disposition list':'Excluded or unsupported files cannot be silently attached to evidence';
    throw Error(`${rule}; manifest line ${line}, ${field}, status=${status??'missing'}, expected=${field==='evidencePaths'?'parsed':'parsed or attachment'}, path=${displayPath(workspace,path)}`);
   }
  }
 }
}
