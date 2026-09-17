import { moteText } from './i18n.js';
import {Readable} from 'node:stream';
import {createGzip} from 'node:zlib';
import type {Transcript} from '@mote/shared';
import {FileStore} from './files.js';
import {StoreError} from './store.js';

const clock=(ms:number)=>{const value=Math.floor(ms);return `${String(Math.floor(value/3600000)).padStart(2,'0')}:${String(Math.floor(value/60000)%60).padStart(2,'0')}:${String(Math.floor(value/1000)%60).padStart(2,'0')}.${String(value%1000).padStart(3,'0')}`;};
function markdown(transcript:Transcript,title:string){return `# ${title}\n\n${(transcript.warnings??[]).map(s=>'> '+s).join('\n')}\n\n`+transcript.segments.map(s=>`${clock(s.startMs)}–${clock(s.endMs)} ${s.speaker??moteText("未标记说话人")}${s.uncertain?moteText(" [说话人不确定]"):''}${s.overlap?moteText(" [重叠]"):''}\n\n${s.text}\n`).join('\n');}
const csvCell=(value:unknown)=>'"'+String(value??'').replace(/"/g,'""')+'"';
function csv(transcript:Transcript){return '\ufeff'+[['start_ms','end_ms','speaker','uncertain','overlap','text'],...transcript.segments.map(s=>[s.startMs,s.endMs,s.speaker??'',!!s.uncertain,!!s.overlap,s.text])].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';}
export function fileExportEntries(files:FileStore,id:string,maxBytes=64*1024*1024){
  const file=files.detail(id),db=files.store.db;
  const artifacts=(db.prepare('SELECT id,kind,json FROM file_artifacts WHERE capture_id=? AND current=1 ORDER BY created_at DESC').all(id) as {id:string;kind:string;json:string}[]).map(a=>({...a,data:JSON.parse(a.json)}));
  const raw=artifacts.find(a=>['transcript','text','image-text'].includes(a.kind)),dialogue=artifacts.find(a=>a.kind==='dialogue'),diarization=artifacts.find(a=>a.kind==='diarization'),corrected=artifacts.find(a=>a.kind==='corrected-dialogue');
  if(!raw?.data.transcript)throw new StoreError('A current transcript is required for export',409);
  const entries:{name:string;bytes:Buffer}[]=[];let total=0;
  const add=(name:string,value:string|Buffer)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(value);total+=bytes.length;if(total>maxBytes)throw new StoreError('Processing export exceeds limit',413);entries.push({name,bytes});};
  add(moteText("原始转写_未校正.md"),markdown(raw.data.transcript,moteText("原始转写 · 未校正")));
  add(moteText("原始转写.json"),JSON.stringify(raw.data.transcript,null,2));
  if(diarization){
    const data=diarization.data;
    add('diarization.json',JSON.stringify(data,null,2));
    add('diarization.rttm',data.segments.map((s:any)=>`SPEAKER ${id} 1 ${(s.startMs/1000).toFixed(3)} ${((s.endMs-s.startMs)/1000).toFixed(3)} <NA> <NA> ${s.speaker} <NA> <NA>`).join('\n')+'\n');
    add('diarization.csv',[['start_ms','end_ms','speaker'],...data.segments.map((s:any)=>[s.startMs,s.endMs,s.speaker])].map(row=>row.map(csvCell).join(',')).join('\r\n'));
    for(const asset of db.prepare('SELECT name FROM file_assets WHERE artifact_id=? ORDER BY name').all(diarization.id) as {name:string}[])add(asset.name,files.asset(id,diarization.id,asset.name).bytes);
  }
  if(dialogue){add(moteText("带说话人_未校正完整记录.md"),markdown(dialogue.data.transcript,moteText("带说话人完整记录 · 未校正")));add(moteText("带说话人_未校正完整记录.csv"),csv(dialogue.data.transcript));}
  if(corrected){add(moteText("带说话人_已确认校正记录.md"),markdown(corrected.data.transcript,moteText("已确认校正记录")));add(moteText("带说话人_已确认校正记录.csv"),csv(corrected.data.transcript));}
  const calendar=artifacts.find(a=>a.kind==='calendar-link')?.data,names=artifacts.find(a=>a.kind==='speaker-names')?.data;
  if(calendar)add(moteText("已确认场次.json"),JSON.stringify(calendar,null,2));if(names)add(moteText("已确认说话人.json"),JSON.stringify(names,null,2));
  add('manifest.json',JSON.stringify({version:1,captureId:id,sourceId:file.sourceId,originalTitle:file.item.title,originalSha256:file.sha256,job:file.job,steps:file.steps,processingPolicy:(()=>{const json=db.prepare('SELECT policy_json FROM file_jobs WHERE capture_id=?').get(id)?.policy_json;return json?JSON.parse(String(json)):null;})(),uncorrectedPreserved:true,artifacts:artifacts.map(({id,kind})=>({id,kind})),calendarConfirmed:!!calendar,speakerNamesConfirmed:!!names},null,2));
  return entries;
}
/** Fixed, generated file names only. USTAR bytes can be read by tar or common archive applications. */
export function exportTar(entries:{name:string;bytes:Buffer}[]){
  function* blocks(){for(const entry of entries){
    const name=Buffer.from(entry.name);if(name.length>100||entry.name.startsWith('/')||entry.name.split('/').some(x=>x==='..'||!x))throw new StoreError('Invalid export entry');
    const header=Buffer.alloc(512);name.copy(header);header.write('0000600\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(entry.bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
    const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);yield header;yield entry.bytes;const padding=(512-entry.bytes.length%512)%512;if(padding)yield Buffer.alloc(padding);
  }yield Buffer.alloc(1024);}
  return Readable.from(blocks()).pipe(createGzip());
}
