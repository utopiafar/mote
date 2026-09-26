import type {CodingEvidence} from '@mote/shared';
import {sha256} from './store.js';

type Project = {provider:string} & Pick<CodingEvidence,'projectKey'|'sessionId'|'projectName'|'projectIdentity'|'cwd'|'repositoryKey'|'branch'>;

/** Transport metadata only. Never infer a repository from transcript words or directory labels. */
export function codingProjectIdentity(value:Project):'workspace'|'session'|'unknown' {
  if(value.projectIdentity)return value.projectIdentity;
  if(value.projectKey===sha256(`${value.provider}:${value.sessionId}`))return 'session';
  return value.cwd||value.repositoryKey?'workspace':'unknown';
}

/** Conflicting metadata cannot silently choose one workspace. Missing fields may be filled by later events. */
export function codingProjectContext(values:Project[]) {
  const fields = ['projectName','cwd','repositoryKey','branch'] as const;
  const result:Partial<Pick<Project,typeof fields[number]>>={};
  let conflict=false;
  for(const field of fields){
    const candidates=[...new Set(values.map(value=>value[field]).filter((value):value is string=>!!value))];
    if(candidates.length===1)result[field]=candidates[0];
    else if(candidates.length>1&&(field==='cwd'||field==='repositoryKey'))conflict=true;
  }
  const identities=new Set(values.map(codingProjectIdentity));
  const projectIdentity=conflict||identities.has('session')&&identities.has('workspace')?'unknown':
    identities.has('workspace')?'workspace':identities.has('session')?'session':'unknown';
  return {...result,projectIdentity} as const;
}
