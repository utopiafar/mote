const path=require('node:path');
const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const root=path.resolve(__dirname,'..');
(async()=>{
 const s=await openCandidate(path.join(root,'rounds/r34/web.html'));
 try{
  const p=s.page;p.setDefaultTimeout(5000);
  await p.getByLabel('预览数据',{exact:true}).selectOption('populated');
  await p.getByRole('button',{name:'设置',exact:true}).click();
  await p.getByRole('button',{name:'帮助与诊断',exact:false}).click();
  await p.getByRole('button',{name:'诊断偏好',exact:true}).click();
  await p.getByRole('button',{name:'查看已保留轨迹',exact:true}).click();
  await p.getByRole('button',{name:'可访问目录与首次预览',exact:true}).click();
  await p.getByRole('button',{name:'首次上下文',exact:true}).click();
  await p.getByText('设备与时间范围',{exact:true}).click();
  await p.getByLabel('设备 ID（留空为全部）',{exact:true}).fill('mac');
  await p.getByLabel('开始时间（UTC）',{exact:true}).fill('2026-10-19T00:00');
  await p.getByLabel('结束时间（UTC）',{exact:true}).fill('2026-10-22T23:59');
  await p.getByRole('button',{name:'应用范围',exact:true}).click();
  await p.getByLabel('想问的问题',{exact:true}).fill('R34 独立核对：这几天有哪些来源支持研究结论？');
  await p.getByRole('button',{name:'预览首次上下文',exact:true}).click();
  await p.mouse.wheel(0,520);
  await p.getByText('预览结果 · 模型调用 0',{exact:true}).waitFor({state:'visible'});
  const dom=await saveEvidence(p,path.join(root,'rounds/r34/reports/central-independent/evidence/web-visual'),'agent-initial-preview');
  console.log(JSON.stringify({purpose:'Supplemental current viewport in a fresh isolated context with evaluation font. No reload. Resolves font-injection loss in earlier screenshots; not a new feature completeness claim.',errors:s.errors,url:dom.url,pageWidth:dom.pageWidth,viewport:dom.viewport}));
 }finally{await s.browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
