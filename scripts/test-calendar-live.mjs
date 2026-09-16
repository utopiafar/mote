/** Opt-in live-model evaluation: generated text only; never opens a personal archive. */
import {calendarExpired} from '../packages/shared/dist/actions.js';
import {readFileSync} from 'node:fs';import {parseEnv} from 'node:util';import {randomUUID} from 'node:crypto';import {createAgent} from '../packages/agent/dist/index.js';
const path=process.argv[2];if(!path)throw Error('Pass an explicit private model env file. Only generated text is transmitted.');
const env=parseEnv(readFileSync(path,'utf8'));
const cases=[
 {name:'explicit personal appointment',text:'合成测试。消息时间2099年9月16日，北京时间。我的安排：2099年9月18日15:00到16:00，我和设计师在三楼会议室评审方案。',expected:1,date:'2099-09-18'},
 {name:'old relative date is historical',text:'合成聊天历史。原始消息日期2020年1月1日，北京时间。我说明天下午三点到四点开会。该截图于2026年9月16日上传。',expected:0},
 {name:'other person is not the owner',text:'合成测试。消息日期2099年9月16日。我记录同事小王的安排：他将在2099年9月18日下午三点到四点去体检。我不参加。',expected:0},
 {name:'hypothetical meeting',text:'合成测试。我们有机会下周吃个饭吧，具体哪天还不知道，也没有确认。',expected:0},
 {name:'cancellation prevents creation',text:'合成测试。原定2099年9月18日15:00到16:00我参加方案评审。更新：这次评审已取消，无需参加，也不改期。',expected:0},
 {name:'missing end remains unresolved',text:'合成测试。我的安排：2099年9月18日北京时间15:00，到三楼会议室参加方案评审。结束时间尚未确定。',expected:1,missingEnd:true},
];
let current;const reader={search:async()=>[current],timeline:async()=>[current],evidence:async({ids})=>ids.includes(current.id)?[current]:[],activity:async()=>({}),devices:async()=>[]};
const agent=createAgent({reader,model:env.MOTE_MODEL,apiKey:env.MOTE_MODEL_API_KEY,baseUrl:env.MOTE_MODEL_BASE_URL,provider:env.MOTE_MODEL_PROVIDER??'deepseek',protocol:env.MOTE_MODEL_PROTOCOL??'deepseek',maxTokens:8192,timeoutMs:120000});
let failed=0,executed=0,rawMismatches=0;try{for(const c of cases.filter(c=>!process.env.MOTE_FIXTURE_CASE||c.name===process.env.MOTE_FIXTURE_CASE)){executed++;current={id:randomUUID(),capturedAt:'2026-09-16T00:00:00Z',deviceId:'synthetic-evaluation',appName:'Generated evaluation',ocrText:c.text};try{const r=await agent.query({question:'Read only the generated evidence and return calendar-extraction output. There are no existing proposals.',skill:'calendar-extraction',evidenceIds:[current.id],evidenceRanges:[{id:current.id,offset:0,length:c.text.length}],timeZone:'Asia/Shanghai'});const parsed=JSON.parse(r.answer),rawActions=parsed.actions,a=Array.isArray(rawActions)?rawActions.filter(a=>!calendarExpired(a.event)):rawActions;if(rawActions?.length!==c.expected)rawMismatches++;let pass=Array.isArray(a)&&a.length===c.expected;if(c.date&&pass)pass=a[0].event.start?.startsWith(c.date);if(c.missingEnd&&pass)pass=a[0].event.end===null;if(a?.length)pass=pass&&a.every(a=>a.evidence?.every(e=>e.id===current.id&&c.text.includes(e.quote)));if(!pass)failed++;console.log(JSON.stringify({case:c.name,pass,actions:a?.length??null,rawActions:rawActions?.length??null,...(!pass?{generatedEvents:a?.map(a=>a.event)}:{})}));}catch{failed++;console.log(JSON.stringify({case:c.name,pass:false,error:'model_or_output_validation'}));}}}finally{await agent.close();}
console.log(JSON.stringify({model:env.MOTE_MODEL,cases:executed,failed,rawCountMismatches:rawMismatches,scope:'generated text only; no personal archive or real calendar access'}));process.exitCode=failed?1:0;
