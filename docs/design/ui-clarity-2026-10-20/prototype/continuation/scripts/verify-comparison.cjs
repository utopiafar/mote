const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createHash}=require('node:crypto');
const {chromium}=require('playwright');
const {executablePath}=require('./browser-session.cjs');
const root=path.resolve(__dirname,'..');
const viewerDir=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'dist');
const outputs=process.argv[3]?path.resolve(process.argv[3]):path.join(root,'reports');
const identityOnly=process.argv.includes('--identity-only');
(async()=>{
 await fs.mkdir(outputs,{recursive:true});
 const viewerSource=await fs.readFile(path.join(viewerDir,'mote-ui-review.html'),'utf8');
 const payload=viewerSource.match(/<script id="candidate-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
 if(!payload)throw Error('Candidate metadata is missing');
 const candidates=JSON.parse(payload),ids=candidates.map(candidate=>candidate.id),current=candidates.find(candidate=>candidate.recommended)||candidates[1];
 const candidatePaths=candidates.map(candidate=>path.resolve(viewerDir,candidate.path));
 const hashes=await Promise.all(candidatePaths.map(async filename=>createHash('sha256').update(await fs.readFile(filename)).digest('hex')));
 const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
 const font=await fs.readFile('/tmp/mote-ui-noto-sc.otf');
 const fontRoute=route=>route.fulfill({contentType:'font/otf',headers:{'access-control-allow-origin':'*'},body:font});
 const context=await browser.newContext({viewport:{width:1680,height:1100}}),page=await context.newPage(),errors=[],records=[];
 page.on('pageerror',error=>errors.push(error.message));
 const assert=(name,passed,actual)=>{records.push({name,passed,...(actual===undefined?{}:{actual})});if(!passed)throw Error(name);};
 const waitReady=async()=>{await page.waitForFunction(()=>document.getElementById('status')?.textContent==='两份原型已载入，可分别操作。');};
 const addTestFont=async()=>{for(const frame of page.frames()){await frame.addStyleTag({content:'@font-face{font-family:MoteReviewTest;src:url("https://mote-review-font.invalid/noto.otf")}body,button,input,select,textarea{font-family:MoteReviewTest,sans-serif!important}'});await frame.evaluate(()=>document.fonts.ready);}};
 const frames=()=>ids.map(id=>page.frameLocator('#frame-'+id));
 const snapshot=async()=>Promise.all(frames().map(frame=>frame.locator('body').evaluate(body=>({hash:location.hash,title:document.querySelector('main h1')?.textContent,width:innerWidth,classes:body.className,data:document.getElementById('preview-state')?.value,theme:document.getElementById('preview-theme')?.value,prefix:window.__MOTE_REVIEW_STORAGE_PREFIX}))));
 try{
  assert('Embedded originals match frozen input hashes',candidates.every((candidate,index)=>candidate.sha256===hashes[index]&&createHash('sha256').update(candidate.html).digest('hex')===hashes[index]),candidates.map(candidate=>({id:candidate.id,sha256:candidate.sha256})));
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='mote-review-font.invalid')return fontRoute(route);if(url.protocol==='file:')return route.continue();return route.abort();});
  await page.goto(pathToFileURL(path.join(viewerDir,'mote-ui-review.html')).href);await waitReady();
  let states=await snapshot();assert('Offline file opens two interactive library frames',states.every(state=>state.hash==='#/library'&&state.title&&state.width===1440),states);
  const panelLabels=await Promise.all(candidates.map(candidate=>page.locator('#title-'+candidate.id).textContent()));
  assert('Panel labels and current recommendation match frozen metadata',panelLabels.every((label,index)=>label.startsWith(candidates[index].label))&&await page.locator('.panel.recommended').getAttribute('data-version')===current.id&&await page.locator('.panel.recommended .version-badge').textContent()==='建议先看',{labels:panelLabels,recommended:current.id});
  await addTestFont();await page.screenshot({path:path.join(outputs,'comparison-desktop.png'),fullPage:true});
  if(!identityOnly){
  for(const scene of ['sources','setup/screen','notes','memories']){await page.selectOption('#scene',scene);await waitReady();states=await snapshot();assert('Both frames enter '+scene,states.every(state=>state.hash==='#/'+scene&&state.title),states);}
  await page.selectOption('#layout','phone');await page.selectOption('#data-state','empty');await page.selectOption('#theme','dark');await page.selectOption('#scene','notes');await waitReady();
  states=await snapshot();assert('Phone mode uses 390px, empty data and dark theme in both frames',states.every(state=>state.width===390&&state.classes.includes('mobile')&&state.classes.includes('dark')&&state.data==='empty'&&state.theme==='dark'),states);
  assert('Frames have separate explicit storage prefixes',states[0].prefix!==states[1].prefix&&states.every((state,index)=>state.prefix.startsWith('mote-review:'+ids[index]+':')),states.map(state=>state.prefix));
  await frames()[0].locator('body').evaluate(()=>sessionStorage.setItem('comparison-check','left-only'));
  const rightValue=await frames()[1].locator('body').evaluate(()=>sessionStorage.getItem('comparison-check'));
  assert('Left frame storage is absent from right frame',rightValue===null,rightValue);
  await frames()[0].locator('#note-text').fill('左侧独立草稿');assert('Typing in one frame leaves the other draft unchanged',await frames()[1].locator('#note-text').inputValue()==='');
  await addTestFont();await page.locator('#frame-'+current.id).scrollIntoViewIfNeeded();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.locator('#frame-'+current.id).screenshot({path:path.join(outputs,'comparison-phone-'+current.id+'.png')});await page.screenshot({path:path.join(outputs,'comparison-phone-dark.png'),fullPage:true});
  }
  await page.unroute('**/*');
  const servedViewer='https://mote-review.invalid/continuation/dist/review.html';
  const servedFiles=new Map([[servedViewer,path.join(viewerDir,'review.html')],...candidates.map((candidate,index)=>[new URL(candidate.path,servedViewer).href,candidatePaths[index]])]);
  await page.route('**/*',async route=>{const filename=servedFiles.get(route.request().url());if(!filename)return route.abort();try{return await route.fulfill({contentType:'text/html; charset=utf-8',body:await fs.readFile(filename)});}catch{return route.fulfill({status:404,body:'Missing local file'});}});
  await page.goto(servedViewer);await waitReady();states=await snapshot();assert('Repository page resolves relative candidates',states.every(state=>state.hash==='#/library'&&state.title&&state.width===1440),states);
  await page.unroute('**/*');await page.route('**/*',route=>new URL(route.request().url()).protocol==='file:'?route.continue():route.abort());
  await page.goto(pathToFileURL(path.join(viewerDir,'review.html')).href);await waitReady();assert('Double-clicking the lightweight page opens offline companion',page.url().endsWith('/mote-ui-review.html'));
  const after=await Promise.all(candidatePaths.map(async filename=>createHash('sha256').update(await fs.readFile(filename)).digest('hex')));assert('Frozen input candidates remain byte-identical',JSON.stringify(hashes)===JSON.stringify(after),after);assert('No browser page errors',errors.length===0,errors);
 }catch(error){records.push({name:'Smoke check completed',passed:false,error:error.message});}
 finally{await browser.close();}
 const report={scope:identityOnly?'Viewer version labels, embedded hashes, dual frames and local entry points only; no business journeys or repeated settings checks':'Review tool rendering, scene selection and frame isolation only; no product journeys',browser:'Chromium headless',viewer_sha256:createHash('sha256').update(viewerSource).digest('hex'),candidates:candidates.map((candidate,index)=>({id:candidate.id,label:candidate.label,sha256:hashes[index],recommended:candidate.recommended})),records,errors,status:records.every(record=>record.passed)?'passed':'failed'};
 await fs.writeFile(path.join(outputs,'comparison-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:records.length,failed:records.filter(record=>!record.passed)}));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
