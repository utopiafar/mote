import type {CaptureInput} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import type {ModelSettings} from '@mote/shared/models';
import type {ModelAgentIdentity} from './model-agent.js';
import {formatMaterialRef,type MaterialStore} from './materials.js';
import type {FileStore} from './files.js';
import type {Store} from './store.js';
import {BackgroundModelAuthorization,modelConnection,type AutomaticModelPurpose,type ModelConnection,type ModelDisclosure} from './background-model-authorization.js';

export const captureModelIdentity=(id:string)=>'capture:'+id;
export const sourceModelIdentity=(sourceId:string,inputKey:string)=>'source:'+JSON.stringify([sourceId,inputKey]);
export const conversationModelIdentity=(id:string)=>'conversation-turn:'+id;
export const agentModelConnection=(identity:ModelAgentIdentity,settings:ModelSettings)=>modelConnection(`${identity.kind}:${identity.id}:${settings.model}`,settings);

/** Only the host's typed objects and durable lineage are inspected here.
 * Source text, dates, lane names and arbitrary operation-id prefixes never
 * create a foreground request or original intake permission. */
export class ModelAuthorizationHost {
  constructor(readonly control:BackgroundModelAuthorization,private readonly store:Store,private readonly materials:MaterialStore,private readonly files?:FileStore){}
  capture(input:CaptureInput){this.control.receive(captureModelIdentity(input.id),{sourceId:input.provenance?.sourceId??'device:'+input.deviceId,dataKind:input.imageBase64?'image':'text'});}
  source(input:{sourceId:string;inputKey:string;captureId?:string},automatic:boolean){const identity=sourceModelIdentity(input.sourceId,input.inputKey);if(input.captureId)this.control.derive(identity,[captureModelIdentity(input.captureId)]);else this.control.receive(identity,{sourceId:input.sourceId,dataKind:'text'},automatic);}
  conversation(turnId:string){this.control.receive(conversationModelIdentity(turnId),{sourceId:'mote.conversations',dataKind:'conversation'});}
  /** Resolve original trigger candidates without changing or backfilling data.
   * A historical artifact with no original receipt remains reference-only. */
  evidenceTriggers(ids:readonly string[],seen=new Set<string>()):string[]{
    const result=new Set<string>();
    for(const id of ids){
      if(seen.has(id))continue;seen.add(id);
      const capture=captureModelIdentity(id);if(this.control.roots(capture).length){result.add(capture);continue;}
      const chunk=this.store.db.prepare('SELECT capture_id FROM file_chunks WHERE id=?').get(id);if(chunk){for(const root of this.evidenceTriggers([String(chunk.capture_id)],seen))result.add(root);continue;}
      const anchor=this.store.db.prepare('SELECT material_id,revision FROM material_evidence WHERE id=?').get(id);
      const material=anchor?this.materials.get(formatMaterialRef(String(anchor.material_id),String(anchor.revision))):/^(?:mat_|material:)/.test(id)?this.materials.get(id):undefined;
      if(material){
        for(const row of this.store.db.prepare('SELECT input_key FROM material_memory_requests WHERE material_id=? AND revision=?').all(material.id,material.revision))result.add(sourceModelIdentity(material.origin.sourceId,String(row.input_key)));
        continue;
      }
      const artifact=this.store.archive.get(id);
      if(artifact){
        for(const root of this.evidenceTriggers(artifact.members,seen))result.add(root);
        for(const input of artifact.materialInputs??[])for(const root of this.evidenceTriggers([input.ref],seen))result.add(root);
      }
    }
    return [...result];
  }
  queryTriggers(input:QueryInput):string[]{
    const roots=this.evidenceTriggers([...(input.evidenceIds??[]),...(input.directImages?.map(image=>image.id)??[])]);
    for(const material of input.processingMaterialInputs??[])roots.push(...this.evidenceTriggers([material.materialId]));
    const task=input.taskContext as {turns?:{turnId?:string}[];memoryWork?:{catalog?:{sourceId:string;inputKey:string}[]}}|undefined;
    for(const turn of task?.turns??[])if(turn.turnId)roots.push(conversationModelIdentity(turn.turnId));
    for(const member of task?.memoryWork?.catalog??[])roots.push(sourceModelIdentity(member.sourceId,member.inputKey));
    return [...new Set(roots)];
  }
  async automatic<T>(id:string,purpose:AutomaticModelPurpose,candidates:readonly string[]|(()=>readonly string[]),task:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    // Dependent work uses the exact accepted parent's authority. A new model
    // fragment is never permission to re-admit its complete input history.
    if(this.control.currentId)return this.control.run(this.control.currentId,task,signal);
    // Resolve original metadata only for first admission, never for a resumed
    // or dependent fragment whose durable roots already exist.
    const roots=this.control.automaticTriggers(id,purpose)??this.control.freshTriggers(typeof candidates==='function'?candidates():candidates,purpose);
    this.control.automatic(id,roots,purpose);
    return this.control.run(id,task,signal);
  }
  disclosure(ids:readonly string[]):ModelDisclosure[]{
    const records=[...this.store.evidence([...ids]),...this.materials.evidence([...ids]),...(this.files?.evidence([...ids])??[])];
    return records.map(record=>({sourceId:record.provenance?.sourceId??'device:'+record.deviceId,dataKind:'text'}));
  }
  assertEvidence(ids:readonly string[],kind:'text'|'image'='text'){this.control.assertDisclosure(this.disclosure(ids).map(value=>({...value,dataKind:kind})));}
  async manual<T>(id:string,connections:ModelConnection[],task:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,kind:'manual'|'probe'='manual',identities:readonly string[]=[]){
    this.control.manual(id,kind,identities,connections);return this.control.run(id,task,signal);
  }
}
