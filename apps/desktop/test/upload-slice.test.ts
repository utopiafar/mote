import {expect,it} from 'vitest';
import {UploadSlice,UploadSliceYield} from '../src/upload-slice';
it('metadata cannot prevent an original part fitting, and the next request yields at a bounded boundary',()=>{
 const slice=new UploadSlice(4*1024*1024);slice.admit({manifest:true});slice.admit(new Uint8Array(4*1024*1024));
 expect(()=>slice.admit(new Uint8Array(4*1024*1024))).toThrow(UploadSliceYield);expect(slice.bytes).toBeLessThan(4*1024*1024+100);
});
it('request count and elapsed time also bound empty-body metadata traffic',()=>{
 const count=new UploadSlice(1000,2);count.admit(undefined);count.admit(undefined);expect(()=>count.admit(undefined)).toThrow(UploadSliceYield);
 let now=0;const time=new UploadSlice(1000,20,15000,()=>now);time.admit(undefined);now=15000;expect(()=>time.admit(undefined)).toThrow(UploadSliceYield);
});
