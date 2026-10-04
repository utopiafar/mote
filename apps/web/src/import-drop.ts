import {moteText} from '@mote/shared/i18n';
import {validateImportFiles} from './import-queue';

/** Capture entries while the drop event's data store is readable. Directory
 * entries are traversed as directories, never sent to the Blob upload reader. */
export async function readImportDrop(data:DataTransfer,signal?:AbortSignal):Promise<File[]>{
 const roots=Array.from(data.items??[]).filter(item=>item.kind==='file').map(item=>({entry:item.webkitGetAsEntry?.(),file:item.getAsFile()}));
 const fallback=Array.from(data.files),files:File[]=[];let visited=0;
 const accept=(file:File,path?:string)=>{
  signal?.throwIfAborted();
  if(path){
   const original=file;file=new File([original],original.name,{type:original.type,lastModified:original.lastModified});
   Object.defineProperty(file,'webkitRelativePath',{value:path});
  }
  files.push(file);const error=validateImportFiles(files);if(error)throw Error(error);
 };
 const visit=async(entry:FileSystemEntry,path:string,depth:number):Promise<void>=>{
  signal?.throwIfAborted();
  if(depth>128||++visited>10000)throw Error(moteText('文件夹层级或条目数超过上限，请拆分后导入。'));
  if(entry.isFile){
   const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));accept(file,path);return;
  }
  if(!entry.isDirectory)throw Error(moteText('无法读取文件夹中的条目，请重新选择文件夹。'));
  const reader=(entry as FileSystemDirectoryEntry).createReader();
  // Chromium readers return batches (usually at most 100). An empty batch is
  // the only completion marker; a short batch may still have more siblings.
  for(;;){
   signal?.throwIfAborted();
   const entries=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));
   signal?.throwIfAborted();if(!entries.length)break;
   for(const child of entries)await visit(child,`${path}/${child.name}`,depth+1);
  }
 };
 try{
 if(roots.length){for(const root of roots){if(root.entry)await visit(root.entry,root.entry.name,0);else if(root.file)accept(root.file);else throw Error(moteText('无法读取文件夹中的条目，请重新选择文件夹。'));}}
 else for(const file of fallback)accept(file);
 }catch(error){
  signal?.throwIfAborted();
  if(error instanceof Error&&['NotReadableError','NotFoundError','SecurityError'].includes(error.name))throw Error(moteText('无法读取文件夹中的条目，请重新选择文件夹。'),{cause:error});
  throw error;
 }
 signal?.throwIfAborted();
 if(!files.length)throw Error(moteText('所选文件夹中没有可上传的文件。'));
 return files;
}
