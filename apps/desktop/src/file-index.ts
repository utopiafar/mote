import {decodeDocument,type DecodedDocument} from '@mote/shared/document-decoder';
import {extname} from 'node:path';
import {createHash} from 'node:crypto';
export const fileDigest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function fileMime(path:string):string {return ({'.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.flac':'audio/flac','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'} as Record<string,string>)[extname(path).toLowerCase()]??(['.md','.markdown','.txt','.csv','.tsv','.json','.jsonl','.ndjson','.yaml','.yml','.ics','.log'].includes(extname(path).toLowerCase())?'text/plain':'application/octet-stream');}
export async function extractFileText(bytes:Buffer,mime:string,signal?:AbortSignal):Promise<Omit<DecodedDocument,'status'|'coverage'|'warnings'>&{status:'ready'|'pending'|'unsupported';coverage?:DecodedDocument['coverage'];warnings?:string[]}> {
 signal?.throwIfAborted();
 if(mime.startsWith('audio/'))return {text:'',parser:'central-pending',status:'pending'};
 return decodeDocument(bytes,mime,{pdf:()=>import('pdfjs-dist/legacy/build/pdf.mjs'),docx:()=>import('mammoth'),xlsx:()=>import('exceljs')},signal);
}
