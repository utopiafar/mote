import type {SourceConnection,SourceItem} from '@mote/shared';
import type {MaterialDraft,MaterialAppendDraft} from '../../src/materials.js';
import type {SourcePipeline,SourcePipelineRuntime} from '../../src/source-pipelines.js';
export type FixtureOrganizer=(input:{source:SourceConnection;items:SourceItem[];group:string})=>MaterialDraft|MaterialAppendDraft|undefined;
/** Generated fixtures install trusted handlers through the current pinned recipe contract. */
export function fixtureRecipe(runtime:SourcePipelineRuntime,input:SourcePipeline&{group?:(item:SourceItem)=>string;organize:FixtureOrganizer}){
 const {group,organize,...pipeline}=input,definition=structuredClone(runtime.recipes.resolve('mote.coding','7').definition);
 definition.id=input.id;definition.version=input.version;definition.accepts.sourceKind=input.sourceKinds[0]!;
 const component=input.id+'.fixture-assemble';
 runtime.recipes.registerStep({id:component,version:input.version,kind:'step'},value=>organize({source:value.source,items:[...value.items],group:value.group}));
 definition.steps=[{id:'assemble',use:{id:component},dependsOn:[]}];
 if(group){const groupId=input.id+'.fixture-group',reader=input.id+'.fixture-reader';runtime.recipes.registerGroup({id:groupId,version:'1',kind:'group'},group);definition.group.policy={id:groupId};
  runtime.recipes.registerRawReader({id:reader,version:'1',kind:'raw-reader'},async(_reader,source,identity)=>({...runtime.archive.currentSnapshot(source.id,identity),mode:'full'}));definition.raw.reader={id:reader};}
 runtime.recipes.installRecipe(definition);
 return runtime.registry.register({...pipeline,recipe:{id:definition.id,version:definition.version}});
}
export function codingOrganizer(runtime:SourcePipelineRuntime):FixtureOrganizer{
 const recipe=runtime.recipes.resolve('mote.coding','7');
 return input=>runtime.recipes.organize(recipe,input.source,input.group,{items:input.items,checkpoint:runtime.archive.groupCheckpoint(input.source.id,input.group),mode:'full'});
}
export function codingGroup(runtime:SourcePipelineRuntime,item:SourceItem){return runtime.recipes.group(runtime.recipes.resolve('mote.coding','7'),item);}
