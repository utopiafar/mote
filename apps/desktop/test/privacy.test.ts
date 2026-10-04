import {describe,expect,it} from 'vitest';import {maskBitmap} from '../src/privacy';
describe('pre-persistence masks',()=>{
 it('blacks out full covered pixels with rounded-out boundaries without changing the input',()=>{
  const pixels=Buffer.alloc(4*4*4,123),masked=maskBitmap(pixels,4,4,[{x:.26,y:.26,width:.24,height:.24}]);expect([...masked.subarray(20,24)]).toEqual([0,0,0,255]);expect(masked.subarray(0,20)).toEqual(pixels.subarray(0,20));expect(pixels.every(b=>b===123)).toBe(true);expect(()=>maskBitmap(pixels,4,4,[{x:-.1,y:0,width:1,height:1}])).toThrow();
 });
});
