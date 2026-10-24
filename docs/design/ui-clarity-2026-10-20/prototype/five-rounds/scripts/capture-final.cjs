/* User-facing viewport previews of the frozen R34 files. No application state access. */
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {openCandidate,observe}=require('./browser-session.cjs');
(async()=>{
 const root=path.resolve(__dirname,'..'),out=path.join(root,'previews/r34');await fs.mkdir(out,{recursive:true});
 const manifest={scope:'Viewport previews from frozen R34 using rendered controls; no backend/native execution',artifacts:[]};
 for(const platform of ['web','mac','android']){
  const file=path.join(root,'rounds/r34',platform+'.html'),html=await fs.readFile(file),hash=crypto.createHash('sha256').update(html).digest('hex');
  const session=await openCandidate(file,{viewport:platform==='android'?{width:390,height:844}:{width:1440,height:1000},url:'https://mote-prototype.invalid/?reset=1&state=empty#/library'}),p=session.page;
  async function snap(scene){await p.evaluate(()=>document.fonts.ready);await p.evaluate(()=>window.scrollTo(0,0));const dom=await observe(p),name=platform+'-'+scene;await fs.writeFile(path.join(out,name+'.json'),JSON.stringify(dom,null,2));await p.screenshot({path:path.join(out,name+'.png')});manifest.artifacts.push({platform,scene,file:name+'.png',candidateSha256:hash,viewport:dom.viewport});if(dom.pageWidth>dom.viewport.width+2)throw Error('Overflow: '+name);}
  try{
   await snap('first-use');
   await p.locator('main [data-page="import"]').first().click();await snap('import-context');
   await p.locator('#preview-state').selectOption('populated');await snap('library');
   await p.locator('.sidebar [data-page="sources"],.bottom-nav [data-page="sources"]').filter({visible:true}).first().click();await snap('sources');
   if(session.errors.length)throw Error(session.errors.join(';'));
  }finally{await session.browser.close();}
 }
 await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');console.log(JSON.stringify({previews:manifest.artifacts.length,path:out}));
})().catch(e=>{console.error(e);process.exit(1)});
