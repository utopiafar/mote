import {createHash} from 'node:crypto';
import {attributionContextSchema,sourceContentTime} from '@mote/shared';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {ContextToolError} from '../../tool-errors.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange, ContextRecord} from '../../context-contracts.js';

/** A08B attribution pack. It reads the host-authored attribution context for one
 * previously discovered original, pinned Material ref or sourceContextRef and
 * pages the serialized JSON by UTF-16 units. It grants no citation and never
 * reads an original body; discovery and pin validation stay in the parent Host. */

export interface AttributionPackOptions {
  readonly timeZone?:string;
}

const pinnedMaterialRef=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;
const invalid=(message:string,details:Record<string,unknown>={})=>new ContextToolError('invalid_tool_arguments',message,'correct_arguments',details);
const splitsPair=(text:string,at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1]!)&&/[\uDC00-\uDFFF]/.test(text[at]!);

function spec(name:string):readonly [string,string,ToolFields]{
  const entry=CONTEXT_TOOLS.find(([candidate])=>candidate===name);
  if(!entry)throw new Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string,string,ToolFields];
}

function scopeOf(scope:Readonly<ContextRange>):ContextRange{
  return {...(scope.after===undefined?{}:{after:scope.after}),...(scope.before===undefined?{}:{before:scope.before}),...(scope.deviceId===undefined?{}:{deviceId:scope.deviceId})};
}

function inScope(record:ContextRecord,scope:Readonly<ContextRange>):boolean{
  const at=sourceContentTime(record);
  return Number.isFinite(Date.parse(at))&&(!scope.deviceId||record.deviceId===scope.deviceId)&&(!scope.after||Date.parse(at)>=Date.parse(scope.after))&&(!scope.before||Date.parse(at)<Date.parse(scope.before));
}

/** The single attribution descriptor. Versioning is explicit so a pinned
 * snapshot cannot silently inherit a schema change. */
export function createAttributionPack(options:AttributionPackOptions={}):readonly ToolDescriptor[]{
  void options;
  const attributionSpec=spec('attribution_context');
  const attribution=defineToolDescriptor({
    apiVersion:'1',name:'attribution_context',version:'1',description:attributionSpec[1],fields:attributionSpec[2],kind:'metadata',exposure:'native',
    requires:['evidence','sourceContext','materialRead'],
    parse(args){
      if(Object.keys(args).some(key=>!['id','ref','sourceContextRef','offset','length','expectedFingerprint'].includes(key))||
        [args.id,args.ref,args.sourceContextRef].filter(value=>value!==undefined).length!==1)throw invalid('Choose exactly one discovered original id, pinned Material ref or sourceContextRef');
      const offset=args.offset??0,length=args.length??8000;
      if(!Number.isSafeInteger(offset)||Number(offset)<0||!Number.isSafeInteger(length)||Number(length)<1||Number(length)>12000)
        throw invalid('Attribution offset must be nonnegative and length must be 1–12000 UTF-16 units');
      if(args.expectedFingerprint!==undefined&&(typeof args.expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(args.expectedFingerprint)))throw invalid('Invalid attribution context fingerprint');
      if(Number(offset)>0&&args.expectedFingerprint===undefined)throw invalid('Copy contextFingerprint as expectedFingerprint when continuing an attribution page');
      return {...args};
    },
    async execute(args,port:HostSessionPort){
      const scope=scopeOf(port.scope);
      let context:unknown,locator:{id:string}|{ref:string}|{sourceContextRef:string};
      if(args.id!==undefined){
        const id=args.id as string;
        port.assertCurrent();
        const records=await port.read('evidence',{...scope,ids:[id]});
        port.assertCurrent();
        const record=Array.isArray(records)?(records as ContextRecord[]).find(candidate=>candidate.id===id):undefined;
        if(!record)throw invalid('Original attribution context is unavailable in the current scope');
        if(!inScope(record,scope))throw invalid('Original attribution context is outside the selected scope');
        context=record.attributionContext;locator={id};
      }else if(args.sourceContextRef!==undefined){
        const sourceContextRef=args.sourceContextRef as string;
        port.assertCurrent();
        const page=await port.read('sourceContext',{...scope,sourceContextRef});
        port.assertCurrent();
        context=page.attributionContext;locator={sourceContextRef};
      }else{
        const ref=args.ref as string;
        if(!pinnedMaterialRef.test(ref))throw invalid('Use an exact pinned Material ref returned in this run');
        port.assertCurrent();
        const page=await port.read('materialRead',{...scope,ref,offset:0,length:2});
        port.assertCurrent();
        if(!page.material||page.material.ref!==ref)throw invalid('Material attribution context changed or left the selected scope');
        context=page.material.attributionContext;locator={ref};
      }
      const parsed=attributionContextSchema.safeParse(context??{version:1,ownerRelation:'unknown',basis:'default'});
      if(!parsed.success)throw invalid('Invalid host attribution context');
      const text=JSON.stringify(parsed.data),contextFingerprint=createHash('sha256').update(text).digest('hex');
      if(args.expectedFingerprint!==undefined&&args.expectedFingerprint!==contextFingerprint)
        throw new ContextToolError('attribution_context_changed','The current attribution context changed. Restart at offset 0; do not combine pages from different versions.','correct_arguments');
      const start=Number(args.offset??0),requestedLength=Number(args.length??8000);
      if(start>text.length||splitsPair(text,start))throw invalid('Attribution offset exceeds its context or splits a UTF-16 pair');
      let end=Math.min(text.length,start+requestedLength);
      if(splitsPair(text,end))end--;
      if(end===start&&start<text.length)throw invalid('Attribution length must deliver a complete UTF-16 character');
      return {source:'untrusted_personal_context',data:{...locator,contextFingerprint,offset:start,total:text.length,nextOffset:end<text.length?end:null,text:text.slice(start,end),citationAuthority:false}};
    },
  });
  return Object.freeze([attribution]);
}
