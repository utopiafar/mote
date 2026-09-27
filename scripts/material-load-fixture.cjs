/** Generated, immutable inputs shared by the existing Material UI load runner. */
const {createHash}=require('node:crypto');
const sha=value=>createHash('sha256').update(value).digest('hex');
const materialId=(sourceId,externalId)=>'mat_'+sha(JSON.stringify([sourceId,externalId]));
function makeFixture(profile='legacy-631'){
 const interactive=profile==='interactive-400';
 if(!interactive&&profile!=='legacy-631')throw Error('Unknown generated UI profile');
 const initial=interactive?159:20,total=interactive?399:631;
 const records=Array.from({length:total},(_,index)=>{
  const label=String(index).padStart(4,'0'),long=interactive&&(index<159?index>=135:(index-159)%6===5);
  const sourceId=long?'generated-long':'generated-load',sessionId='UI-'+label;
  const text=interactive?long?`HEAD ${label} 生成长文\n`+Array.from({length:240},(_,line)=>`段 ${String(line).padStart(3,'0')} / ${label}：今天整理生成材料，记录阅读位置和显示边界。“原话”与 "quotes" 保留。😀🧵 这一段只用于本地界面验证。\n`).join('')+`TAIL ${label} 完整原文结束。`:`SHORT ${label} 生成资料。保留记录编号，检查分页与来源。\n没有私人内容。😀\nEND ${label}`:
   `生成资料 ${index}。用于验证分页和长正文读取。\n`+('合成文本，不是真实个人数据。\n'.repeat(index%10===9?360:20))+`\n记录 ${index} 结束。`;
  const item={externalId:String(index),revision:'1',observedAt:new Date(Date.UTC(2026,8,1)+index*60000).toISOString(),title:long?'长文 '+sessionId:sessionId,kind:'message',layer:long?'original':'snapshot',text,...(!long?{document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId,projectKey:'generated-load',eventId:'one',role:'user',part:0,parts:1}}}:{})};
  const external=long?item.externalId:JSON.stringify(['codex','generated-load',sessionId]);
  return {index,sourceId,long,title:item.title,materialId:materialId(sourceId,external),sha256:sha(text),utf16Length:text.length,item};
 });
 const control=interactive?{sourceId:'generated-controlled',externalId:'one',deviceId:'fixture-controlled',title:'生成正文与待转写资料',body:'Generated body: I prefer written checklists.',transcript:'Generated recording: I prefer explicit retry policies.',observedAt:'2026-08-31T00:00:00.000Z',materialId:materialId('generated-controlled','one')}:undefined;
 return {schemaVersion:1,profile,initial:interactive?160:20,total:interactive?400:631,initialIngress:initial,batchSize:interactive?20:25,batchIntervalMs:interactive?500:80,records,...(control?{control}:{}),expectations:{longRecords:interactive?64:undefined,listLimit:12,readLength:4000,fullPages:interactive?33:52,lastPageItems:interactive?4:7,stubCallLimit:interactive?4:0,actionTimeoutMs:25000,runTimeoutMs:600000}};
}
module.exports={makeFixture,sha};
