import {attributionContextSchema,parseEvidenceId} from '@mote/shared';

const pinnedMaterialRef=/^material:(mat_[a-f0-9]{64})@([a-f0-9]{64})$/;

/** Host final disclosure projection. Reader and pack bodies remain untrusted;
 * opened attribution statements use the dedicated authorized read path. */
export function attributionMetadata(value:unknown){
  const parsed=attributionContextSchema.safeParse(value);if(!parsed.success)return undefined;
  const {ownerStatements:_owner,importStatements:_import,sourceContextStatements:_source,recordContextStatements:_record,...metadata}=parsed.data;
  return metadata;
}
export function attributionMetadataResponse(value:unknown,parentLocator?:{id:string}|{ref:string}):unknown {
  if(Array.isArray(value))return value.map(item=>attributionMetadataResponse(item,parentLocator));
  if(!value||typeof value!=='object')return value;
  const object=value as Record<string,unknown>;
  const locator=typeof object.ref==='string'&&pinnedMaterialRef.test(object.ref)?{ref:object.ref}:
    typeof object.id==='string'&&parseEvidenceId(object.id)?{id:parseEvidenceId(object.id)!}:parentLocator;
  const result:Record<string,unknown>={};
  for(const [key,item] of Object.entries(object)){
    if(key==='attributionContext'){
      const metadata=attributionMetadata(item);if(metadata){result[key]=metadata;if(locator)result.attributionContextLocator=locator;}
    }else if(key==='attributionContexts'&&item&&typeof item==='object'&&!Array.isArray(item)){
      result[key]=Object.fromEntries(Object.entries(item).flatMap(([id,context])=>{const metadata=attributionMetadata(context);return metadata?[[id,metadata]]:[];}));
    }else result[key]=attributionMetadataResponse(item,locator);
  }
  return result;
}
