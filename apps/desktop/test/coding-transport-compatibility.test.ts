import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codingEvidenceSchema} from '@mote/shared';
import {SourceSync} from '../src/source-sync';
import {sourceState} from '../src/source-state-store';
import type {ScannedItem,SourceDefinition,SourceItem,SourceRequest,SourceScan} from '../src/source-types';
import {sourceAck} from './fixtures';

let directory:string;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'mote-generated-coding-wire-'));});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
const source:SourceDefinition={id:'generated-coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos',retention:'snapshot',enabled:true};
const generated=(id:string):ScannedItem=>({externalId:id,title:'Generated message',text:'Generated original request 🌱',kind:'message',layer:'snapshot',deleted:false,
  document:{contentRole:'transcript',timeBasis:'recorded',recordedAt:'2001-01-01T10:00:00Z',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:id,role:'user',channel:'analysis',attribution:'human',part:0,parts:1}}});
const scan=(items:ScannedItem[]):SourceScan=>({items,seen:items.map(item=>item.externalId),complete:true,skipped:0});
async function open(){const engine=new SourceSync(join(directory,'state.json'));await engine.initialize();return engine;}
describe('current Coding wire preserves immutable outbox revisions',()=>{
 it.each([undefined,0,1,2])('sends complete current fields regardless of historical capability %j',async capability=>{
  const engine=await open(),saved:SourceItem[]=[];const request:SourceRequest=async(path,body)=>{if(path==='/api/sources')return {...source,capabilities:{codingEvidenceFieldsVersion:capability}};
   const values=(body as {items?:SourceItem[]}).items??[body as SourceItem],receipts=values.map(value=>{codingEvidenceSchema.parse(value.document!.coding);saved.push(structuredClone(value));return sourceAck(source.id,value);});return (body as {items?:SourceItem[]}).items?{receipts}:receipts[0];};
  await engine.stage(scan([generated('one')]),false);await engine.flush(source,request);await engine.stage(scan([generated('two'),generated('three')]),false);await engine.flush(source,request);
  expect(saved).toHaveLength(3);for(const item of saved)expect(item.document!.coding).toMatchObject({channel:'analysis',attribution:'human'});expect(engine.status().pending).toBe(0);
  expect(sourceState(join(directory,'state.json'))).not.toHaveProperty('codingWireFields');
 });
 it('retries exact complete bodies after ACK loss, restart and advertised capability changes',async()=>{
  let engine=await open(),fail=true,capability=1;const sent:SourceItem[]=[];
  const request:SourceRequest=async(path,body)=>{if(path==='/api/sources')return {...source,capabilities:{codingEvidenceFieldsVersion:capability}};const item=body as SourceItem;sent.push(structuredClone(item));if(fail){fail=false;throw Error('Generated ACK loss');}return sourceAck(source.id,item);};
  await engine.stage(scan([generated('generated-retry')]),false);await expect(engine.flush(source,request)).rejects.toThrow('ACK loss');capability=0;engine=await open();await engine.flush(source,request);
  expect(sent[1]).toEqual(sent[0]);expect(sent[1].document!.coding).toMatchObject({channel:'analysis',attribution:'human'});expect(engine.status().pending).toBe(0);
 });
});
