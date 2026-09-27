// Generated transport fixture only; production decoding is tested in server.
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {ContextToolError} from '../dist/tool-errors.js';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function generatedImageRead(bytes,args){
 const metadata=await sharp(bytes).metadata(),original={sha256:digest(bytes),width:metadata.width,height:metadata.height,mimeType:'image/png',orientation:1,pages:1};
 if(args.expectedImageSha256&&args.expectedImageSha256!==original.sha256)throw new ContextToolError('image_version_changed','Generated original changed','correct_arguments');
 const region=args.region??null,transform=args.view==='metadata'?'metadata@1':region?'crop-encoded-raster-png@1':'original-bytes@1';
 const imageView={original,coordinateSpace:'encoded-raster-pixels-v1',region,transform,viewId:digest(JSON.stringify([original.sha256,'encoded-raster-pixels-v1',region,transform]))};
 if(args.view==='metadata')return {mimeType:'image/png',imageView};
 const output=region?await sharp(bytes).extract({left:region.x,top:region.y,width:region.width,height:region.height}).png().toBuffer():bytes;
 imageView.output={sha256:digest(output),width:region?.width??metadata.width,height:region?.height??metadata.height,mimeType:'image/png',sizeBytes:output.length};
 return {mimeType:'image/png',data:output.toString('base64'),imageView};
}
export function assertRegionSchema(assert,schema){
 assert.equal(schema.properties.region.type,'object');assert.deepEqual(schema.properties.region.required,['x','y','width','height']);assert.equal(schema.properties.region.additionalProperties,false);
 for(const name of ['x','y','width','height'])assert.equal(schema.properties.region.properties[name].type,'integer');
 assert.ok(!schema.required.includes('region'),'old plain-image arguments remain valid');
}
