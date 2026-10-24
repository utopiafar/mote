const fs=require('node:fs/promises');
const path=require('node:path');
const {observe}=require('./browser-session.cjs');
async function saveEvidence(page,directory,name){
  await fs.mkdir(directory,{recursive:true});
  const dom=await observe(page);
  await page.screenshot({path:path.join(directory,name+'.png'),fullPage:false});
  await fs.writeFile(path.join(directory,name+'.json'),JSON.stringify({...dom,screenshot_scope:'Current viewport; DOM observed before screenshot to avoid resize-related disclosure changes'},null,2)+'\n');
  return dom;
}
module.exports={saveEvidence};
