import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';import {SourceStore} from '../src/sources.js';import {MaterialStore,materialId} from '../src/materials.js';import {MaterialOrganizerRuntime} from '../src/material-organizers.js';import {MemoryStore} from '../src/memory.js';

test('source intake publishes canonical original text; exact multiline Unicode quotes validate and changed punctuation fails',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-canonical-generated-')),store=new Store(dir),sources=new SourceStore(store),materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);
 t.after(async()=>{await organizers.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const text='Generated “quoted” line.\nPath C:\\Notes\\fixture 😀.',document={recordedAt:'2026-10-01T09:00:00+08:00',timeBasis:'recorded' as const,contentRole:'authored' as const};
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 await sources.upsert('generated',{externalId:'diary',revision:'1',text,observedAt:'2026-10-12T00:00:00Z',kind:'message',layer:'original',document});await organizers.tick();
 const material=materials.get(materialId('generated','diary'))!,input=materials.input(material.ref,['source-body'])!;
 assert.equal(input.evidenceIds.length,1);const record=materials.evidence(input.evidenceIds)[0];assert.equal(record.ocrText,text);assert.deepEqual(record.provenance?.document,document);assert.equal(material.schemaVersion,2);
 const memory=new MemoryStore(store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id)),result=(quote:string)=>({runId:'generated',trace:[],citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Generated',excerpt:text}],answer:JSON.stringify({memories:[{title:'Generated original',statement:`Generated source account [${record.id}]`,uncertainty:'Invented fixture only',admission:{layer:'observation',reason:'Fixture',scope:'One generated original',attribution:'observed'},evidenceIds:[record.id],evidence:[{id:record.id,quote}]}]})});
 const saved=memory.extract(result(text),'generated-only',{requireAdmission:true,evidenceRanges:[{id:record.id,offset:0,length:text.length}]});assert.equal(saved.items[0].evidence[0].quote,text);assert.equal(saved.items[0].evidence[0].offset,0);
 assert.throws(()=>memory.extract(result(text.replace('“','"')),'generated-only',{requireAdmission:true,validateOnly:true}),e=>Boolean(e&&typeof e==='object'&&'code' in e&&e.code==='quote_not_found'));
 const old=material.ref,anchor=record.id;await sources.upsert('generated',{externalId:'diary',revision:'2',text:'Generated new original',observedAt:'2026-10-12T00:00:01Z',kind:'message',layer:'original',document});await organizers.tick();
 assert.equal(materials.evidence([anchor],true)[0].ocrText,text,'immutable old text and quote coordinates survive new publication');assert.equal(materials.isCurrentEvidence(anchor),false);assert.equal(materials.get(old)?.revision,material.revision);
});
