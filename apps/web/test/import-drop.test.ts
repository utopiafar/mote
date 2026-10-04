import test from 'node:test';
import assert from 'node:assert/strict';
import {configureLocale} from '@mote/shared/i18n';
import {readImportDrop} from '../src/import-drop.js';
configureLocale(()=> 'zh-CN');
const fileEntry=(name:string,text=name)=>({name,isFile:true,isDirectory:false,file:(done:(file:File)=>void)=>done(new File([text],name,{type:'text/plain',lastModified:123}))}) as unknown as FileSystemFileEntry;
function directory(name:string,batches:FileSystemEntry[][]):FileSystemDirectoryEntry{
 return {name,isFile:false,isDirectory:true,createReader:()=>{let i=0;return {readEntries:(done:(entries:FileSystemEntry[])=>void)=>done(batches[i++]??[])};}} as FileSystemDirectoryEntry;
}
function drop(entries:FileSystemEntry[],fallback:File[]=[]):DataTransfer{
 return {items:entries.map(entry=>({kind:'file',webkitGetAsEntry:()=>entry,getAsFile:()=>new File(['unreadable directory placeholder'],entry.name)})),files:fallback} as unknown as DataTransfer;
}
test('folder drops read every batch, nested paths and mixed roots without reading directory placeholders',async()=>{
 const first=Array.from({length:100},(_,i)=>fileEntry(`entry-${i}.txt`));
 const entries=[directory('生成日记',[first,[fileEntry('same.txt')],[directory('nested',[[fileEntry('same.txt','nested content')]])],[]]),fileEntry('loose.txt')];
 const files=await readImportDrop(drop(entries));assert.equal(files.length,103);
 assert.equal(files[100].webkitRelativePath,'生成日记/same.txt');assert.equal(files[101].webkitRelativePath,'生成日记/nested/same.txt');assert.equal(files[102].webkitRelativePath,'loose.txt');
 assert.equal(await files[101].text(),'nested content');assert.equal(files[101].type,'text/plain');assert.equal(files[101].lastModified,123);
});
test('drop snapshots entries synchronously and falls back to ordinary files when entry API is unavailable',async()=>{
 const data=drop([directory('folder',[[fileEntry('original.txt')]])]),pending=readImportDrop(data);
 Object.defineProperty(data,'items',{get:()=>{throw Error('Expired drop event');}});Object.defineProperty(data,'files',{get:()=>{throw Error('Expired drop event');}});
 assert.equal((await pending)[0].webkitRelativePath,'folder/original.txt');
 const loose=new File(['generated'],'loose.txt');assert.deepEqual(await readImportDrop({items:[],files:[loose]} as unknown as DataTransfer),[loose]);
 assert.deepEqual(await readImportDrop({items:[{kind:'file',getAsFile:()=>loose}],files:[loose]} as unknown as DataTransfer),[loose]);
});
test('empty folders, inaccessible descendants, duplicates and upload limits reject the entire drop',async()=>{
 await assert.rejects(readImportDrop(drop([directory('empty',[[]])])),/没有可上传/);
 const inaccessible={name:'blocked',isDirectory:true,isFile:false,createReader:()=>({readEntries:(_done:unknown,fail:(error:DOMException)=>void)=>fail(new DOMException('Generated denied','NotReadableError'))})} as unknown as FileSystemDirectoryEntry;
 await assert.rejects(readImportDrop(drop([directory('folder',[[fileEntry('good.txt'),inaccessible]])])),/无法读取文件夹中的条目/);
 await assert.rejects(readImportDrop(drop([fileEntry('same.txt'),fileEntry('same.txt')])),/路径不能重复/);
 await assert.rejects(readImportDrop(drop([directory('large',[Array.from({length:2001},(_,i)=>fileEntry(`${i}.txt`))])])),/2,000/);
 const huge=new File(['generated'],'huge.txt');Object.defineProperty(huge,'size',{value:65*1024*1024});await assert.rejects(readImportDrop({items:[],files:[huge]} as unknown as DataTransfer),/64 MB/);
});
test('cancelling pending enumeration cannot return a partial selection',async()=>{
 let finish!:(entries:FileSystemEntry[])=>void;
 const delayed={name:'folder',isFile:false,isDirectory:true,createReader:()=>({readEntries:(done:typeof finish)=>{finish=done;}})} as FileSystemDirectoryEntry;
 const controller=new AbortController(),pending=readImportDrop(drop([delayed]),controller.signal);controller.abort();finish([fileEntry('late.txt')]);await assert.rejects(pending,{name:'AbortError'});
});
