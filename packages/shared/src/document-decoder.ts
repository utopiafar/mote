/** Format decoding only: never infer an author, date, topic, or intent. */
export const DOCUMENT_MIME_TYPES=['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] as const;
export type DocumentLocation={pageNumber?:number;sheetName?:string;rowNumber?:number;offset:number;length:number};
export type DecodedDocument={text:string;parser:string;status:'ready'|'unsupported';coverage:'full'|'partial'|'none';warnings:string[];pages?:{pageNumber:number;text:string}[];pageCount?:number;sheets?:{name:string;rows:{rowNumber:number;cells:{column:number;value:unknown}[]}[]}[]};
export type DocumentLibraries={pdf:()=>Promise<any>;docx:()=>Promise<any>;xlsx?:()=>Promise<any>;pdfOptions?:Record<string,unknown>};
const MAX_BYTES=64*1024*1024,MAX_CHARS=2_000_000;
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
   const pages:{pageNumber:number;text:string}[]=[];let count=0,truncated=false;
   try{for(let pageNumber=1;pageNumber<=Math.min(document.numPages,500);pageNumber++){
    signal?.throwIfAborted();const page=await document.getPage(pageNumber);try{const content=await page.getTextContent();let text=content.items.map((item:any)=>'str'in item?item.str+(item.hasEOL?'\n':' '):'').join('').trimEnd();if(count+text.length>MAX_CHARS){text=text.slice(0,MAX_CHARS-count);truncated=true;}pages.push({pageNumber,text});count+=text.length;if(truncated)break;}finally{page.cleanup();}
   }
   truncated ||= pages.length<document.numPages;const empty=pages.filter(page=>!page.text.trim()).map(page=>page.pageNumber),warnings=[];
   if(empty.length)warnings.push(`Pages without a text layer: ${empty.slice(0,100).join(', ')}. No OCR was performed; image text may be missing.`);
   if(truncated)warnings.push('PDF extraction stopped at the 500-page or 2,000,000-character limit.');
   return {text:pages.map(page=>page.text).join('\n'),parser,status:count?'ready':'unsupported',coverage:!count?'none':truncated||empty.length?'partial':'full',warnings:count?warnings:['No text layer was found. This may be a scanned PDF; no OCR was performed.'],pages,pageCount:document.numPages};
   }finally{await document.destroy();}
  }
  if(mime===DOCUMENT_MIME_TYPES[1]){
   parser='mammoth';inspectOffice(bytes);const module=await libraries.docx();signal?.throwIfAborted();const result=await (module.default??module).extractRawText({buffer:bytes});signal?.throwIfAborted();
   const truncated=result.value.length>MAX_CHARS,warnings=result.messages.map((message:any)=>String(message.message).slice(0,1000)).slice(0,28);
   warnings.push('DOCX plain text preserves paragraph breaks; page layout and embedded image text are not extracted.');if(truncated)warnings.push('Text was truncated at 2,000,000 characters.');
   return {text:result.value.slice(0,MAX_CHARS),parser,status:result.value.trim()?'ready':'unsupported',coverage:!result.value.trim()?'none':truncated?'partial':'full',warnings};
  }
  if(mime===DOCUMENT_MIME_TYPES[2]){
   parser='exceljs';inspectOffice(bytes);if(!libraries.xlsx)return unsupported(parser,'Spreadsheet decoder is unavailable');const module=await libraries.xlsx(),book=new (module.default??module).Workbook();await book.xlsx.load(bytes);signal?.throwIfAborted();
   const cellValue=(value:any):unknown=>{if(value instanceof Date)return value.toISOString();if(value&&typeof value==='object'){if('richText'in value)return value.richText.map((part:any)=>part.text).join('');if('formula'in value||'sharedFormula'in value)return {formula:value.formula??value.sharedFormula,result:cellValue(value.result??null)};if('hyperlink'in value)return {text:value.text??'',hyperlink:value.hyperlink};if('error'in value)return {error:value.error};}return value??null;};
   const sheets:NonNullable<DecodedDocument['sheets']>=[];let rows=0,characters=0,truncated=false;const lines:string[]=[];
   for(const sheet of book.worksheets.slice(0,100)){signal?.throwIfAborted();const decoded:{name:string;rows:{rowNumber:number;cells:{column:number;value:unknown}[]}[]}={name:sheet.name,rows:[]};
    sheet.eachRow({includeEmpty:false},(row:any,rowNumber:number)=>{if(truncated)return;const cells:{column:number;value:unknown}[]=[];row.eachCell({includeEmpty:true},(cell:any,column:number)=>{if(column>500){truncated=true;return;}cells.push({column,value:cellValue(cell.value)});});const line=JSON.stringify({sheet:sheet.name,rowNumber,cells})+'\n';if(truncated||rows>=20000||characters+line.length>MAX_CHARS){truncated=true;return;}decoded.rows.push({rowNumber,cells});rows++;characters+=line.length;lines.push(line);});sheets.push(decoded);if(truncated)break;
   }
   truncated ||= book.worksheets.length>100;return {text:lines.join(''),parser,status:'ready',coverage:truncated?'partial':'full',sheets,warnings:['Formula expressions and cached results are preserved; formulas were not recalculated.',...(truncated?['Spreadsheet extraction reached the 100-sheet, 20,000-row, 500-column or 2,000,000-character limit.']:[])]};
  }
  if(mime.startsWith('text/')||mime==='application/json'){
   parser='utf8';const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\u0000'))return unsupported(parser,'Input contains NUL bytes and may not be plain text');
   const truncated=text.length>MAX_CHARS;return {text:text.slice(0,MAX_CHARS),parser,status:'ready',coverage:truncated?'partial':'full',warnings:truncated?['Text was truncated at 2,000,000 characters.']:[]};
  }
  return unsupported(parser,'No generic decoder is available for this format');
 }catch(error){signal?.throwIfAborted();return unsupported(parser,`Parser failed: ${String(error instanceof Error?error.message:error).slice(0,900)}`);}
}
/** Offset is relative to the decoded page for PDF, otherwise to the decoded text. */
export function* documentChunks(document:DecodedDocument,maximum=4000):Generator<{text:string;documentLocation:DocumentLocation}>{
 if(!Number.isInteger(maximum)||maximum<2)throw Error('Invalid chunk size');
 if(document.sheets){for(const sheet of document.sheets)for(const row of sheet.rows){const text=JSON.stringify({sheet:sheet.name,...row})+'\n';for(const part of documentChunks({...document,sheets:undefined,text},maximum))yield {...part,documentLocation:{...part.documentLocation,sheetName:sheet.name,rowNumber:row.rowNumber}};}return;}
 for(const page of document.pages??[{text:document.text,pageNumber:undefined}])for(let offset=0;offset<page.text.length;){let end=Math.min(page.text.length,offset+maximum);if(end<page.text.length&&page.text.charCodeAt(end-1)>=0xd800&&page.text.charCodeAt(end-1)<=0xdbff)end--;const text=page.text.slice(offset,end);yield {text,documentLocation:{...(page.pageNumber?{pageNumber:page.pageNumber}:{}),offset,length:text.length}};offset=end;}
}
