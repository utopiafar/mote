import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {buildApp} from '../../src/app.js';

export function generatedUtilityOracle(){
 const nonce=()=>randomBytes(12).toString('hex'),project='Generated Cedar '+nonce(),priorGate='gate_'+nonce(),releaseGate='gate_'+nonce(),artifactTag='tag_'+nonce();
 const old=`Generated owner decision for ${project}: My approval gate for publishing this project record is ${priorGate}. Each published artifact must carry the exact tag ${artifactTag}. These are scoped owner decisions, not general advice.`;
 const correction=`Generated owner correction for ${project}: Replace my earlier approval gate ${priorGate} with ${releaseGate}. The earlier gate is explicitly retired. Keep my artifact tag ${artifactTag}; that requirement has not changed. This is my current publishing preference for this project only.`;
 return {project,priorGate,releaseGate,artifactTag,old,correction};
}
/** Seed state is explicit generated owner evidence plus owner-published event
 * cards. It is not claimed as model extraction or independent model review. */
export async function seedUtilityOracle(node:Awaited<ReturnType<typeof buildApp>>,token:string,oracle=generatedUtilityOracle()){
 const originals=[oracle.old,oracle.correction],ids=[randomUUID(),randomUUID()],cards=[];
 for(let index=0;index<originals.length;index++){
  const response=await node.app.inject({method:'POST',url:'/api/notes',headers:{authorization:'Bearer '+token},payload:{id:ids[index],deviceId:'generated-utility',deviceName:'Generated utility fixture',platform:'import',capturedAt:`2026-09-${index?'21':'20'}T00:00:00Z`,text:originals[index]}});
  assert.equal(response.statusCode,201,response.body);
  const original=node.memories.readEvidence([ids[index]])[0];assert.ok(original);
  const seed={domain:'personal',title:index?'Generated correction event':'Generated prior decision event',statement:`${index?`Owner changed the scoped gate to ${oracle.releaseGate}`:`Owner selected scoped gate ${oracle.priorGate}`} for ${oracle.project} [${ids[index]}]`,uncertainty:'Generated event card; no relationship has yet been reviewed.',admission:{layer:'memory',reason:'Recall the owner\'s scoped publishing preference',scope:oracle.project,attribution:'user'},evidenceIds:[ids[index]],evidence:[{id:ids[index],quote:originals[index]}]};
  const card=node.memories.extract({answer:JSON.stringify({memories:[seed]}),citations:[{id:original.id,capturedAt:original.capturedAt,appName:original.appName,excerpt:originals[index]}],trace:[],runId:'generated-owner-seed-'+index},'generated-owner-seed',{requireAdmission:true}).items[0];
  const published=await node.app.inject({method:'POST',url:'/api/memories/'+card.id+'/publish',headers:{authorization:'Bearer '+token},payload:{version:card.version}});assert.equal(published.statusCode,200,published.body);cards.push(node.memories.get(card.id));
 }
 return {oracle,ids,cards};
}
