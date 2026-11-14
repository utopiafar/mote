import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {connect} from 'node:net';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedEnvironment,launchdXml,profilePaths,initialize,loadProfile,repository} from '../profile-lib.mjs';

const profile={profile:'test',env:{MOTE_TOKEN:'generated-profile-token'},meta:{runtime:'native'},home:'/tmp/generated-profile-proxy-home',project:'generated-profile-proxy',directory:'/tmp/generated-profile-proxy',dataDir:'/tmp/generated-profile-proxy/data',configFile:'/tmp/generated-profile-proxy/mote.yaml',url:'http://127.0.0.1:47852'};
const cleanProxy={HTTP_PROXY:undefined,http_proxy:undefined,HTTPS_PROXY:undefined,https_proxy:undefined,ALL_PROXY:undefined,all_proxy:undefined,NO_PROXY:undefined,no_proxy:undefined};
const decodePlist=value=>value.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
function plistEnvironment(xml){
  const match=/<key>EnvironmentVariables<\/key><dict>([\s\S]*?)<\/dict>/.exec(xml);
  if(!match)return {};
  return Object.fromEntries([...match[1].matchAll(/<key>([^<]+)<\/key><string>([^<]*)<\/string>/g)].map(([,key,value])=>[decodePlist(key),decodePlist(value)]));
}

