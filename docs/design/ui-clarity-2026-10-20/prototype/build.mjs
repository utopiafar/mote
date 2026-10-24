import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Script} from 'node:vm';
const root=path.dirname(fileURLToPath(import.meta.url));
const round=Number(process.argv[2]??0);
if(!Number.isInteger(round)||round<0||round>15)throw Error('Round must be 0..15');
const manifest=JSON.parse(await readFile(path.join(root,'../feature-manifest.json'),'utf8'));
let catalog={};try{catalog=JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8'));}catch{}
const routeMap={archive:'library',notes:'notes',imports:'import',ask:'ask',conversations:'ask/history',sources:'sources',connections:'access',devices:'setup/device',lark:'setup/lark',recordings:'catalog',activity:'activity',memories:'memories',insights:'insights',actions:'todos',todos:'todos',overview:'today',extensions:'settings/plugins',settings:'settings/models',about:'settings',vault:'settings/storage',usage:'settings/usage',developer:'settings/diagnostics',featureGuide:'guide'};
const directory=manifest.guide_groups.flatMap(g=>g.units.map(u=>({id:u.id,title:u.title,purpose:u.purpose,priority:u.authored_priority,section:g.section_title,group:g.title,path:u.primary_target.path,route:routeMap[u.primary_target.pageId]||'feature',source_page_id:u.primary_target.pageId,actions:[]})));
let featureRoutes={};try{featureRoutes=JSON.parse(await readFile(path.join(root,'feature-routes.json'),'utf8'));}catch{}
for(const unit of directory){const route=featureRoutes[unit.id];if(route){if(typeof route!=='object'||typeof route.route!=='string'||typeof route.path!=='string')throw Error('Invalid feature route object: '+unit.id);unit.source_path=unit.path;unit.route=route.route;unit.path=route.path;}}
const sourceCatalog=await readFile(path.join(root,'../../../../apps/web/src/feature-guide-catalog.ts'),'utf8');
const start=sourceCatalog.indexOf('= [')+2;
let depth=0,string=false,escape=false,end=start;
for(;end<sourceCatalog.length;end++){const c=sourceCatalog[end];if(string){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')string=false;}else if(c==='"')string=true;else if(c==='[')depth++;else if(c===']'&&--depth===0)break;}
const raw=JSON.parse(sourceCatalog.slice(start,end+1));
const actions=new Map(raw.flatMap(s=>s.groups.flatMap(g=>g.units.map(u=>[u.id,u.actions]))));
for(const unit of directory)unit.actions=actions.get(unit.id)||[];
const template=await readFile(path.join(root,'src/prototype.html'),'utf8');
const safe=value=>JSON.stringify(value).replace(/</g,'\\u003c');
const html=template.replace('__REVISION__',String(round)).replace('__CATALOG_JSON__',safe(catalog)).replace('__DIRECTORY_JSON__',safe(directory));
if(directory.length!==78||new Set(directory.map(u=>u.id)).size!==78)throw Error('Expected all 78 unique catalog units');
for(const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(script[1],{filename:'prototype-inline.js'});
const id='r'+String(round).padStart(2,'0');
await mkdir(path.join(root,'dist/rounds'),{recursive:true});
await writeFile(path.join(root,'dist/rounds',id+'.html'),html);
await writeFile(path.join(root,'dist/index.html'),html);
await mkdir(path.join(root,'evidence',id),{recursive:true});
await writeFile(path.join(root,'evidence',id,'candidate.json'),JSON.stringify({round,id,path:'dist/rounds/'+id+'.html',sha256:createHash('sha256').update(html).digest('hex'),sourceRevision:'2c78ca8d52a7d17fae20962cf68d09a717ffc73a',scope:'self-contained HTML UI prototype with mock state',bytes:Buffer.byteLength(html)},null,2)+'\n');
console.log(JSON.stringify({round,path:'dist/rounds/'+id+'.html',bytes:Buffer.byteLength(html),directory:directory.length}));
