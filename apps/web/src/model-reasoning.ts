import {MODEL_REASONING_EFFORTS,type ModelReasoningEffort} from '@mote/shared/models';

export interface CatalogModel {id:string;name:string;reasoningEfforts?:string[];defaultReasoningEffort?:string}

/** Codex names `none` on the wire; older Mote settings store the same request as `off`. */
export function codexEffortValue(effort:string):ModelReasoningEffort|undefined {
  const value=effort==='none'?'off':effort;
  return value!=='auto'&&MODEL_REASONING_EFFORTS.includes(value as ModelReasoningEffort)?value as ModelReasoningEffort:undefined;
}

export function codexReasoningChoices(model:CatalogModel|undefined):{options:{value:ModelReasoningEffort;wire:string}[];known:boolean;unknown:string[]} {
  if(!model?.reasoningEfforts)return {options:[],known:false,unknown:[]};
  const options:{value:ModelReasoningEffort;wire:string}[]=[],unknown:string[]=[];
  for(const wire of model.reasoningEfforts){
    const value=codexEffortValue(wire);
    if(value){if(!options.some(option=>option.value===value))options.push({value,wire});}
    else unknown.push(wire);
  }
  return {options,known:true,unknown};
}
