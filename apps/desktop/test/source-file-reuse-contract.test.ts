import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../server/src/app';
import type { Config } from '../../server/src/config';
import { scanSourceFiles } from '../src/source-files';
import { SourceSync } from '../src/source-sync';
import { DEFAULT_SOURCE_OPTIONS, type SourceDefinition, type SourceRequest } from '../src/source-types';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, {recursive:true, force:true}); root = undefined; });

it('sends actual Mac manifests to Central and reuses an authorized archive without merging file identities', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mote-mac-reuse-')));
  const selected = join(root, 'selected'); await mkdir(selected);
  const bytes = Buffer.from('Generated identical archive bytes');
  await writeFile(join(selected, 'a.txt'), bytes); await writeFile(join(selected, 'b.txt'), bytes);
  const token = 'generated-mac-reuse-owner';
  const config: Config = {dataDir:join(root, 'central'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',contentEncryptionEnabled:true,dataKey:'53'.repeat(32)};
  const node = await buildApp(config, {backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model expected');},close:async()=>{}}});
  try {
    await node.app.ready();
    const source: SourceDefinition = {id:'generated-mac',name:'Generated Mac',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'archive',enabled:true};
    const scan = await scanSourceFiles(selected, {...DEFAULT_SOURCE_OPTIONS,retention:'archive'}, undefined, join(root, 'markers'));
    expect(scan.items).toHaveLength(2); expect(new Set(scan.items.map(item=>item.externalId)).size).toBe(2);
    const sync = new SourceSync(join(root, 'outbox')); await sync.initialize(); await sync.stage(scan, false);
    const paths: string[] = [],acks: any[] = [];
    const request: SourceRequest = async (path, body, method) => {
      paths.push(path);
      const response = await node.app.inject({method,url:path,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2',...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{})},payload:body as any});
      expect(response.statusCode, response.body).toBe(200);
      const value = response.json(); if (value.ack) acks.push(value.ack);
      return value;
    };
    await sync.flush(source, request);
    expect(sync.status().pending).toBe(0);
    expect(paths.filter(path=>path==='/api/file-sync/v1/uploads')).toHaveLength(2);
    expect(paths.filter(path=>path.includes('/parts/'))).toHaveLength(1);
    expect(paths.filter(path=>path.endsWith('/commit'))).toHaveLength(1);
    expect(acks).toHaveLength(1); // The second begin received Central's reuse ACK.
    const records = scan.items.map(item=>node.sources.getItem(source.id,item.externalId)!);
    expect(records[0].captureId).not.toBe(records[1].captureId);
    for (const record of records) expect(Buffer.concat([...node.files.bytes(record.captureId)])).toEqual(bytes);
  } finally { await node.app.close(); }
});

it('retries an attempted reference manifest before publishing a newer revision', async () => {
  root=await realpath(await mkdtemp(join(tmpdir(),'mote-reference-retry-')));
  const selected=join(root,'selected'),file=join(selected,'a.txt');await mkdir(selected);await writeFile(file,'first');
  const token='generated-reference-retry-owner';
  const config:Config={dataDir:join(root,'central'),token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',contentEncryptionEnabled:true,dataKey:'53'.repeat(32)};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model expected');},close:async()=>{}}});
  try{
    await node.app.ready();
    const source:SourceDefinition={id:'reference-mac',name:'Generated',kind:'local-files',deviceId:'generated-device',platform:'macos',retention:'reference',enabled:true};
    const options={...DEFAULT_SOURCE_OPTIONS,retention:'reference' as const},sync=new SourceSync(join(root,'outbox'));await sync.initialize();
    const first=await scanSourceFiles(selected,options,undefined,join(root,'markers'));await sync.stage(first,false,undefined,'all','history');
    const versions:any[]=[];let lose=true;
    const request:SourceRequest=async(path,body,method)=>{
      const response=await node.app.inject({method,url:path,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'},payload:body as any});
      expect(response.statusCode,response.body).toBe(200);
      if(path==='/api/file-sync/v1/manifests'){
        versions.push(structuredClone((body as any).items[0]));
        if(lose){lose=false;throw Error('generated lost response');}
      }
      return response.json();
    };
    await expect(sync.flush(source,request)).rejects.toThrow('lost response');
    await writeFile(file,'newer content');
    const second=await scanSourceFiles(selected,options,undefined,join(root,'markers'),sync.fileCheckpoint(),[file]);
    await sync.stage(second,false,undefined,'all','realtime');
    const pending=sync.pendingContent(),latest=pending.find(item=>item.document?.fileIndex?.contentVersion===second.items[0].document?.fileIndex?.contentVersion)!;
    await sync.flush(source,request);
    expect(versions).toHaveLength(3);
    expect(versions[1]).toEqual(versions[0]);
    expect(versions[2].item.revision).toBe(latest.revision);
    expect(versions[2].previousRevision).toBe(versions[0].item.revision);
    expect(node.sources.getItem(source.id,latest.externalId)?.revision).toBe(latest.revision);
    expect(sync.status()).toMatchObject({pending:0,blocked:0});
  }finally{await node.app.close();}
});
