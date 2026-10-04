import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
import {isolatedEnvironment} from '../profile-lib.mjs';

const profile={profile:'test',env:{MOTE_TOKEN:'generated-profile-token'},meta:{runtime:'native'},project:'generated-profile-proxy',directory:'/tmp/generated-profile-proxy',dataDir:'/tmp/generated-profile-proxy/data',envFile:'/tmp/generated-profile-proxy/mote.env',url:'http://127.0.0.1:47852'};
const cleanProxy={HTTP_PROXY:undefined,http_proxy:undefined,HTTPS_PROXY:undefined,https_proxy:undefined,NO_PROXY:undefined,no_proxy:undefined};

test('profile proxies preserve configured bypasses and always bypass IPv4/IPv6 loopback in both cases',()=>{
  const env=isolatedEnvironment(profile,{...cleanProxy,HTTP_PROXY:'http://upper.fixture:1',http_proxy:'http://lower.fixture:2',HTTPS_PROXY:'http://tls.fixture:3',NO_PROXY:'internal.fixture, localhost',no_proxy:'.private.fixture,internal.fixture'});
  assert.equal(env.NODE_USE_ENV_PROXY,'1');
  assert.equal(env.HTTP_PROXY,'http://lower.fixture:2');assert.equal(env.http_proxy,env.HTTP_PROXY);
  assert.equal(env.HTTPS_PROXY,'http://tls.fixture:3');assert.equal(env.https_proxy,env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY,env.no_proxy);
  assert.deepEqual(new Set(env.NO_PROXY.split(',')),new Set(['internal.fixture','.private.fixture','127.0.0.1','localhost','::1','[::1]']));
  const empty=isolatedEnvironment(profile,{...cleanProxy,NO_PROXY:'keep.fixture',no_proxy:''});
  assert.ok(empty.NO_PROXY.split(',').includes('keep.fixture'));assert.equal(empty.NO_PROXY,empty.no_proxy);
  const emptyLower=isolatedEnvironment(profile,{...cleanProxy,HTTP_PROXY:'http://upper.fixture:1',http_proxy:''});
  assert.equal(emptyLower.HTTP_PROXY,'http://upper.fixture:1');assert.equal(emptyLower.http_proxy,emptyLower.HTTP_PROXY,'empty lowercase preserves Node uppercase fallback');
  const all=isolatedEnvironment(profile,{...cleanProxy,no_proxy:'*'});assert.ok(all.NO_PROXY.split(',').includes('*'),'explicit all-traffic bypass is retained');
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
