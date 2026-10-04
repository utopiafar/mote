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
const oldCodingSchema=codingEvidenceSchema.omit({channel:true,attribution:true});
async function open(){const engine=new SourceSync(join(directory,'state.json'));await engine.initialize();return engine;}
const pending=()=>sourceState(join(directory,'state.json')) as {pendingRealtime:SourceItem[];codingWireFields?:Record<string,0|1>};

describe('Coding wire capabilities preserve immutable outbox revisions',()=>{
  it.each([undefined,0,2,'1'])('uploads old-compatible single and batch bodies without a known capability (%j)',async capability=>{
    const engine=await open(),saved:SourceItem[]=[],paths:string[]=[];
    const request:SourceRequest=async(path,body)=>{
      if(path==='/api/sources')return {...source,...(capability===undefined?{}:{capabilities:{codingEvidenceFieldsVersion:capability}})};
      paths.push(path);const values=(body as {items?:SourceItem[]}).items??[body as SourceItem];
      const receipts=values.map(value=>{oldCodingSchema.parse(value.document!.coding);saved.push(structuredClone(value));return sourceAck(source.id,value);});
      return (body as {items?:SourceItem[]}).items?{receipts}:receipts[0];
    };
    await engine.stage(scan([generated('one')]),false,'2001-03-01T00:00:00Z');
    expect(pending().pendingRealtime[0].document!.coding).toMatchObject({channel:'analysis',attribution:'human'});
    await engine.flush(source,request);
    await engine.stage(scan([generated('two'),generated('three')]),false,'2001-03-02T00:00:00Z');
    await engine.flush(source,request);
    expect(paths).toEqual(['/api/sources/generated-coding/items','/api/sources/generated-coding/items/batch']);
    expect(saved).toHaveLength(3);
    for(const value of saved){expect(value.document!.coding).not.toHaveProperty('channel');expect(value.document!.coding).not.toHaveProperty('attribution');expect(value.text).toBe(generated('one').text);}
    expect(engine.status().pending).toBe(0);expect(Object.values(pending().codingWireFields??{})).toEqual([0,0,0]);
  });

  it('retains local metadata and identical retry bytes after ACK loss, restart and a Central upgrade',async()=>{
    let engine=await open(),version:0|1=0,loseAck=true;
    const remote=new Map<string,string>(),saved:SourceItem[]=[],registrationVersions:number[]=[];
    const request:SourceRequest=async(path,body)=>{
      if(path==='/api/sources'){registrationVersions.push(version);return {...source,...(version?{capabilities:{codingEvidenceFieldsVersion:1}}:{})};}
      const values=(body as {items?:SourceItem[]}).items??[body as SourceItem];
      const receipts=values.map(value=>{
        (version?codingEvidenceSchema:oldCodingSchema).parse(value.document!.coding);
        const key=value.externalId+'\0'+value.revision,bytes=JSON.stringify(value);
        if(remote.has(key))expect(bytes,'an immutable revision cannot change when Central upgrades').toBe(remote.get(key));
        else remote.set(key,bytes);
        saved.push(structuredClone(value));return sourceAck(source.id,value);
      });
      if(loseAck){loseAck=false;throw Error('Generated ACK loss');}
      return (body as {items?:SourceItem[]}).items?{receipts}:receipts[0];
    };
    await engine.stage(scan([generated('accepted-old')]),false,'2001-03-01T00:00:00Z');
    await expect(engine.flush(source,request)).rejects.toThrow('ACK loss');
    expect(pending().pendingRealtime[0].document!.coding).toMatchObject({channel:'analysis',attribution:'human'});
    expect(Object.values(pending().codingWireFields??{})).toEqual([0]);
    version=1;engine=await open();await engine.flush(source,request);
    expect(saved[0]).toEqual(saved[1]);expect(saved[1].document!.coding).not.toHaveProperty('attribution');
    await engine.stage(scan([generated('new-one'),generated('new-two')]),false,'2001-03-02T00:00:00Z');
    await engine.flush(source,request);
    expect(saved.slice(2).map(value=>value.document!.coding)).toEqual([
      expect.objectContaining({channel:'analysis',attribution:'human'}),expect.objectContaining({channel:'analysis',attribution:'human'})]);
    expect(registrationVersions).toEqual([0,1,1]);expect(engine.status().pending).toBe(0);
    expect(Object.values(pending().codingWireFields??{})).toEqual([0,1,1]);
  });

  it('refreshes the declared capability on each registration without restarting Desktop',async()=>{
    const engine=await open(),saved:SourceItem[]=[];let version=0;
    const request:SourceRequest=async(path,body)=>{
      if(path==='/api/sources')return {...source,capabilities:{codingEvidenceFieldsVersion:version}};
      const value=body as SourceItem;saved.push(structuredClone(value));return sourceAck(source.id,value);
    };
    await engine.stage(scan([generated('before-upgrade')]),false);await engine.flush(source,request);
    version=1;await engine.stage(scan([generated('after-upgrade')]),false);await engine.flush(source,request);
    expect(saved[0].document!.coding).not.toHaveProperty('channel');
    expect(saved[1].document!.coding).toMatchObject({channel:'analysis',attribution:'human'});
  });

  it('pins the new format too, so ACK loss cannot silently remove metadata on a later retry',async()=>{
    let engine=await open(),version=1,fail=true;const saved:SourceItem[]=[];
    const request:SourceRequest=async(path,body)=>{
      if(path==='/api/sources')return {...source,capabilities:{codingEvidenceFieldsVersion:version}};
      const value=body as SourceItem;saved.push(structuredClone(value));if(fail){fail=false;throw Error('Generated ACK loss');}return sourceAck(source.id,value);
    };
    await engine.stage(scan([generated('new-format')]),false);await expect(engine.flush(source,request)).rejects.toThrow('ACK loss');
    expect(Object.values(pending().codingWireFields??{})).toEqual([1]);
    version=0;engine=await open();await engine.flush(source,request);
    expect(saved[1]).toEqual(saved[0]);expect(saved[1].document!.coding).toMatchObject({channel:'analysis',attribution:'human'});
  });

  it.each(['policy','adapter'])('retains ACKed format pins when a %s reset rescans the same native revision',async reset=>{
    let engine=await open(),version=0;const saved:SourceItem[]=[],remote=new Map<string,string>();
    const native=generated('native-replay'),codingScan={...scan([native]),checkpoint:{version:2,cursor:'Generated Coding append checkpoint'}};
    const request:SourceRequest=async(path,body)=>{
      if(path==='/api/sources')return {...source,capabilities:{codingEvidenceFieldsVersion:version}};
      const value=body as SourceItem,{observedAt:_,...semantic}=value,key=value.externalId+'\0'+value.revision;
      if(remote.has(key))expect(JSON.stringify(semantic)).toBe(remote.get(key));else remote.set(key,JSON.stringify(semantic));
      saved.push(structuredClone(value));return sourceAck(source.id,value);
    };
    await engine.ensurePolicy('generated-original-policy');await engine.stage(codingScan,false,'2001-03-01T00:00:00Z');
    await engine.flush(source,request);expect(Object.values(pending().codingWireFields??{})).toEqual([0]);
    version=1;engine=await open();
    if(reset==='policy')await engine.ensurePolicy('generated-new-policy');else await engine.ensureAdapterVersion(2);
    await engine.stage(codingScan,false,'2001-03-02T00:00:00Z');await engine.flush(source,request);
    expect(saved[1].revision).toBe(saved[0].revision);expect(saved[1].document!.coding).toEqual(saved[0].document!.coding);
    expect(saved[1].document!.coding).not.toHaveProperty('channel');expect(Object.values(pending().codingWireFields??{})).toEqual([0]);
  });
});
