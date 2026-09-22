// Generic format decoding only. A model decides what the content means and what to import.
import {readFile,lstat,realpath} from 'node:fs/promises';
import {dirname,extname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeDocument} from "__DOCUMENT_DECODER__";
import {sourceItemSchema} from "__MOTE_SHARED__";
import {z} from "__ZOD__";

const MAX_BYTES=64*1024*1024,MAX_CHARS=2_000_000,MAX_ROWS=20000,MAX_COLUMNS=500;
const workspace=dirname(fileURLToPath(import.meta.url));
const inputPaths=new Set(__MOTE_INPUT_PATHS__.map(path=>resolve(workspace,path)));
const within=(root,path)=>{const part=relative(root,path);return part===''||(!part.startsWith(`..${sep}`)&&part!=='..'&&!isAbsolute(part));};
const recordSchema=z.object({item:sourceItemSchema,evidencePaths:z.array(z.string().min(1).max(4000)).min(1).max(100),attachments:z.array(z.string().min(1).max(4000)).max(100).default([])}).strict();
async function fileBytes(path,maximum=MAX_BYTES){
  const resolved=resolve(workspace,path),info=await lstat(resolved);
  if(!info.isFile()||info.isSymbolicLink()||await realpath(resolved)!==resolved)throw Error('Expected a regular file without symbolic links');
  if(info.size>maximum)throw Error(`File exceeds the ${maximum} byte helper limit`);
  return {path:resolved,bytes:await readFile(resolved)};
}
const unsupported=(path,format,reason)=>({status:'unsupported',sourcePath:path,format,warnings:[reason],truncated:false});
const parsed=(path,format,fields={},warnings=[],truncated=false)=>({status:'parsed',sourcePath:path,format,...fields,warnings,truncated});
function csvRows(text,delimiter){
  const rows=[];let row=[],cell='',quoted=false,closed=false,truncated=false;
  const pushCell=()=>{row.push(cell);cell='';closed=false;if(row.length>MAX_COLUMNS)throw Error('Delimited text exceeds the 500 column helper limit');};
  const pushRow=()=>{pushCell();rows.push(row);row=[];if(rows.length>=MAX_ROWS)truncated=true;};
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(quoted){if(ch==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=ch;continue;}
    if(ch==='"'&&!cell&&!closed){quoted=true;continue;}
    if(ch===delimiter){pushCell();continue;}
    if(ch==='\n'||ch==='\r'){if(ch==='\r'&&text[i+1]==='\n')i++;pushRow();if(truncated&&i<text.length-1)break;continue;}
    if(closed)throw Error('Unexpected characters after a quoted CSV field');cell+=ch;
  }
  if(quoted)throw Error('Unterminated quoted CSV field');if(!truncated&&(cell||row.length||closed))pushRow();
  return {rows,truncated};
}
async function decodeFile(input){
  const path=resolve(workspace,input);
  if(!inputPaths.has(path))throw Error('Choose one of the supplied input paths');
  let loaded;try{loaded=await fileBytes(path);}catch(error){return unsupported(path,'unknown',error.message);}
  const {bytes}=loaded,extension=extname(path).toLowerCase();
  try{
    if(bytes.subarray(0,5).toString()==='%PDF-'||extension==='.pdf'||extension==='.docx'||extension==='.xlsx'){
      const format=extension==='.docx'?'docx':extension==='.xlsx'?'xlsx':'pdf',mime=format==='pdf'?'application/pdf':format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      const decoded=await decodeDocument(bytes,mime,{pdf:async()=>{const pdf=await import("__PDFJS__");pdf.GlobalWorkerOptions.workerSrc="__PDF_WORKER__";return pdf;},docx:()=>import("__MAMMOTH__"),xlsx:()=>import("__EXCELJS__"),pdfOptions:{standardFontDataUrl:"__PDF_STANDARD_FONTS__"}});
      const fields=decoded.sheets?{sheets:decoded.sheets}:decoded.pages?{pages:decoded.pages,pageCount:decoded.pageCount}:{text:decoded.text};
      return {status:decoded.status==='ready'?'parsed':'unsupported',sourcePath:path,format,...fields,warnings:decoded.warnings,truncated:decoded.coverage==='partial',coverage:decoded.coverage};
    }
    const textExtensions=['.txt','.md','.markdown','.json','.jsonl','.ndjson','.csv','.tsv','.yaml','.yml','.log'];
    if(!textExtensions.includes(extension))return unsupported(path,extension.slice(1)||'unknown','No generic helper decoder is available for this format. Keep the original and use an appropriate parser; do not invent extracted content.');
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return unsupported(path,extension.slice(1),'Input is not valid UTF-8; choose an explicit encoding before parsing.');}
    if(text.includes('\u0000'))return unsupported(path,extension.slice(1),'Input contains NUL bytes and may not be a plain-text file.');
    if(['.json','.jsonl','.ndjson','.yaml','.yml','.csv','.tsv'].includes(extension)&&text.length>MAX_CHARS)return unsupported(path,extension.slice(1),'Structured text exceeds 2,000,000 characters. Partition it explicitly instead of parsing a truncated structure.');
    if(extension==='.json')return parsed(path,'json',{data:JSON.parse(text)});
    if(extension==='.yaml'||extension==='.yml'){const yaml=await import("__YAML__");return parsed(path,'yaml',{data:yaml.parse(text,{maxAliasCount:100})});}
    if(extension==='.jsonl'||extension==='.ndjson'){
      const lines=text.split(/\r?\n/),records=[];let truncated=false;
      for(let line=0;line<lines.length;line++){if(!lines[line].trim())continue;if(records.length>=MAX_ROWS){truncated=true;break;}try{records.push({lineNumber:line+1,value:JSON.parse(lines[line])});}catch{throw Error(`Invalid JSON at line ${line+1}`);}}
      return parsed(path,'jsonl',{records},truncated?['JSONL stopped after 20,000 records.']:[],truncated);
    }
    if(extension==='.csv'||extension==='.tsv'){const result=csvRows(text,extension==='.tsv'?'\t':',');return parsed(path,extension.slice(1),{rows:result.rows},result.truncated?['Delimited text stopped after 20,000 rows.']:[],result.truncated);}
    const truncated=text.length>MAX_CHARS;return parsed(path,extension.slice(1),{text:text.slice(0,MAX_CHARS)},truncated?['Text was truncated at 2,000,000 characters.']:[],truncated);
  }catch(error){return unsupported(path,extension.slice(1)||'unknown',`Parser failed: ${String(error.message??error).slice(0,1500)}`);}
}

