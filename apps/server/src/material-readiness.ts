import type {MaterialRecord} from './materials.js';
import {z} from 'zod';

export const materialRequirementsSchema=z.array(z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/)).min(1).max(64).refine(v=>new Set(v).size===v.length,'Duplicate material dependency');
export type MaterialInputPin={materialId:string;required:string[];fingerprint:string;evidenceIds:string[]};

export type MaterialDependencyStatus={key:string;state:'ready'|'pending'|'failed'|'unavailable';reason?:string};

/** A consumer pins a material revision and names the outputs it needs. The
 * special `material` key preserves the conservative default for older packs. */
export function materialDependencyStatus(material:Pick<MaterialRecord,'coverage'|'artifacts'>,required:readonly string[]):{ready:boolean;dependencies:MaterialDependencyStatus[]}{
  const dependencies=required.map(key=>{
    if(key==='material')return {key,state:material.coverage.state==='complete'?'ready':material.coverage.state==='pending'?'pending':'unavailable',reason:material.coverage.reason} as MaterialDependencyStatus;
    const artifact=material.artifacts?.find(candidate=>candidate.key===key);
    return artifact?{key,state:artifact.state,...(artifact.reason?{reason:artifact.reason}:{})}:{key,state:'unavailable'} as MaterialDependencyStatus;
  });
  return {ready:dependencies.every(dependency=>dependency.state==='ready'),dependencies};
}
