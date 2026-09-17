import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {storageStatistics} from '../dist/storage-statistics.js';
test('counts overlapping owned roots once and does not follow external symlinks',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-storage-stats-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'fixture.json'),'abc');await writeFile(join(root,'image.blob'),'12345');await symlink('/etc',join(root,'outside'));
 const result=await storageStatistics([root,join(root,'fixture.json')]);assert.equal(result.bytes,8);assert.equal(result.files,2);assert.equal(result.skipped,1);assert.equal(result.types.find(t=>t.key==='image').bytes,5);assert.equal(result.days.reduce((n,b)=>n+b.bytes,0),8);
});
