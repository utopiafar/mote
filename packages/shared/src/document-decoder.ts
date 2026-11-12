/** Format decoding only: never infer an author, date, topic, or intent. */
import type {FileCoverage} from './file-view.js';
export const DOCUMENT_MIME_TYPES=['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;
export type DocumentLocation={pageNumber?:number;paragraphNumber?:number;endParagraphNumber?:number;sheetName?:string;rowNumber?:number;columnNumber?:number;endColumnNumber?:number;offset:number;length:number};
export type DecodedDocument={text:string;parser:string;status:'ready'|'unsupported'|'failed';coverage:'full'|'partial'|'none';extraction?:FileCoverage;warnings:string[];pages?:{pageNumber:number;text:string}[];pageCount?:number;sheets?:{name:string;rows:{rowNumber:number;cells:{column:number;value:unknown}[]}[]}[]};
export type DocumentLibraries={pdf:()=>Promise<any>;docx:()=>Promise<any>;xlsx?:()=>Promise<any>;pdfOptions?:Record<string,unknown>};
const MAX_BYTES=64*1024*1024;
/** Inspect ZIP metadata before an Office parser can allocate decompressed entries. */
function inspectOffice(bytes:Uint8Array){
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
 if(end<0)throw Error('Office archive is incomplete');
 const count=view.getUint16(end+10,true),size=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
 if(view.getUint32(end+4,true)!==0||view.getUint16(end+8,true)!==count||count>20000||size>8*1024*1024||start+size>end)throw Error('Office archive exceeds limits');
 let cursor=start,total=0;for(let i=0;i<count;i++){
  if(cursor+46>start+size||view.getUint32(cursor,true)!==0x02014b50)throw Error('Invalid Office archive');
  const original=view.getUint32(cursor+24,true);total+=original;if(original>64*1024*1024||total>128*1024*1024)throw Error('Office archive exceeds decompression limits');
  cursor+=46+view.getUint16(cursor+28,true)+view.getUint16(cursor+30,true)+view.getUint16(cursor+32,true);if(cursor>start+size)throw Error('Invalid Office archive');
 }
}
export async function decodeDocument(bytes:Uint8Array,mime:string,libraries:DocumentLibraries,signal?:AbortSignal):Promise<DecodedDocument>{
 const unsupported=(parser:string,message:string):DecodedDocument=>({text:'',parser,status:'unsupported',coverage:'none',warnings:[message]});
 signal?.throwIfAborted();if(bytes.length>MAX_BYTES)return unsupported('unavailable','File exceeds the 64 MiB decoding limit');
 let parser='unavailable';try{
  if(mime==='application/pdf'){
   parser='pdfjs';const pdf=await libraries.pdf();signal?.throwIfAborted();
   const document=await pdf.getDocument({data:new Uint8Array(bytes),useWorkerFetch:false,isEvalSupported:false,disableFontFace:true,useSystemFonts:false,...libraries.pdfOptions}).promise;
   const pages:{pageNumber:number;text:string}[]=[],failed:number[]=[];
   try{for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
    signal?.throwIfAborted();try{const page=await document.getPage(pageNumber);let text:string;try{const content=await page.getTextContent();text=content.items.map((item:any)=>'str'in item?item.str+(item.hasEOL?'\n':' '):'').join('').trimEnd();}finally{page.cleanup();}pages.push({pageNumber,text});}
    catch{signal?.throwIfAborted();failed.push(pageNumber);}
   }
   const empty=pages.filter(page=>!page.text.trim()).map(page=>page.pageNumber),completed=pages.length-empty.length,total=document.numPages,warnings:string[]=[];
   if(empty.length)warnings.push(`Pages without a text layer: ${empty.slice(0,100).join(', ')}. No OCR was performed; image text may be missing.`);
   if(failed.length)warnings.push(`Pages that could not be extracted: ${failed.slice(0,100).join(', ')}.`);
   if(!completed&&!failed.length)warnings.push('No text layer was found. This may be a scanned PDF; no OCR was performed.');
   if(completed)warnings.push('PDF text layers were extracted; embedded image text was not OCRed.');
   const status=completed?'ready':failed.length?'failed':'unsupported';
   const extraction:FileCoverage={status:completed===total&&total>0?'ready':completed?'partial':status,completed,total,...(warnings.length?{reason:warnings.join(' ').slice(0,1000)}:{})};
   return {text:pages.map(page=>page.text).join('\n'),parser,status,coverage:!completed?'none':completed<total?'partial':'full',extraction,warnings,pages,pageCount:total};
   }finally{await document.destroy();}
  }
  if(mime===DOCUMENT_MIME_TYPES[1]){
   parser='mammoth';inspectOffice(bytes);const module=await libraries.docx();signal?.throwIfAborted();const result=await (module.default??module).extractRawText({buffer:bytes});signal?.throwIfAborted();
   const warnings=result.messages.map((message:any)=>String(message.message).slice(0,1000)).slice(0,28);
   warnings.push('DOCX plain text preserves paragraph breaks; page layout and embedded image text are not extracted.');
   return {text:result.value,parser,status:result.value.trim()?'ready':'unsupported',coverage:!result.value.trim()?'none':'full',warnings};
  }
  if(mime===DOCUMENT_MIME_TYPES[2]){
   parser='exceljs';inspectOffice(bytes);if(!libraries.xlsx)return unsupported(parser,'Spreadsheet decoder is unavailable');const module=await libraries.xlsx(),book=new (module.default??module).Workbook();await book.xlsx.load(bytes);signal?.throwIfAborted();
   const cellValue=(value:any):unknown=>{if(value instanceof Date)return value.toISOString();if(value&&typeof value==='object'){if('richText'in value)return value.richText.map((part:any)=>part.text).join('');if('formula'in value||'sharedFormula'in value)return {formula:value.formula??value.sharedFormula,result:cellValue(value.result??null)};if('hyperlink'in value)return {text:value.text??'',hyperlink:value.hyperlink};if('error'in value)return {error:value.error};}return value??null;};
   const sheets:NonNullable<DecodedDocument['sheets']>=[];const lines:string[]=[];
   for(const sheet of book.worksheets){signal?.throwIfAborted();const decoded:{name:string;rows:{rowNumber:number;cells:{column:number;value:unknown}[]}[]}={name:sheet.name,rows:[]};
    sheet.eachRow({includeEmpty:false},(row:any,rowNumber:number)=>{const cells:{column:number;value:unknown}[]=[];row.eachCell({includeEmpty:true},(cell:any,column:number)=>{cells.push({column,value:cellValue(cell.value)});});const line=JSON.stringify({sheet:sheet.name,rowNumber,cells})+'\n';decoded.rows.push({rowNumber,cells});lines.push(line);});sheets.push(decoded);
   }
   return {text:lines.join(''),parser,status:'ready',coverage:'full',sheets,warnings:['Formula expressions and cached results are preserved; formulas were not recalculated.']};
  }
  if(mime.startsWith('text/')||mime==='application/json'){
   parser='utf8';const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\u0000'))return unsupported(parser,'Input contains NUL bytes and may not be plain text');
   return {text,parser,status:'ready',coverage:'full',warnings:[]};
  }
  return unsupported(parser,'No generic decoder is available for this format');
 }catch(error){signal?.throwIfAborted();return {text:'',parser,status:'failed',coverage:'none',warnings:[`Parser failed: ${String(error instanceof Error?error.message:error).slice(0,900)}`]};}
}
/** Offset is relative to the decoded page for PDF, otherwise to the decoded text. */
export function* documentChunks(document:DecodedDocument,maximum=4000):Generator<{text:string;documentLocation:DocumentLocation}>{
 if(!Number.isInteger(maximum)||maximum<2)throw Error('Invalid chunk size');
 if(document.sheets){let documentOffset=0;for(const sheet of document.sheets)for(const row of sheet.rows){
  if(!row.cells.length){const text=JSON.stringify({sheet:sheet.name,...row})+'\n';for(const part of documentChunks({...document,sheets:undefined,text},maximum))yield {...part,documentLocation:{...part.documentLocation,offset:documentOffset+part.documentLocation.offset,sheetName:sheet.name,rowNumber:row.rowNumber}};documentOffset+=text.length;continue;}
  const prefix=JSON.stringify({sheet:sheet.name,rowNumber:row.rowNumber,cells:[]}).slice(0,-2),cells=row.cells,pieces:string[]=[],ends:number[]=[];let length=0;
  for(const [index,cell] of cells.entries()){
   const piece=(index===0?prefix:',')+JSON.stringify(cell)+(index===cells.length-1?']}\n':'');pieces.push(piece);length+=piece.length;ends.push(length);
  }
  const text=pieces.join('');let first=0,last=0;
  for(const part of documentChunks({...document,sheets:undefined,text},maximum)){
   const start=part.documentLocation.offset,end=start+part.documentLocation.length;
   while(first<ends.length-1&&ends[first]!<=start)first++;
   last=Math.max(first,last);while(last<ends.length-1&&ends[last]!<end)last++;
   const columnNumber=cells[first]!.column,endColumnNumber=cells[last]!.column;
   yield {...part,documentLocation:{...part.documentLocation,offset:documentOffset+start,sheetName:sheet.name,rowNumber:row.rowNumber,columnNumber,...(endColumnNumber!==columnNumber?{endColumnNumber}:{})}};
  }
  documentOffset+=text.length;
 }return;}
 if(document.parser==='mammoth'||document.parser==='utf8'){
  const ends:number[]=[];for(const match of document.text.matchAll(/.*?(?:\r?\n\r?\n|$)/gs))if(match[0])ends.push(match.index!+match[0].length);
  let first=0,last=0;for(const part of documentChunks({...document,parser:'paragraph'},maximum)){
   const start=part.documentLocation.offset,end=start+part.documentLocation.length;
   while(first<ends.length-1&&ends[first]!<=start)first++;
   last=Math.max(first,last);while(last<ends.length-1&&ends[last]!<end)last++;
   yield {...part,documentLocation:{...part.documentLocation,paragraphNumber:first+1,...(last>first?{endParagraphNumber:last+1}:{})}};
  }return;
 }
 for(const page of document.pages??[{text:document.text,pageNumber:undefined}])for(let offset=0;offset<page.text.length;){let end=Math.min(page.text.length,offset+maximum);if(end<page.text.length&&page.text.charCodeAt(end-1)>=0xd800&&page.text.charCodeAt(end-1)<=0xdbff)end--;const text=page.text.slice(offset,end);yield {text,documentLocation:{...(page.pageNumber?{pageNumber:page.pageNumber}:{}),offset,length:text.length}};offset=end;}
}
