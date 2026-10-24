'use strict';
// Run once against the frozen final round, after independent evaluation.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {openCandidate, observe, saveEvidence} = require('../../continuation/scripts/browser-session.cjs');

const root = path.resolve(__dirname, '..');
const finalRound = path.join(root, 'rounds/r29');
const sourceManifest = path.resolve(root, '../../feature-manifest.json');
const requestedOutput = process.argv[2] ? path.resolve(process.argv[2]) : path.join(finalRound, 'author', 'feature-reachability-' + new Date().toISOString().replace(/[:.]/g, '-'));
const surfaces = [{id:'web',viewport:{width:1440,height:1000}}, {id:'mac',viewport:{width:1280,height:900}}, {id:'android',viewport:{width:390,height:844}}];
const selectedScreens = new Set(['C01','C12','C35','A12','A26','A36']);
const scope = 'Author verification of 78 directory entries and visible destinations on each HTML surface. Records actual visible DOM and selected screenshots.';

async function main() {
  const manifest = JSON.parse(await fs.readFile(sourceManifest, 'utf8'));
  const units = manifest.guide_groups.flatMap(g => g.units.map(u => ({...u, group:g.title})));
  assert.equal(units.length, 78);
  assert.equal(new Set(units.map(u => u.id)).size, 78);
  const freeze = JSON.parse(await fs.readFile(path.join(finalRound, 'manifest.json'), 'utf8'));
  const independent = JSON.parse(await fs.readFile(path.join(finalRound, 'reports/independent-evaluation.json'), 'utf8'));
  await fs.mkdir(requestedOutput, {recursive:true});
  const summaries = [];
  for (const surface of surfaces) {
    const input = path.join(finalRound, surface.id+'.html');
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(input)).digest('hex');
    assert.equal(sha256, freeze.candidates[surface.id].sha256, 'Frozen candidate identity');
    const assessed = independent.candidate_sha256?.[surface.id] || independent.platforms?.[surface.id]?.candidate_sha256;
    assert.equal(assessed, sha256, 'Final evaluation identity');
    const directory = path.join(requestedOutput, surface.id);
    await fs.mkdir(directory,{recursive:true});
    const session = await openCandidate(input,{url:'https://mote-prototype.invalid/?reset=1&state=populated#/guide',viewport:surface.viewport});
    const results=[];
    try {
      for (const unit of units) {
        const result={id:unit.id,title:unit.title,purpose:unit.purpose,priority:unit.authored_priority,group:unit.group,condition:unit.condition,scope};
        try {
          await session.page.goto('https://mote-prototype.invalid/?reset=1&state=populated#/guide');
          await session.page.addStyleTag({content:'@font-face{font-family:MoteEvaluationCJK;src:url("https://mote-prototype.invalid/fonts/noto.otf")}body{font-family:MoteEvaluationCJK,sans-serif!important}button,input,select,textarea{font-family:inherit!important}'});
          await session.page.evaluate(()=>document.fonts.ready);
          const control=session.page.locator('button[data-action="open-feature"][data-id="'+unit.id+'"]');
          await control.waitFor({state:'attached'});
          const ancestors=await control.locator('xpath=ancestor::details').all();
          for (const ancestor of ancestors.reverse()) {
            if(await ancestor.getAttribute('open')===null) await ancestor.locator(':scope > summary').click();
          }
          result.entry=await session.page.locator('[data-feature-id="'+unit.id+'"]').innerText();
          result.entry_action=await control.innerText();
          await control.click();
          result.destination=await observe(session.page);
          result.main=await session.page.locator('main').innerText();
          result.reachable=result.destination.url.split('#')[1]!=='/guide' && result.main.trim().length>0;
          assert.ok(result.reachable,'No visible destination observed');
          if(selectedScreens.has(unit.id)) {
            await saveEvidence(session.page,directory,'destination-'+unit.id);
            await session.page.screenshot({path:path.join(directory,'destination-'+unit.id+'-viewport.png'),fullPage:false});
            result.screenshot='destination-'+unit.id+'-viewport.png';
          }
        } catch(error) {
          result.reachable=false;
          result.error=error.message;
          await session.page.screenshot({path:path.join(directory,'failure-'+unit.id+'.png'),fullPage:false}).catch(()=>{});
        }
        results.push(result);
        if(results.length%20===0)console.log(JSON.stringify({surface:surface.id,completed:results.length,total:78}));
      }
    } finally {
      await session.browser.close();
    }
    const report={round:29,surface:surface.id,candidate:input,candidate_sha256:sha256,created_at:new Date().toISOString(),viewport:surface.viewport,executor:'isolated Chrome visible UI',scope,total:78,reachable:results.filter(r=>r.reachable).length,errors:session.errors,units:results};
    await fs.writeFile(path.join(directory,'feature-reachability.json'),JSON.stringify(report,null,2)+'\n');
    summaries.push({surface:surface.id,candidate_sha256:sha256,total:78,reachable:report.reachable,browser_errors:report.errors,report:surface.id+'/feature-reachability.json'});
    console.log(JSON.stringify(summaries[summaries.length-1]));
  }
  const index={round:29,created_at:new Date().toISOString(),scope,platforms:summaries,total:234,reachable:summaries.reduce((sum,s)=>sum+s.reachable,0)};
  await fs.writeFile(path.join(requestedOutput,'index.json'),JSON.stringify(index,null,2)+'\n');
  console.log(JSON.stringify({output:requestedOutput,reachable:index.reachable,total:index.total}));
  if(index.reachable!==234 || summaries.some(s=>s.browser_errors.length))process.exitCode=1;
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
