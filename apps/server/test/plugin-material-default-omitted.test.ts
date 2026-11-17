import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {defaultDistribution} from '../src/distribution/default.js';

const config=(dataDir:string):ConfigurationPlatformOptions=>({path:dataDir+'/mote.yaml',privateCredential:{token:'generated-omitted-material-token',tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}});

test('the real default host does not instantiate omitted Material retrieval or context owners',async t=>{
  const dataDir=mkdtempSync(join(tmpdir(),'mote-omitted-material-')),options=config(dataDir);
  const distribution={...defaultDistribution,features:defaultDistribution.features.filter(id=>id!=='mote.materials'&&id!=='mote.context')};
  const interval=globalThis.setInterval,stacks:string[]=[];
  globalThis.setInterval=((...args:Parameters<typeof setInterval>)=>{stacks.push(new Error().stack??'');return interval(...args);}) as typeof setInterval;
  t.after(()=>{globalThis.setInterval=interval;});
  const node=await buildApp(options,{backgroundWorker:false,distribution});t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  const contributions=node.bootstrap.snapshot().contributions.map(item=>item.identity.contributionId);
  for(const id of ['material-retrieval-index','material-context','evidence-context-reader'])assert.equal(contributions.includes(id),false,`omitted ${id} must not install`);
  assert.equal(node.indexer,undefined,'omitted Material retrieval must not bind its index port');
  assert.deepEqual(stacks.filter(stack=>stack.includes('material-retrieval-index.ts')),[],'omitted Material retrieval must not start its timer');
  const headers={authorization:`Bearer ${options.privateCredential!.token}`};
  assert.equal((await node.app.inject({url:'/api/materials',headers})).statusCode,404,'omitted Material has no handler');
  assert.equal((await node.app.inject({url:'/api/context/search?query=Generated',headers})).statusCode,404,'omitted context has no handler');
});
