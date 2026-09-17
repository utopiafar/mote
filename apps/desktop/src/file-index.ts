import {extname} from 'node:path';
import {createHash} from 'node:crypto';
import {readResponseText} from './response-body';
export const fileDigest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function fileMime(path:string):string {return ({'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.flac':'audio/flac','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'} as Record<string,string>)[extname(path).toLowerCase()]??(['.md','.txt','.csv','.json','.ics','.log'].includes(extname(path).toLowerCase())?'text/plain':'application/octet-stream');}
export async function extractFileText(bytes:Buffer,mime:string,signal?:AbortSignal):Promise<{text:string;parser:string;status:'ready'|'pending'|'unsupported'}> {
 signal?.throwIfAborted();
 if(mime==='application/pdf'){
  const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');const document=await pdf.getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false}).promise;
  try {let text='';for(let i=1;i<=document.numPages;i++){signal?.throwIfAborted();const page=await document.getPage(i);const content=await page.getTextContent();text+=content.items.map((v:any)=>v.str??'').join(' ')+'\n';if(text.length>10000000)throw Error('Text limit exceeded');}return {text,parser:'pdfjs',status:'ready'};}finally{await document.destroy();}
 }
 if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'){const mammoth=await import('mammoth');const text=(await mammoth.extractRawText({buffer:bytes})).value;if(text.length>10000000)throw Error('Text limit exceeded');return {text,parser:'mammoth',status:'ready'};}
 if(mime.startsWith('audio/')){
  try{const response=await fetch('http://127.0.0.1:9009/transcribe',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Mote-Offline':'1','X-Mote-Max-Audio-Ms':'14400000'},body:new Uint8Array(bytes),signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(600000)]),redirect:'error'});if(!response.ok)throw Error('Local transcription unavailable');const raw=JSON.parse(await readResponseText(response,16*1024*1024));const {transcriptSchema}=await import('@mote/shared');const transcript=transcriptSchema.parse(raw);return {text:transcript.segments.map(s=>`[${s.startMs}-${s.endMs} ms] ${s.speaker??''} ${s.text}`).join('\n'),parser:'local-audio',status:'ready'};}catch(error){signal?.throwIfAborted();return {text:'',parser:'local-audio',status:'pending'};}
 }
 if(mime.startsWith('text/')){try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),parser:'utf8',status:'ready'};}catch{return {text:'',parser:'utf8',status:'unsupported'};}}
 return {text:'',parser:'unavailable',status:'unsupported'};
}
