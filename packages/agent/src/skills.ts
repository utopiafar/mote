import {readFileSync} from 'node:fs';
import {TASK_DESCRIPTOR_API_VERSION, type TaskResponseMode} from './tasks/descriptor.js';
import {defaultTaskRegistry} from './tasks/registry.js';

export const SKILL_VERSION = '1.0.3';
const catalog = [
  {id:'calendar-extraction',name:'calendar-extraction',version:SKILL_VERSION,responseMode:'calendar-extraction',description:'Propose personal calendar events from original evidence for host validation and owner-scoped execution, distinguishing missing schedule values from semantic uncertainty and preserving provenance.'},
  {id:'personal-insight',name:'personal-insight',version:'1.0.5',responseMode:'personal-insight',description:'Review personal context and distinguish evidence from inference, using the host-selected answer or insight-report format.'},
  {id:'coding-memory',name:'coding-memory',version:'6.2.0',responseMode:'memory-extraction',description:'Read agent conversations with speaker and project context; distinguish personal memories, coding experiences and task breadcrumbs.'},
  {id:'memory-strategy',name:'memory-strategy',version:'1.0.0',responseMode:'memory-extraction',description:'Execute a host-selected bounded Memory extraction or review policy with shared evidence guarantees.'},
  {id:'memory-integration',name:'memory-integration',version:'1.0.0',responseMode:'memory-extraction',description:'Execute a host-selected Memory integration or review policy using read-only cards and original evidence.'},
  {id:'memory-extraction',name:'memory-extraction',version:'3.4.0',responseMode:'memory-extraction',description:'Propose durable memories from an explicit batch of original evidence, preserving attribution and provenance.'},
  {id:'memory-consolidation',name:'memory-consolidation',version:'3.4.0',description:'Consolidate episodic text memories into supported semantic or procedural proposals; revisit originals and preserve conflicting and historical evidence.'},
  {id:'working-memory',name:'working-memory',version:'1.0.0',description:'Compact conversation context into a bounded textual working memory, preserving decisions, open questions and attribution.'},
  {id:'document-import',name:'document-import',version:'1.0.6',description:'Inspect user-selected files and write a generic records manifest for a reviewable import.'},
] as const satisfies readonly {id:string;name:string;description:string;version:string;responseMode?:TaskResponseMode}[];
export type MoteSkillId = typeof catalog[number]['id'];
const bundled = catalog.map(skill=>({...skill,content:readFileSync(new URL(`../skills/${skill.id}/SKILL.md`,import.meta.url),'utf8')}));
defaultTaskRegistry.register({skills:bundled.map(skill=>({...skill,apiVersion:TASK_DESCRIPTOR_API_VERSION}))});
export const bundledSkills = bundled.map(skill=>({id:skill.id,name:skill.name,description:skill.description,version:skill.version,content:skill.content}));
export function skillCatalog(){return bundledSkills.map(({content,...skill})=>skill);}
export function skillContent(id:MoteSkillId){return defaultTaskRegistry.skill(id).content;}
