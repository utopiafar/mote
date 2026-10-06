import type {Store} from './store.js';
export type ImageMaterialProjection={
 archiveOnly:boolean;products:{name:string;kind:string;revision:string;text?:string;evidence?:Record<string,unknown>;regions?:unknown[]}[];
 jobs:{name:string;state:'ready'|'pending'|'failed'|'unavailable';reason?:string}[];
};
/** The image product state is independent of overall file progress. A successful
 * empty OCR is ready; failed VLM never revokes retained OCR evidence. */
export function imageMaterialProjection(store:Store,id:string):ImageMaterialProjection|undefined {
 if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_inputs'").get())return;
 const input=store.db.prepare('SELECT policy_json,understanding_enabled FROM image_inputs WHERE capture_id=?').get(id);if(!input)return;
 const policy=input.policy_json?JSON.parse(String(input.policy_json)):undefined,archiveOnly=policy?.profile?.processorId==='archive';
 const products=store.db.prepare('SELECT id,name,kind,json FROM image_products WHERE capture_id=? AND current=1 ORDER BY rowid').all(id).map(row=>{
  const value=JSON.parse(String(row.json));return {name:String(row.name),kind:String(row.kind),revision:String(row.id),...(row.kind==='ocr'?{}:{text:value.payload.text,regions:value.payload.regions,evidence:value.evidence})};
 });
 const jobs=store.db.prepare('SELECT kind,state,error FROM perception_jobs WHERE capture_id=?').all(id).map(row=>({name:String(row.kind),state:products.some(p=>p.name===row.kind)?'ready' as const:row.state==='succeeded'&&row.kind==='ocr'?'ready' as const:['waiting','running'].includes(String(row.state))?'pending' as const:['failed','blocked'].includes(String(row.state))?'failed' as const:'unavailable' as const,...(row.error?{reason:String(row.error)}:{})}));
 if(!jobs.length&&!archiveOnly)jobs.push({name:'ocr',state:'pending'});
 const settings=store.db.prepare("SELECT value FROM settings WHERE key='perception'").get();
 if(input.understanding_enabled&&!archiveOnly&&!policy?.profile?.imageRecipe&&(!settings||JSON.parse(String(settings.value)).understandingEnabled!==false)&&!jobs.some(j=>j.name==='understanding'))jobs.push({name:'understanding',state:'pending'});
 return {archiveOnly,products,jobs};
}
