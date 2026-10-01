import {extname} from 'node:path';
import type {ArchivedFile} from '@mote/shared';
import {formatWork} from './format-work.js';
import {StoreError} from './store.js';

export type FormatInput={file:ArchivedFile;prefix:Buffer};
export type FormatMatch={mimeType:string;reason:string};
export interface ImportFormat {
  id:string;version:string;priority?:number;
  /** Byte/container/declared-format detection only; never semantic routing. */
  probe(input:FormatInput):FormatMatch|undefined;
}
export interface ImportContainer {
  id:string;version:string;priority?:number;
  probe(input:FormatInput):boolean;
  expand(input:{path:string;output:string;maxFiles:number;maxBytes:number;signal?:AbortSignal}):Promise<{files:{name:string;path:string;bytes:number;mimeType?:string}[]}>;
}
export type ImportFormatPin={id:string;version:string;mimeType:string;reason:string};

/** Cordis registrations describe capabilities. The import host retains originals
 * and commits versioned work; installing a capability never scans the vault. */
export class ImportIntakeRegistry {
  private formats=new Map<string,ImportFormat>();
  private containers=new Map<string,ImportContainer>();
  registerFormat(value:ImportFormat){return this.register(this.formats,value);}
  registerContainer(value:ImportContainer){return this.register(this.containers,value);}
  private register<T extends {id:string;version:string}>(map:Map<string,T>,value:T){
    if(!/^[a-z][a-z0-9.-]{2,127}$/.test(value.id)||!value.version||map.has(value.id))throw Error('Invalid or duplicate import capability');
    map.set(value.id,value);return ()=>{if(map.get(value.id)===value)map.delete(value.id);};
  }
  private choose<T extends {id:string;priority?:number}>(values:T[]){
    values.sort((a,b)=>(b.priority??0)-(a.priority??0));
    if(values.length>1&&(values[0].priority??0)===(values[1].priority??0))throw new StoreError('Ambiguous import capabilities; configure an explicit priority',409);
    return values[0];
  }
  container(input:FormatInput){return this.choose([...this.containers.values()].filter(value=>value.probe(input)));}
  format(input:FormatInput):ImportFormatPin|undefined{
    const matches=[...this.formats.values()].flatMap(value=>{const match=value.probe(input);return match?[{...value,match}]:[];}),selected=this.choose(matches);
    if(!selected)return;
    if(!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(selected.match.mimeType)||!selected.match.reason)throw new StoreError('Invalid import format declaration',422);
    return {id:selected.id,version:selected.version,...selected.match};
  }
  available(pin:ImportFormatPin){return this.formats.get(pin.id)?.version===pin.version;}
  list(){return {formats:[...this.formats.values()].map(({probe,...value})=>value),containers:[...this.containers.values()].map(({probe,expand,...value})=>value)};}
}

export function installImportIntake(registry:ImportIntakeRegistry){
  const audio:Record<string,string>={'.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.amr':'audio/amr','.ogg':'audio/ogg','.flac':'audio/flac','.opus':'audio/opus'};
  const images:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
  const dispose=[registry.registerFormat({id:'mote.media-format',version:'1',probe:({file,prefix})=>{
    const extension=extname(file.relativePath).toLowerCase();
    let mime=audio[extension]??images[extension];
    let basis='extension';
    if(prefix.subarray(0,4).toString()==='fLaC'){mime='audio/flac';basis='signature';}
    else if(prefix.subarray(0,4).toString()==='RIFF'&&prefix.subarray(8,12).toString()==='WAVE'){mime='audio/wav';basis='signature';}
    else if(prefix.subarray(0,3).toString()==='ID3'){mime='audio/mpeg';basis='signature';}
    else if(prefix.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){mime='image/png';basis='signature';}
    if(!mime&&/^(audio|image)\//.test(file.mimeType)){mime=file.mimeType;basis='declared MIME';}
    return mime?{mimeType:mime,reason:`Media format from ${basis}; content, authorship and event dates remain uninterpreted`}:undefined;
  }}),registry.registerContainer({id:'mote.zip-container',version:'1',probe:({file,prefix})=>
    !/\.(docx|xlsx|pptx|odt|ods)$/i.test(file.relativePath)&&prefix.length>=4&&prefix[0]===0x50&&prefix[1]===0x4b&&((prefix[2]===3&&prefix[3]===4)||(prefix[2]===5&&prefix[3]===6)),
    expand:({signal,...input})=>formatWork({kind:'zip',...input},signal),
  })];
  return ()=>dispose.reverse().forEach(stop=>stop());
}

declare module '@deepseek-ai/cordis' {interface Context {moteImportIntake:ImportIntakeRegistry;}}