export async function extractFile(input){
  const result=await decodeFile(input);
  if(JSON.stringify(result).length>MAX_CHARS+10000)return unsupported(result.sourcePath,result.format,'Decoded output exceeds 2,000,000 characters. Use an explicit partitioning script; the helper has not returned a complete extraction.');
  return result;
}

export async function validateRecords(input){
  const path=resolve(workspace,input);if(!within(workspace,path))throw Error('The records manifest must be inside this workspace');
  const {bytes}=await fileBytes(path,32*1024*1024),lines=bytes.toString('utf8').split(/\r?\n/),errors=[],seen=new Set();let count=0;
  for(let index=0;index<lines.length;index++){
    if(!lines[index].trim())continue;count++;if(count>10000){errors.push({line:index+1,error:'Manifest exceeds 10,000 records'});break;}
    try{
      const value=recordSchema.parse(JSON.parse(lines[index])),identity=JSON.stringify([value.item.externalId,value.item.revision]);
      if(seen.has(identity))throw Error('Duplicate externalId/revision');seen.add(identity);
      for(const ref of [...value.evidencePaths,...value.attachments])if(!inputPaths.has(resolve(workspace,ref)))throw Error('References must point to a supplied input file');
    }catch(error){errors.push({line:index+1,error:String(error.message??error).slice(0,1000)});if(errors.length>=100)break;}
  }
  return {valid:errors.length===0,count,errors};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [command,path]=process.argv.slice(2);if(!path||!['extract','validate'].includes(command))throw Error('Usage: node mote-files.mjs extract <input-path> | validate <records.jsonl>');const result=command==='extract'?await extractFile(path):await validateRecords(path);process.stdout.write(JSON.stringify(result)+'\n');if(result.valid===false)process.exitCode=1;}
  catch(error){process.stderr.write(String(error.message??error)+'\n');process.exitCode=1;}
}
