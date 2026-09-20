/** Reproducible generated fixtures only. No models, external sources or personal files. */
import {mkdtempSync,rmSync,writeFileSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {gzipSync} from 'node:zlib';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import {Store} from '../apps/server/src/store.js';
import {SourceStore} from '../apps/server/src/sources.js';
const path=mkdtempSync(join(tmpdir(),'mote-scale-')),store=new Store(path,{maxStorageBytes:4*1024**3}),sources=new SourceStore(store);
const counts={observations:Number(process.env.MOTE_BENCH_OBSERVATIONS??20000),files:Number(process.env.MOTE_BENCH_FILES??100000)};
const report:any={generatedAt:new Date().toISOString(),fixtureOnly:true,realModelsCalled:0,node:process.version,cpu:cpus()[0].model,counts,measurements:{},assumptions:{imageKiB:150,jsonKiB:4,activeHours:16,sampleSeconds:5}};
const timings:number[]=[];const mark=(name:string,value:unknown)=>{report.measurements[name]=value;console.log(JSON.stringify({stage:name,value}));};
try{
 const image=(await sharp({create:{width:64,height:64,channels:3,background:'#aaccee'}}).png().toBuffer()).toString('base64');
 const started=performance.now();
 for(let start=0;start<counts.observations;start+=100){
  const rows=Array.from({length:Math.min(100,counts.observations-start)},(_,j)=>{const i=start+j;return {id:randomUUID(),deviceId:'generated-screen',deviceName:'Generated',platform:'macos',source:'screen',appId:'fixture',appName:'Fixture',windowTitle:'Generated document',capturedAt:new Date(Date.parse('2026-01-01T00:00:00Z')+i*5000).toISOString(),durationMs:5000,imageMime:'image/png',imageBase64:image,ocrText:`Fact_${String(Math.floor(i/12)).padStart(6,'0')}. Exact fact: reactor ${Math.floor(i/12)} temperature is ${40+Math.floor(i/12)%7}. `+'Generated multilingual text 测试数据，无个人内容。'.repeat(15),ocr:{status:'completed'},privacy:{excluded:false,redacted:false,mode:'none'}};});
  const at=performance.now();await store.ingestBatch(rows);timings.push(performance.now()-at);
 }
 mark('observationIngest',{durationMs:performance.now()-started,batchSize:100,p50Ms:timings.sort((a,b)=>a-b)[Math.floor(timings.length*.5)],p95Ms:timings[Math.floor(timings.length*.95)],observationsPerSecond:counts.observations/(performance.now()-started)*1000});
 const aggregateStart=performance.now();while(store.archive.aggregate(100)){};
 const stats=store.archive.stats();const totals=store.db.prepare("SELECT SUM(json_extract(json,'$.metadata.originalCharacters')) AS raw,SUM(json_extract(json,'$.metadata.characters')) AS reduced,SUM(json_array_length(json_extract(json,'$.representatives'))) AS representatives FROM context_artifacts WHERE kind='segment'").get()!;
 mark('aggregation',{durationMs:performance.now()-aggregateStart,...stats,...totals,textReductionRatio:1-Number(totals.reduced)/Number(totals.raw),representativeReductionRatio:1-Number(totals.representatives)/counts.observations});
 const retrievalStart=performance.now();let facts=0;for(const number of [0,10,50,500,1000].filter(n=>n*12<counts.observations)){const q=`Fact_${String(number).padStart(6,'0')}`;const originals=store.search({query:q,limit:100});assert.ok(originals.some(r=>r.ocrText.includes(`reactor ${number} temperature`)));const segments=store.archive.page({query:q});assert.ok(segments.items.some(r=>r!.text.includes(`reactor ${number} temperature`)));facts++;}
 mark('factRetrieval',{checked:facts,passed:facts,durationMs:performance.now()-retrievalStart});
 sources.register({id:'generated-nas',name:'Generated NAS',kind:'custom',deviceId:'generated-files',platform:'import',retention:'snapshot'});
 const fileStart=performance.now(),fileTimes:number[]=[];
 for(let start=0;start<counts.files;start+=500){const at=performance.now();await sources.upsertBatch('generated-nas',Array.from({length:Math.min(500,counts.files-start)},(_,j)=>({externalId:`file:${start+j}`,revision:'v1',observedAt:'2026-01-01T00:00:00Z',title:`folder-${Math.floor((start+j)/1000)}/document-${start+j}.txt`,kind:'file',layer:'reference',text:'',uri:`nas://generated/folder-${Math.floor((start+j)/1000)}/document-${start+j}.txt`})));fileTimes.push(performance.now()-at);}
 mark('fileCatalog',{durationMs:performance.now()-fileStart,files:counts.files,batchSize:500,p95Ms:fileTimes.sort((a,b)=>a-b)[Math.floor(fileTimes.length*.95)],modelCalls:0});
 const incrementalStart=performance.now(),changed=Math.min(1000,counts.files);for(let start=0;start<changed;start+=500)await sources.upsertBatch('generated-nas',Array.from({length:Math.min(500,changed-start)},(_,j)=>({externalId:`file:${start+j}`,revision:'v2',observedAt:'2026-01-02T00:00:00Z',title:`document-${start+j}.txt`,kind:'file',layer:'snapshot',text:`Generated searchable file ${start+j}. `+'Synthetic content. '.repeat(40)})));
 assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM source_heads WHERE source_id='generated-nas' AND deleted=0").get()!.n,counts.files);
 mark('incrementalTextIndex',{files:changed,durationMs:performance.now()-incrementalStart,modelCalls:0});
 const lookupStart=performance.now();assert.ok(store.search({query:'Generated searchable file 500'}).length||counts.files<501);mark('largeArchiveSearch',{durationMs:performance.now()-lookupStart});
 const usageStart=performance.now();for(let i=0;i<10000;i++)store.logicalBytes();mark('capacityAccounting',{checks:10000,durationMs:performance.now()-usageStart});
 mark('storage',{logicalBytes:store.logicalBytes(),physicalBytes:readdirSync(path).filter(n=>n.startsWith('mote.sqlite')).reduce((n,f)=>n+statSync(join(path,f)).size,0),peakRssBytes:process.resourceUsage().maxRSS*1024});
 // Parameterized estimates, kept distinct from physical fixture measurements.
 const n=16*3600/5,unique=n*.5*.6,json=n*4*1024,raw=n*154*1024,optimized=unique*150*1024+json*.25;
 report.estimates={observationsPer16h:n,rawGiBPerDay:raw/1024**3,optimizedGiBPerDay:optimized/1024**3,exactRepeatRate:.5,uiReplacementRate:.4,requestsPerDayAt60Seconds:960,transmissionMinutesAt10Mbps:optimized*8/1e7/60,ocrImagesPerDay:unique,ocrSecondsAt2Workers2Seconds:unique*2/2,rawInputTokensAt1000PerObservation:n*1000,segmentInputTokensUsingMeasuredTextRatio:Math.ceil(n*1000*Number(totals.reduced)/Number(totals.raw)),pricing:'No live price assumptions; multiply input/output token totals by configured per-million prices.',gzipFixtureRatio:gzipSync(Buffer.from('Generated 中文正文。'.repeat(1000))).length/Buffer.byteLength('Generated 中文正文。'.repeat(1000))};
 const out=process.env.MOTE_BENCH_OUTPUT??'/tmp/mote-architecture-benchmark.json';writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:true,report:out}));
}finally{store.close();rmSync(path,{recursive:true,force:true});}
