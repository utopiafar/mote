const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const [file,dir,platform]=process.argv.slice(2);
(async()=>{const s=await openCandidate(file,{viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});try{await s.page.locator('#preview-state').selectOption('populated');for(const [id,label]of[['library','资料库'],['ask','问一问'],['sources','来源'],['activity','活动']]){await s.page.getByRole('button',{name:label,exact:true}).first().click();await saveEvidence(s.page,dir,id);}console.log(JSON.stringify({platform,observed:['library','ask','sources','activity'],browserErrors:s.errors}));}finally{await s.browser.close();}})();
