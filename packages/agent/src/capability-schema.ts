import {ContextToolError} from './tool-errors.js';

/** Validate the same pinned parameter specification consumed by both adapters.
 * No coercion: JSON strings cannot become numbers, and unknown keys fail closed. */
export function validateCapabilityArguments(fields:Record<string,Record<string,unknown>>,args:Record<string,unknown>){
 const fail=()=>{throw new ContextToolError('invalid_tool_arguments','Capability arguments must match its discovered schema.','correct_arguments');};
 const object=(properties:Record<string,Record<string,unknown>>,value:Record<string,unknown>,additional=false)=>{
  if(Object.keys(value).some(key=>!Object.hasOwn(properties,key))&&!additional)fail();
  for(const [key,schema] of Object.entries(properties)){if(value[key]===undefined){if(schema.required===true)fail();continue;}visit(schema,value[key]);}
 };
 const visit=(schema:Record<string,unknown>,value:unknown):void=>{
  if(schema.enum&&(!Array.isArray(schema.enum)||!schema.enum.includes(value)))fail();
  const type=schema.type;
  if(type==='string'&&(typeof value!=='string'||value.length>65536)||type==='integer'&&!Number.isSafeInteger(value)||type==='number'&&(typeof value!=='number'||!Number.isFinite(value))||type==='boolean'&&typeof value!=='boolean')fail();
  if(type==='array'){if(!Array.isArray(value)||value.length>1000)fail();for(const item of value as unknown[])if(schema.items)visit(schema.items as Record<string,unknown>,item);}
  if(type==='object'){if(!value||typeof value!=='object'||Array.isArray(value))fail();object((schema.properties??{}) as Record<string,Record<string,unknown>>,value as Record<string,unknown>,schema.additionalProperties===true);}
 };
 object(fields,args);
}
