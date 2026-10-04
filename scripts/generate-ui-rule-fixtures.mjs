import {readFileSync,writeFileSync} from 'node:fs';
const root=new URL('../',import.meta.url),rules=JSON.parse(readFileSync(new URL('adapters/ui/builtin.json',root))),existing=JSON.parse(readFileSync(new URL('adapters/ui/fixtures/conformance.json',root)));
const cases=[];
for(const rule of rules){
 const seed=existing.find(f=>f.name===rule.id);if(!seed)throw Error(`Missing authored generated snapshot for ${rule.id}`);
 const add=(suffix,mutate,expected)=>{const snapshot=structuredClone(seed.snapshot);mutate(snapshot);cases.push({name:`builtin-${rule.id}-${suffix}`,platform:rule.platform,rules:[rule],snapshot,expected});};
 add('visible',()=>{},seed.expected);
 add('wrong-app',s=>{s.appId='dev.mote.generated.other';},null);
 if(rule.activity)add('wrong-page',s=>{s.activity='dev.mote.GeneratedOtherPage';},null);
 add('missing-structure',s=>{s.nodes=[];},null);
 add('empty-content',s=>{for(const n of s.nodes)n.text='';},null);
 add('truncated',s=>{s.truncated=true;},{...seed.expected,status:'partial'});
 add('unrelated-node',s=>{s.nodes.push({id:'generated-noise',role:rule.platform==='android'?'android.widget.Button':'AXButton',resourceId:'generated-noise',text:'Generated unrelated navigation',bounds:{x:0,y:0,width:10,height:10}});},seed.expected);
 if(rule.ancestor)add('outside-content-container',s=>{for(const n of s.nodes)delete n.parentId;},null);
}
const result=JSON.stringify(cases,null,2)+'\n',path=new URL('adapters/ui/fixtures/builtin-coverage.json',root);
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==result)throw Error('UI fixture matrix is stale; run node scripts/generate-ui-rule-fixtures.mjs');}else writeFileSync(path,result);