test('launchd runs absolute env-node CLI shims with the selected Node without the shell PATH',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-launchd-path-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const nodeDirectory=join(root,'selected Node & "quoted"'),cliDirectory=join(root,'trusted CLI'),emptyPath=join(root,'empty-bin');
  await Promise.all([nodeDirectory,cliDirectory,emptyPath].map(path=>mkdir(path)));
  const node=join(nodeDirectory,'node'),shim=join(cliDirectory,'codex.cjs'),invocations=join(root,'node-invocations');
  const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
  // Record every interpreter invocation, then execute the real Node binary. This
  // distinguishes the selected runtime from any Node installed in a fallback dir.
  await writeFile(node,`#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(invocations)}\nexec ${quote(process.execPath)} "$@"\n`,{mode:0o700});
  await writeFile(shim,'#!/usr/bin/env node\nconsole.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2),proxy:process.env.http_proxy,proxyEnabled:process.env.NODE_USE_ENV_PROXY}));\n',{mode:0o700});
  const paths=profilePaths('test',join(root,'profiles'));await initialize(paths);const p=await loadProfile(paths);
  const entry=join(repository,'scripts/mote.mjs');
  const source={HOME:root,PATH:emptyPath,HTTP_PROXY:'http://proxy.fixture:1',http_proxy:'http://lower.fixture:2',OPENAI_API_KEY:'generated-model-key',MOTE_TOKEN:'generated-ambient-owner-token',CODEX_HOME:join(root,'private-login'),NODE_OPTIONS:'--no-warnings'};
  const generated=spawnSync(process.execPath,[entry,'launchd','--profile','test','--home',paths.home,'--node',node],{env:source,encoding:'utf8',timeout:10000});
  assert.equal(generated.status,0,generated.stderr);
  const file=JSON.parse(generated.stdout);assert.equal(file.installed,false);
  const xml=await readFile(file.generated,'utf8');
  for(const secret of [p.env.MOTE_TOKEN,source.MOTE_TOKEN,source.OPENAI_API_KEY,source.CODEX_HOME])assert.equal(xml.includes(secret),false);
  assert.equal(xml.includes('NODE_OPTIONS'),false);
  let launch={EnvironmentVariables:plistEnvironment(xml),ProgramArguments:[...xml.match(/<key>ProgramArguments<\/key><array>([\s\S]*?)<\/array>/)[1].matchAll(/<string>([^<]*)<\/string>/g)].map(([,value])=>decodePlist(value))};
  if(process.platform==='darwin'){
    // Use macOS's actual plist consumer for the local execution evidence.
    const parsed=spawnSync('/usr/bin/plutil',['-convert','json','-o','-',file.generated],{encoding:'utf8',timeout:10000});
    assert.equal(parsed.status,0,parsed.stderr);launch=JSON.parse(parsed.stdout);
  }
  assert.deepEqual(launch.ProgramArguments,[node,entry,'run','--profile','test','--home',paths.home]);
  const gui={HOME:root,PATH:emptyPath};
  const missing=spawnSync(shim,['--version'],{env:gui,encoding:'utf8',timeout:10000});
  assert.notEqual(missing.status,0,'negative control has no Node on PATH');assert.match(missing.stderr,/node/);
  const env={...gui,...launch.EnvironmentVariables};
  const direct=spawnSync(shim,['--version'],{env,cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(direct.status,0,direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout),{node:process.execPath,args:['--version'],proxy:source.http_proxy});
  // Exercise the same isolatedEnvironment boundary used by `run`, through the
  // public `exec` command; no Central or LaunchAgent needs to be installed.
  const [executable,script,,...profileArgs]=launch.ProgramArguments;
  const child=spawnSync(executable,[script,'exec',...profileArgs,'--',shim,'--version'],{env,cwd:root,encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{node:process.execPath,args:['--version'],proxy:source.http_proxy,proxyEnabled:'1'});
  assert.deepEqual((await readFile(invocations,'utf8')).trim().split('\n'),[shim,entry,shim]);
});

test('profile proxies preserve configured bypasses and always bypass IPv4/IPv6 loopback in both cases',()=>{
  const env=isolatedEnvironment(profile,{...cleanProxy,HTTP_PROXY:'http://upper.fixture:1',http_proxy:'http://lower.fixture:2',HTTPS_PROXY:'http://tls.fixture:3',ALL_PROXY:'socks5://all-upper.fixture:6',all_proxy:'socks5://all-lower.fixture:7',NO_PROXY:'internal.fixture, localhost',no_proxy:'.private.fixture,internal.fixture'});
  assert.equal(env.NODE_USE_ENV_PROXY,'1');
  assert.equal(env.HTTP_PROXY,'http://lower.fixture:2');assert.equal(env.http_proxy,env.HTTP_PROXY);
  assert.equal(env.HTTPS_PROXY,'http://tls.fixture:3');assert.equal(env.https_proxy,env.HTTPS_PROXY);
  assert.equal(env.ALL_PROXY,'socks5://all-lower.fixture:7');assert.equal(env.all_proxy,env.ALL_PROXY);
  assert.equal(env.NO_PROXY,env.no_proxy);
  assert.deepEqual(new Set(env.NO_PROXY.split(',')),new Set(['internal.fixture','.private.fixture','127.0.0.1','localhost','::1','[::1]']));
  const empty=isolatedEnvironment(profile,{...cleanProxy,NO_PROXY:'keep.fixture',no_proxy:''});
  assert.ok(empty.NO_PROXY.split(',').includes('keep.fixture'));assert.equal(empty.NO_PROXY,empty.no_proxy);
  const emptyLower=isolatedEnvironment(profile,{...cleanProxy,HTTP_PROXY:'http://upper.fixture:1',http_proxy:''});
  assert.equal(emptyLower.HTTP_PROXY,'http://upper.fixture:1');assert.equal(emptyLower.http_proxy,emptyLower.HTTP_PROXY,'empty lowercase preserves Node uppercase fallback');
  const allUpper=isolatedEnvironment(profile,{...cleanProxy,ALL_PROXY:'socks5://all-upper.fixture:6'});
  assert.equal(allUpper.ALL_PROXY,'socks5://all-upper.fixture:6');assert.equal(allUpper.all_proxy,allUpper.ALL_PROXY);
  const allLower=isolatedEnvironment(profile,{...cleanProxy,all_proxy:'socks5://all-lower.fixture:7'});
  assert.equal(allLower.ALL_PROXY,'socks5://all-lower.fixture:7');assert.equal(allLower.all_proxy,allLower.ALL_PROXY);
  const allEmptyLower=isolatedEnvironment(profile,{...cleanProxy,ALL_PROXY:'socks5://all-upper.fixture:6',all_proxy:''});
  assert.equal(allEmptyLower.ALL_PROXY,'socks5://all-upper.fixture:6');assert.equal(allEmptyLower.all_proxy,allEmptyLower.ALL_PROXY,'empty lowercase preserves Node uppercase fallback');
  const noAll=isolatedEnvironment(profile,{...cleanProxy});
  assert.equal(noAll.ALL_PROXY,undefined);assert.equal(noAll.all_proxy,undefined);
  const all=isolatedEnvironment(profile,{...cleanProxy,no_proxy:'*'});assert.ok(all.NO_PROXY.split(',').includes('*'),'explicit all-traffic bypass is retained');
});

test('launchd generation adds a stable PATH and snapshots only proxy variables present in the generating process',()=>{
  const env={PATH:'/generated/bin',HTTP_PROXY:'http://upper.fixture:1',http_proxy:'http://lower.fixture:2',HTTPS_PROXY:'http://tls.fixture:3',all_proxy:'socks5://all.fixture:4',NO_PROXY:'internal.fixture',no_proxy:'private.fixture',NODE_USE_ENV_PROXY:'0'};
  const xml=launchdXml(profile,'/generated/node',env).contents;
  const PATH='/generated:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  assert.deepEqual(plistEnvironment(xml),{PATH,HTTP_PROXY:'http://upper.fixture:1',http_proxy:'http://lower.fixture:2',HTTPS_PROXY:'http://tls.fixture:3',all_proxy:'socks5://all.fixture:4',NO_PROXY:'internal.fixture',no_proxy:'private.fixture'});
  assert.equal(xml.includes('NODE_USE_ENV_PROXY'),false);
  assert.equal(xml.includes(profile.env.MOTE_TOKEN),false);
  const runtime=isolatedEnvironment(profile,plistEnvironment(xml));
  assert.equal(runtime.NODE_USE_ENV_PROXY,'1');
  assert.equal(runtime.http_proxy,'http://lower.fixture:2');assert.equal(runtime.ALL_PROXY,'socks5://all.fixture:4');assert.equal(runtime.all_proxy,runtime.ALL_PROXY);
  assert.ok(runtime.NO_PROXY.split(',').includes('127.0.0.1'));
  const noProxy=launchdXml(profile,'/generated/node',{PATH:'/generated/bin'}).contents;
  assert.deepEqual(plistEnvironment(noProxy),{PATH});
  const allOnly=plistEnvironment(launchdXml(profile,'/generated/node',{ALL_PROXY:'socks5://all-upper.fixture:6'}).contents);
  assert.deepEqual(allOnly,{PATH,ALL_PROXY:'socks5://all-upper.fixture:6'});
});

test('launchd ignores shell PATH entries and credentials and deduplicates the selected Node directory',()=>{
  const env={PATH:':.:relative:/generated/untrusted-bin',OPENAI_API_KEY:'generated-secret',MOTE_TOKEN:'generated-owner-secret',CODEX_HOME:'/generated/private-login',NODE_OPTIONS:'--require /generated/injected.cjs'};
  const generated=launchdXml(profile,'/usr/local/bin/node',env);
  assert.deepEqual(plistEnvironment(generated.contents),{PATH:'/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'});
  for(const value of Object.values(env))assert.equal(generated.contents.includes(value),false);
  assert.deepEqual(launchdXml(profile,'/usr/local/bin/node',{}),generated,'shell environment cannot change the stable executable search path');
});

test('launchd refuses relative Node paths and PATH separators or control characters',()=>{
  for(const node of ['node','./node','/generated:untrusted/node','/generated/\nnode','/generated/\0node','/generated/\t/node','/generated/\x7f/node'])assert.throws(()=>launchdXml(profile,node,{}),/Node path must be absolute and contain no colon or control characters/);
});

test('profile startup bypasses local authenticated HTTP and fetch while remote model downloads still use the proxy',async t=>{
  const direct=[],proxied=[];
  const origin=http.createServer((req,res)=>{direct.push({path:req.url,authorization:req.headers.authorization});req.resume();res.end(JSON.stringify({direct:true}));});
  const proxy=http.createServer((req,res)=>{proxied.push({path:req.url,authorization:req.headers.authorization});req.resume();res.end(JSON.stringify({proxied:true}));});
  const download=http.createServer((req,res)=>{proxied.push({path:'http://proxy-fixture.invalid'+req.url,authorization:req.headers.authorization});req.resume();res.end(JSON.stringify({proxied:true}));});
  await Promise.all([new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve)),new Promise(resolve=>download.listen(0,'127.0.0.1',resolve))]);
  const sockets=new Set();
  proxy.on('connect',(req,socket,head)=>{
    if(req.url!=='proxy-fixture.invalid:80'){socket.destroy();return;}
    const upstream=connect(download.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.once('close',()=>upstream.destroy());
  });
  t.after(async()=>{for(const socket of sockets)socket.destroy();origin.closeAllConnections();proxy.closeAllConnections();download.closeAllConnections();await Promise.all([new Promise(resolve=>origin.close(resolve)),new Promise(resolve=>proxy.close(resolve)),new Promise(resolve=>download.close(resolve))]);});
  const loopback=`http://127.0.0.1:${origin.address().port}`,proxyUrl=`http://127.0.0.1:${proxy.address().port}`;
  for(const variables of [{HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl},{http_proxy:proxyUrl,https_proxy:proxyUrl},{HTTP_PROXY:'http://127.0.0.1:1',http_proxy:proxyUrl,HTTPS_PROXY:'http://127.0.0.1:1',https_proxy:proxyUrl},{HTTP_PROXY:proxyUrl,http_proxy:'',HTTPS_PROXY:proxyUrl,https_proxy:''}]){
    const env=isolatedEnvironment(profile,{...cleanProxy,...variables,NO_PROXY:'upper.fixture',no_proxy:'lower.fixture'});
    const source=`import assert from 'node:assert/strict';import http from 'node:http';const get=url=>new Promise((resolve,reject)=>{http.get(url,{headers:{Authorization:'Bearer generated-loopback-token'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve(JSON.parse(text)));}).on('error',reject);});assert.equal((await get(${JSON.stringify(loopback+'/http')})).direct,true);assert.equal((await (await fetch(${JSON.stringify(loopback+'/fetch')},{headers:{Authorization:'Bearer generated-loopback-token'}})).json()).direct,true);assert.equal((await (await fetch('http://proxy-fixture.invalid/model.json')).json()).proxied,true);console.log('passed');`;
    const child=spawn(process.execPath,['--input-type=module','-e',source],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
    assert.equal(code,0,stderr);assert.equal(stdout.trim(),'passed');
  }
  assert.equal(direct.length,8);assert.ok(direct.every(item=>item.authorization==='Bearer generated-loopback-token'));
  assert.equal(proxied.length,4);assert.ok(proxied.every(item=>item.path==='http://proxy-fixture.invalid/model.json'&&item.authorization===undefined),'loopback credential never reaches the download proxy');
});
