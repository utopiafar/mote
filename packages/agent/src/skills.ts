import {readFileSync} from 'node:fs';

export const SKILL_VERSION = '1.0.2';
const catalog = [
  {id:'personal-insight',name:'personal-insight',description:'Review personal context, distinguish evidence from inference, and create a cited HTML insight report.'},
  {id:'memory-extraction',name:'memory-extraction',description:'Propose durable memories from an explicit batch of original evidence, preserving attribution and provenance.'},
  {id:'document-import',name:'document-import',description:'Inspect user-selected files and write a generic records manifest for a reviewable import.'},
] as const;
export type MoteSkillId = typeof catalog[number]['id'];
export const bundledSkills = catalog.map(skill=>({...skill,version:SKILL_VERSION,
  content:readFileSync(new URL(`../skills/${skill.id}/SKILL.md`,import.meta.url),'utf8'),
}));
export function skillCatalog(){return bundledSkills.map(({content,...skill})=>skill);}
export function skillContent(id:MoteSkillId){const skill=bundledSkills.find(s=>s.id===id);if(!skill)throw new Error('Unknown Mote skill');return skill.content;}
