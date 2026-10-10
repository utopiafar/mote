import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {uiPageText,type CaptureInput,type UiPageV2} from '@mote/shared';

/** All text and pixels are generated. Expectations are test-only, never model policy. */
export async function dailyEventFixtures(){
  const fields=(at:string,title:string,body:string,kind:'article'|'product'='article'):CaptureInput=>{
    const page:UiPageV2={version:2,scope:'visible_window',adapterId:'generated.daily-fields',adapterVersion:'1',appVersion:'fixture',activity:'fixture.Page',status:'ok',truncated:false,
      observations:{firstAt:at,lastAt:at,count:1},objects:[{kind,title,...(kind==='article'?{author:'Mira (external author)'}:{}),body:body?[{text:body}]:[],...(kind==='article'?{identity:{type:'url',value:'https://fixture.invalid/ai-archive'},url:'https://fixture.invalid/ai-archive'}:{})}]};
    return {id:randomUUID(),deviceId:'generated-daily-phone',deviceName:'Generated daily phone',platform:'android',source:'ui_page',appId:'fixture.reader',appName:'Generated reader',windowTitle:'',capturedAt:at,durationMs:0,
      ocrText:uiPageText(page),privacy:{excluded:false,redacted:true,mode:'local',collection:'content'},metadata:{version:1,observedAt:at,collector:{method:'accessibility'},uiPage:page}};
  };
  const screen=async(at:string,title:string,lines:string[]):Promise<CaptureInput>=>{
    const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const svg=`<svg width="900" height="500" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="500" fill="white"/><g font-family="sans-serif" font-size="23" fill="black">${[title,...lines].map((line,i)=>`<text x="25" y="${45+i*45}">${escape(line)}</text>`).join('')}</g></svg>`;
    const image=await sharp(Buffer.from(svg)).png().toBuffer();
    return {id:randomUUID(),deviceId:'generated-daily-phone',deviceName:'Generated daily phone',platform:'android',source:'screen',appId:'fixture.'+title,appName:'Generated '+title,windowTitle:title,capturedAt:at,durationMs:0,
      imageBase64:image.toString('base64'),imageMime:'image/png',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:true,mode:'local',collection:'content'}};
  };
  const article=fields('2026-10-09T15:59:00.000Z','AI context archives','Mira writes: I believe every programmer should use daily event memory. This is my opinion as the article author.');
  const nextDay=fields('2026-10-09T16:01:00.000Z',article.metadata!.uiPage!.version===2?article.metadata!.uiPage!.objects[0].title:'AI context archives','Mira proposes keeping original articles separate from personal memories.');
  const product=fields('2026-10-10T01:00:00.000Z','Generated Laptop Z — recommendation card','','product');
  const screenInputs=[
    {title:'Draft plan',at:'2026-10-10T02:00:00.000Z',lines:['Draft note: Plan to compare laptops next week.','No order has been placed. Task is not complete.']},
    {title:'Unpaid order',at:'2026-10-10T03:00:00.000Z',lines:['Order G-101: Generated Laptop Z, 32 GB, USD 1200.','Status: awaiting payment. Delivery: not shipped.']},
    {title:'Paid order',at:'2026-10-10T04:00:00.000Z',lines:['Order G-101: Generated Laptop Z, 32 GB, USD 1200.','Status: paid at 2026-10-10 12:00 Asia/Shanghai.','Delivery: not shipped. Recipient/owner unconfirmed.']},
    {title:'Completed task',at:'2026-10-10T05:00:00.000Z',lines:['Task: submit generated expense report.','Status: completed at 2026-10-10 13:00 Asia/Shanghai.','This does not mean the reimbursement has been paid.']},
  ];
  const screenshots=await Promise.all(screenInputs.map(value=>screen(value.at,value.title,value.lines)));
  const ocr=new Map(screenshots.map((value,index)=>[value.id,[screenInputs[index].title,...screenInputs[index].lines].join('\n')]));
  return {article,nextDay,product,screenshots,ocr,all:[article,nextDay,product,...screenshots]};
}
