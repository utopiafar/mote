import {moteText} from '@mote/shared/i18n';

export type MemoryRecipeRef={id:string;version:string};
export const memoryRecipeKey=(ref:MemoryRecipeRef)=>ref.id+'@'+ref.version;
export const memoryRecipeLabel=(ref:MemoryRecipeRef)=>(ref.id==='mote.personal-memory'?moteText('个人记忆'):ref.id==='mote.coding-memory'?moteText('编码经验'):ref.id)+' · '+moteText('版本 {0}',ref.version);
