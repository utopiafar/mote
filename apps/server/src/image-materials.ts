import type {Store} from './store.js';
export type ImageMaterialProjection={
 original?:{captureId:string;sha256:string};
 archiveOnly:boolean;products:{name:string;kind:string;revision:string;text?:string;evidence?:Record<string,unknown>;regions?:unknown[]}[];
 jobs:{name:string;kind?:string;state:'ready'|'pending'|'failed'|'unavailable';reason?:string}[];
};
/** The image product state is independent of overall file progress. A successful
 * empty OCR is ready; failed VLM never revokes retained OCR evidence. */
export function imageMaterialProjection(store:Store,id:string):ImageMaterialProjection|undefined {
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_inputs'").get())return;
 const input=store.db.prepare('SELECT policy_json,understanding_enabled,hash FROM image_inputs WHERE capture_id=?').get(id);if(!input)return;
 const policy=input.policy_json?JSON.parse(String(input.policy_json)):undefined,archiveOnly=policy?.profile?.processorId==='archive';
 const products=store.db.prepare('SELECT id,name,kind,json FROM image_products WHERE capture_id=? AND current=1 ORDER BY rowid').all(id).map(row=>{
  const value=JSON.parse(String(row.json));return {name:String(row.name),kind:String(row.kind),revision:String(row.id),...(row.kind==='ocr'?{}:{text:value.payload.text,regions:value.payload.regions,evidence:value.evidence})};
 });
 // Step names are owner/plugin-defined. Active execution membership pins the
 // stage kind even when it failed before it could publish a product.
 const stages=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='execution_steps'").get()?store.db.prepare("SELECT m.slot AS name,substr(s.kind,8) AS kind FROM execution_operation_steps m JOIN execution_steps s ON s.id=m.step_id WHERE m.operation_id=? AND m.active=1 AND s.kind LIKE 'images.%'").all('image:'+id):[];
 const kinds=new Map(stages.map(row=>[String(row.name),String(row.kind)]));
 const jobs=store.db.prepare('SELECT kind,state,error FROM perception_jobs WHERE capture_id=?').all(id).map(row=>({name:String(row.kind),kind:products.find(p=>p.name===row.kind)?.kind??kinds.get(String(row.kind)),state:products.some(p=>p.name===row.kind)?'ready' as const:row.state==='succeeded'&&kinds.get(String(row.kind))==='ocr'?'ready' as const:['waiting','running'].includes(String(row.state))?'pending' as const:['failed','blocked'].includes(String(row.state))?'failed' as const:'unavailable' as const,...(row.error?{reason:String(row.error)}:{})}));
 if(!jobs.length&&!archiveOnly)jobs.push({name:'ocr',kind:'ocr',state:'pending'});
 const settings=store.db.prepare("SELECT value FROM settings WHERE key='perception-effective'").get();
 if(input.understanding_enabled&&!archiveOnly&&!policy?.profile?.imageRecipe&&(!settings||JSON.parse(String(settings.value)).understandingEnabled!==false)&&!jobs.some(j=>j.name==='understanding'))jobs.push({name:'understanding',kind:'understanding',state:'pending'});
 return {archiveOnly,...(input.hash?{original:{captureId:id,sha256:String(input.hash)}}:{}),products,jobs};
}
