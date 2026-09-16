import {readFileSync} from 'node:fs';

export const SKILL_VERSION = '1.0.3';
const catalog = [
  {id:'calendar-extraction',name:'calendar-extraction',description:'Propose calendar events from original evidence for human confirmation, preserving ambiguity and provenance.'},
  {id:'personal-insight',name:'personal-insight',description:'Review personal context and distinguish evidence from inference, using the host-selected answer or insight-report format.'},
  {id:'coding-memory',name:'coding-memory',description:'Distill coding decisions, pitfalls, principles and preferences from original scoped conversation evidence.'},
  {id:'memory-extraction',name:'memory-extraction',description:'Propose durable memories from an explicit batch of original evidence, preserving attribution and provenance.'},
  {id:'memory-consolidation',name:'memory-consolidation',description:'Consolidate episodic text memories into supported semantic or procedural proposals; revisit originals and preserve conflicting and historical evidence.'},
  {id:'working-memory',name:'working-memory',description:'Compact conversation context into a bounded textual working memory, preserving decisions, open questions and attribution.'},
  {id:'document-import',name:'document-import',description:'Inspect user-selected files and write a generic records manifest for a reviewable import.'},
] as const;
export type MoteSkillId = typeof catalog[number]['id'];
export const bundledSkills = catalog.map(skill=>({...skill,version:skill.id==='memory-consolidation'||skill.id==='working-memory'?'1.0.0':skill.id==='memory-extraction'?'1.1.0':SKILL_VERSION,
  content:readFileSync(new URL(`../skills/${skill.id}/SKILL.md`,import.meta.url),'utf8'),
}));
export function skillCatalog(){return bundledSkills.map(({content,...skill})=>skill);}
export function skillContent(id:MoteSkillId){const skill=bundledSkills.find(s=>s.id===id);if(!skill)throw new Error('Unknown Mote skill');return skill.content;}
