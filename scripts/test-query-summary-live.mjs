/** Explicit live-model check against generated records. Reads connection settings, never archive records. */
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {captureSchema} from '@mote/shared';
import {loadProfile,profilePaths} from './profile-lib.mjs';
import {buildApp} from '../apps/server/dist/app.js';
import {applyModelSettings} from '../apps/server/dist/model-agent.js';
import {readConfigDocument,resolveConfigDocument} from '../apps/server/dist/config.js';

const profile=process.argv[2];if(!profile)throw Error('Pass a profile explicitly to use its model connection with generated data');
const p=await loadProfile(profilePaths(profile));
const selected=resolveConfigDocument(readConfigDocument(p.configFile)).models;
const selectedId=selected.defaults.chat;
const settings=structuredClone(selected.profiles.find(entry=>entry.id===selectedId)?.settings??selected.deployment);
if(selected.defaultModels.chat)settings.model=selected.defaultModels.chat;
const root=await mkdtemp(join(tmpdir(),'mote-query-generated-')),out=join(process.cwd(),'.mote/query-summary-live',String(Date.now()));await mkdir(out,{recursive:true});
const original=DeepSeekHarness.prototype.run;let rounds=0,node;
DeepSeekHarness.prototype.run=async function(...args){
 const result=await original.apply(this,args),round=++rounds;
 await writeFile(join(out,`final-${round}.txt`),result.finalResponse,{mode:0o600});
 console.log(JSON.stringify({round,chars:result.finalResponse.length,ends:result.events.filter(e=>e.type==='turn/end').map(e=>e.data?.reason?.kind)}));
 return result;
};
try{
 const config={dataDir:root,token:randomBytes(32).toString('hex'),tokenPath:join(root,'token'),host:'127.0.0.1',port:0,maxExportBytes:1000000,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 applyModelSettings(config,settings);node=await buildApp(config);const headers={authorization:'Bearer '+config.token};
 const image=(await sharp({create:{width:640,height:480,channels:3,background:'#cfded4'}}).jpeg().toBuffer()).toString('base64');
 const samples=[['合成编辑器','完善示例项目的图片预览页面：调整质量滑块与放大查看。'],['合成浏览器','阅读数据库窗口函数的生成示例，核对排序与分页。'],['合成笔记','计划下午检查演示报告，结果尚未记录。'],['合成终端','运行生成数据回归测试，显示 12 项通过。'],['合成阅读器','阅读虚构短篇《秋天的观测站》，目前停在第二章。'],['合成日历','明天有一场演示会议；这是计划，不代表已经参加。']];
 const base=new Date();base.setHours(9,0,0,0);
 for(let i=0;i<400;i++){
  const group=Math.floor(i/50)%samples.length,[appName,summary]=samples[group];
  await node.store.ingest(captureSchema.parse({id:randomUUID(),deviceId:'generated-fixture',deviceName:'生成测试设备',platform:'macos',capturedAt:new Date(+base-(399-i)*60000).toISOString(),durationMs:60000,source:'screen',appId:'fixture.app'+group,appName,imageMime:'image/jpeg',imageBase64:image,windowTitle:'生成内容',ocr:{status:'completed'},ocrText:`样本 ${i+1}。${summary} 此内容完全虚构，仅用于模型与回答校验测试。`}));
 }
 console.log(JSON.stringify({phase:'query',fixtureOnly:true,records:400,model:settings.model,maxTokens:settings.maxTokens}));
 const started=Date.now();
 const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'总结我最近都干了啥',timeZone:'Asia/Shanghai'}});
 const result=response.json();
 let nestedReport=false;try{nestedReport=typeof JSON.parse(result.answer)?.html==='string';}catch{}
 const report={status:response.statusCode,durationMs:Date.now()-started,rounds,citations:result.citations?.length,tools:result.trace?.length,error:result.error,reason:result.reason,nestedReport,maxTokens:settings.maxTokens,fixtureOnly:true};
 console.log(JSON.stringify(report));await writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
 if(response.statusCode!==200||nestedReport)process.exitCode=1;
}finally{DeepSeekHarness.prototype.run=original;await node?.app.close();await rm(root,{recursive:true,force:true});}
