import {it,expect} from 'vitest';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {renderStorageLocation} from '../src/storage-location-ui';
import type {Status} from '../src/contracts';

it('withdraws the claimed current directory when a committed pointer ACK requires recovery, ahead of cleanup pending',()=>{
 const dom=new JSDOM(readFileSync(new URL('../src/index.html',import.meta.url),'utf8'));
 const root=dom.window.document;
 for(const name of ['storage-location-name','storage-location-count']){const el=root.createElement('p');el.id=name;root.body.append(el);}
 const status={queueDepth:2,config:{captureStorageDirectory:'/generated/new'},storage:{defaultDirectory:'/generated/old',directory:'/generated/old',custom:false,cleanupPending:true,recoveryRequired:'Both generated copies preserved; reopen for recovery'}} as Status;
 renderStorageLocation(root,status,'/generated/new');
 expect(root.getElementById('storage-location-name')!.textContent).toBe('暂时无法确认当前目录');
 expect(root.getElementById('capture-directory-state')!.textContent).toBe(status.storage!.recoveryRequired);
 expect(root.getElementById('capture-directory-state')!.textContent).not.toContain('新目录生效');
 expect(root.getElementById('storage-restart')!.hidden).toBe(false);
 expect((root.getElementById('capture-directory') as HTMLInputElement).value).toBe('/generated/new');
 status.storage!.recoveryRequired=undefined;
 renderStorageLocation(root,status,'/generated/new');
 expect(root.getElementById('storage-restart')!.hidden).toBe(true);
 expect(root.getElementById('capture-directory-state')!.textContent).toContain('新目录生效');
 dom.window.close();
});
