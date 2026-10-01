import {constants} from 'node:fs';
import {mkdir,mkdtemp,open,realpath,rm} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {ExecutionFailure} from '../execution-engine.js';
export async function recordingStage<T>(root:string,run:(directory:string,relativeDirectory:string)=>Promise<T>):Promise<T>{
 await mkdir(root,{recursive:true,mode:0o700});const directory=await mkdtemp(resolve(root,'recording-'));
 try{return await run(directory,relative(root,directory));}finally{await rm(directory,{recursive:true,force:true});}
}
export async function recordingFile(directory:string,path:string,limit:number):Promise<Buffer>{
 const actual=await realpath(resolve(directory,path)),delta=relative(await realpath(directory),actual);
 if(delta==='..'||delta.startsWith('..'+sep)||isAbsolute(delta))throw new ExecutionFailure('permanent','recording_export_path_invalid');
 const file=await open(actual,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||info.size>limit||info.size===0)throw new ExecutionFailure('permanent','recording_export_size_invalid');return await file.readFile();}finally{await file.close();}
}
