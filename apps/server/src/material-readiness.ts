import type {MaterialRecord} from './materials.js';

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
