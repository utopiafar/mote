import {moteText} from './i18n.js';
import type {Transcript} from '@mote/shared';
import {Readable,pipeline} from 'node:stream';
import {createGzip} from 'node:zlib';
import {StoreError} from './execution-storage.js';

const clock=(ms:number)=>{const value=Math.floor(ms);return `${String(Math.floor(value/3600000)).padStart(2,'0')}:${String(Math.floor(value/60000)%60).padStart(2,'0')}:${String(Math.floor(value/1000)%60).padStart(2,'0')}.${String(value%1000).padStart(3,'0')}`;};
export function transcriptMarkdown(transcript:Transcript,title:string){return `# ${title}\n\n${(transcript.warnings??[]).map(s=>'> '+s).join('\n')}\n\n`+transcript.segments.map(s=>`${clock(s.startMs)}–${clock(s.endMs)} ${s.speaker??moteText("未标记说话人")}${s.uncertain?moteText(" [说话人不确定]"):''}${s.overlap?moteText(" [重叠]"):''}\n\n${s.text}\n`).join('\n');}
export const csvCell=(value:unknown)=>'"'+String(value??'').replace(/"/g,'""')+'"';
export function transcriptCsv(transcript:Transcript){return '\ufeff'+[['start_ms','end_ms','speaker','uncertain','overlap','text'],...transcript.segments.map(s=>[s.startMs,s.endMs,s.speaker??'',!!s.uncertain,!!s.overlap,s.text])].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';}
/** Fixed, generated file names only. USTAR bytes can be read by tar or common archive applications. */
export type ExportTarEntry={name:string}&({bytes:Buffer}|{sizeBytes:number;chunks:()=>Iterable<Buffer>});
export function exportTar(entries:ExportTarEntry[],assertCurrent:()=>void=()=>{}){
  function* blocks(){for(const entry of entries){assertCurrent();
    const size='bytes' in entry?entry.bytes.length:entry.sizeBytes;
    if(!Number.isSafeInteger(size)||size<0)throw new StoreError('Invalid export entry');
    const name=Buffer.from(entry.name);if(name.length>100||entry.name.startsWith('/')||entry.name.split('/').some(x=>x==='..'||!x))throw new StoreError('Invalid export entry');
    const header=Buffer.alloc(512);name.copy(header);header.write('0000600\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(size.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
    const sum=header.reduce((a,b)=>a+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);yield header;assertCurrent();let emitted=0;
    for(const chunk of 'bytes' in entry?[entry.bytes]:entry.chunks()){assertCurrent();emitted+=chunk.length;if(emitted>size)throw new StoreError('Invalid export entry');yield chunk;}
    if(emitted!==size)throw new StoreError('Invalid export entry');const padding=(512-size%512)%512;if(padding)yield Buffer.alloc(padding);
  }assertCurrent();yield Buffer.alloc(1024);}
  // Start only when the HTTP consumer reads. Eager gzip could finish while an
  // onSend/backpressure barrier still held the response, bypassing retirement.
  return Readable.from((async function*(){
    assertCurrent();const source=Readable.from(blocks()),output=createGzip();
    pipeline(source,output,()=>{});
    try{for await(const chunk of output){assertCurrent();yield chunk;}}
    finally{source.destroy();output.destroy();}
  })());
}
