import {decodeDocument,documentChunks} from '@mote/shared/document-decoder';
import {dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
export {documentChunks};
export function decodeOriginal(bytes:Buffer,mime:string){return decodeDocument(bytes,mime,{
 pdf:async()=>{const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs');pdf.GlobalWorkerOptions.workerSrc=import.meta.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');return pdf;},
 docx:()=>import('mammoth'),xlsx:()=>import('exceljs'),pdfOptions:{standardFontDataUrl:join(dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))),'standard_fonts')+sep},
});}
