import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FeatureInventory} from '@mote/shared';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

const webSource=new URL('../src/',import.meta.url);

async function sourceFiles(directory:URL):Promise<URL[]>{
  const files:URL[]=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const child=new URL(entry.name+(entry.isDirectory()?'/':''),directory);
    if(entry.isDirectory())files.push(...await sourceFiles(child));
    else if(/\.(?:ts|tsx)$/.test(entry.name))files.push(child);
  }
  return files;
}

/** Every remote requirement the Web declares, including the `supports('/api/…')`
 * helper calls used by reads that are not authored as literal http ids. */
async function declaredHttpRequirements():Promise<string[]>{
  const requirements=new Set<string>();
  for(const file of await sourceFiles(webSource)){
    const source=await readFile(file,'utf8');
    for(const match of source.matchAll(/['"`](http:(?:GET|POST|PUT|PATCH|DELETE):\/[^'"`\s]+)['"`]/g))requirements.add(match[1]!);
    for(const match of source.matchAll(/supports\(['"`]([^'"`]+)['"`]\)/g))requirements.add('http:GET:'+match[1]);
  }
  return [...requirements].sort();
}

test('every declared Web HTTP requirement resolves against the real feature inventory',async t=>{
  const requirements=await declaredHttpRequirements();
  assert.ok(requirements.includes('http:GET:/api/owner-questions'));
  assert.ok(requirements.includes('http:GET:/api/materials/:id/read'));
  assert.ok(requirements.includes('http:POST:/api/owner-questions/:id/reply'));
  const directory=await mkdtemp(join(tmpdir(),'mote-web-feature-requirements-'));
  const config:Config={dataDir:directory,token:'generated-web-feature-owner-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
  const node=await buildApp(config,{backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  await node.app.ready();
  const response=await node.app.inject({url:'/api/features',headers:{authorization:'Bearer '+config.token}});
  assert.equal(response.statusCode,200,response.body);
  const inventory=response.json() as FeatureInventory;
  for(const requirement of requirements){
    const capability=inventory.capabilities.find(value=>value.id===requirement);
    assert.ok(capability,requirement+' is not projected by the live host');
    assert.equal(capability.state,'active',requirement);
  }
});
