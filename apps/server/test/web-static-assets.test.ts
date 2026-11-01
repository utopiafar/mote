import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {brotliCompressSync,gzipSync,constants} from 'node:zlib';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

async function fixture(t:TestContext,mismatch=false){
 const dir=mkdtempSync(join(tmpdir(),'mote-web-assets-')),token='generated-web-owner-token';
 const web=join(dir,'generated-web');mkdirSync(join(web,'assets'),{recursive:true});
 const js=Buffer.from('/* Generated app bundle */'.repeat(200)),html=Buffer.from('<!doctype html><title>Generated web fixture</title>'+ '<!-- Generated HTML -->'.repeat(100));
 const encoded=(source:Buffer)=>({plain:source,br:brotliCompressSync(source,{params:{[constants.BROTLI_PARAM_QUALITY]:11}}),gzip:gzipSync(source,{level:9})});
 const assets=encoded(js),index=encoded(html);
 for(const [path,content] of [[join(web,'assets','app-abc.js'),assets],[join(web,'index.html'),index]] as const){
  writeFileSync(path,content.plain);writeFileSync(path+'.br',content.br);writeFileSync(path+'.gz',content.gzip);
 }
 writeFileSync(join(web,'build-info.json'),JSON.stringify({version:mismatch?'generated-mismatch':JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version}));
 const config:Config={dataDir:dir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,logLevel:'silent'};
 const node=await buildApp(config,{webRoot:web,backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in fixtures');},close:async()=>{}}});
 t.after(async()=>{try{await node.app.close();}finally{rmSync(dir,{recursive:true,force:true});}});
 return {node,assets,index,headers:{authorization:'Bearer '+token}};
}

test('precompressed assets negotiate original/br/gzip bytes with immutable caching while HTML stays no-store',async t=>{
 const {node,assets,index,headers}=await fixture(t);
 for(const encoding of [undefined,'identity','br','gzip'] as const){
  const response=await node.app.inject({url:'/assets/app-abc.js',headers:encoding?{'accept-encoding':encoding}:{}});
  assert.equal(response.statusCode,200);
  assert.equal(response.headers['content-encoding'],encoding==='br'||encoding==='gzip'?encoding:undefined);
  assert.deepEqual(response.rawPayload,assets[encoding==='br'||encoding==='gzip'?encoding:'plain']);
  assert.equal(response.headers['cache-control'],'public, max-age=31536000, immutable');
  assert.match(String(response.headers.vary),/accept-encoding/i);assert.match(String(response.headers['content-type']),/javascript/);
 }
 for(const url of ['/','/index.html','/some/route'])for(const encoding of [undefined,'br','gzip'] as const){
  const response=await node.app.inject({url,headers:encoding?{'accept-encoding':encoding}:{}});
  assert.equal(response.statusCode,200,url);assert.equal(response.headers['content-encoding'],encoding);
  assert.deepEqual(response.rawPayload,index[encoding??'plain']);assert.equal(response.headers['cache-control'],'no-store');
  assert.match(String(response.headers['content-type']),/^text\/html/);
 }
 const missing=await node.app.inject({url:'/assets/missing.js',headers:{'accept-encoding':'br, gzip'}});
 assert.equal(missing.statusCode,404);assert.equal(missing.headers['cache-control'],'no-store');assert.equal(missing.json().error,'not_found');
 assert.equal(missing.headers['content-encoding'],undefined);
 const api=await node.app.inject({url:'/api/sources',headers:{...headers,'accept-encoding':'br'}});
 assert.equal(api.statusCode,200);assert.ok(Array.isArray(api.json().items));assert.equal(api.headers['cache-control'],'no-store');assert.equal(api.headers['content-encoding'],undefined);
 const unknownApi=await node.app.inject({url:'/api/generated-missing',headers});
 assert.equal(unknownApi.statusCode,404);assert.equal(unknownApi.json().error,'not_found');assert.equal(unknownApi.headers['cache-control'],'no-store');
});

test('a mismatched web build remains unavailable for compressed assets and SPA routes while APIs work',async t=>{
 const {node,headers}=await fixture(t,true);
 for(const url of ['/assets/app-abc.js','/index.html','/some/route']){
  const response=await node.app.inject({url,headers:{'accept-encoding':'br, gzip'}});
  assert.equal(response.statusCode,503);assert.match(response.body,/Web\/server build mismatch/);assert.equal(response.headers['content-encoding'],undefined);
 }
 const api=await node.app.inject({url:'/api/sources',headers});
 assert.equal(api.statusCode,200);assert.ok(Array.isArray(api.json().items));assert.equal(api.headers['cache-control'],'no-store');
});
