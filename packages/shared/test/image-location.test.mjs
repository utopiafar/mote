import test from 'node:test';
import assert from 'node:assert/strict';
import {imageLocationSchema,transcriptSchema} from '../dist/index.js';
test('image geometry is bounded and losslessly retained without requiring a semantic label',()=>{
 const value={width:1200,height:14825,polygon:[[-0.5,2040.5],[800,2040],[800,2100],[0,2100]]};
 assert.deepEqual(imageLocationSchema.parse(value),value,'near-edge model coordinates are not silently clamped');
 const input={durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated',imageLocation:value}]};
 assert.deepEqual(transcriptSchema.parse(input),input);
 assert.equal(imageLocationSchema.safeParse({width:1,height:120000,polygon:[[0,110000],[1,110000],[1,110010],[0,110010]]}).success,true,'native pixel/tile limits permit a very thin 120000-pixel image');
 for(const imageLocation of [{...value,width:0},{...value,height:1_000_001},{...value,polygon:[[NaN,0],[1,0],[1,1]]},{...value,polygon:[[Infinity,0],[1,0],[1,1]]},{...value,polygon:Array(17).fill([0,0])},{...value,polygon:[[0,0]]},{...value,speaker:'owner'}])assert.equal(imageLocationSchema.safeParse(imageLocation).success,false);
});
