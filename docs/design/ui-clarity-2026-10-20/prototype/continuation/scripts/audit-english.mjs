import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createOfflineDom,settle,visibility} from '../../capture-dom.mjs';
const input=process.argv[2]||new URL('../work/interface-states.html',import.meta.url).pathname;
const output=process.argv[3]||new URL('../reports/english-inventory.json',import.meta.url).pathname;
const source=await readFile(input,'utf8');
const directory=JSON.parse(source.match(/^const DIRECTORY = (.*);$/m)[1]);
const routes=[...new Set(['settings/appearance','guide',...directory.map(x=>x.route),'settings','library','library/sources','library/files','today','sources','setup/screen','setup/folder','notes','memories','insights','ask','ask/history','imports','settings/help','settings/diagnostics'])];
const all=new Map(),pages=[];const cjk=/[\u3400-\u9fff]/;
function collect(document,route,mode){
 const visible=visibility(document),records=[];const root=document.querySelector('#prototype');
 const walker=document.createTreeWalker(root,document.defaultView.NodeFilter.SHOW_TEXT);let node;
 while(node=walker.nextNode()){
  const el=node.parentElement;if(el.closest('script,style,textarea,pre,.reading-body,.message.user,[data-user-content]'))continue;
  const text=node.textContent.trim();if(!cjk.test(text))continue;
  const record={text,tag:el.tagName.toLowerCase(),id:el.id||null,class:el.className||null,action:el.closest('[data-action]')?.dataset.action||null,visible:visible(el),route,mode};
  records.push(record);if(!all.has(text))all.set(text,record);
 }
 for(const el of root.querySelectorAll('[aria-label],[placeholder],[title]'))for(const attr of ['aria-label','placeholder','title']){
  const text=el.getAttribute(attr);if(!text||!cjk.test(text))continue;
  const record={text,attr,tag:el.tagName.toLowerCase(),id:el.id||null,route,mode};records.push(record);if(!all.has(text))all.set(text,record);
 }
 pages.push({route,mode,cjk:records.length});
}
for(const mode of ['populated','empty']){
 const errors=[],dom=createOfflineDom(source,'https://mote-prototype.invalid/?state='+mode+'#/settings/appearance',errors);await settle(dom.window);
 const document=dom.window.document;const select=document.querySelector('#language-choice');if(!select)throw Error('No language control');select.value='en';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));await settle(dom.window);
 for(const route of routes){dom.window.location.hash='#/'+route;await settle(dom.window);await settle(dom.window);collect(document,route,mode);}
 dom.window.close();if(errors.length)throw Error(errors.join('; '));
}
const report={input,sha256:createHash('sha256').update(source).digest('hex'),routes:routes.length,featureIds:directory.length,pages,unique:[...all.values()]};await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,routeCount:routes.length,featureIds:directory.length,uniqueCjk:all.size}));
