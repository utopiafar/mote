import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {connect} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

for(const protocol of ['http','https'] as const)test(`${protocol} local ASR, diarization, image extraction and health stay direct under startup environment proxies`,async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-worker-proxy-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const received:{path:string;authorization:string|undefined;offline:string|undefined;timeout:string|undefined;body:Buffer}[]=[],proxied:{path:string;authorization:string|undefined;body:Buffer}[]=[],tunnels:string[]=[];
  const handler=async(req:IncomingMessage,res:ServerResponse)=>{
    if(req.url==='/proxy-control'){req.resume();res.end(JSON.stringify({proxyControl:true}));return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    received.push({path:req.url!,authorization:req.headers.authorization,offline:req.headers['x-mote-offline'] as string|undefined,timeout:req.headers['x-mote-processing-timeout-ms'] as string|undefined,body:Buffer.concat(chunks)});
    res.setHeader('X-Mote-Execution','local');res.setHeader('Content-Type','application/json');
    const result=req.url==='/diarize'?{durationMs:1000,engine:'generated',expectedSpeakers:null,observedSpeakers:1,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'}],samples:[]}:req.url==='/health'?{version:1,execution:'local',asr:true,diarization:true,ocr:true}:req.url==='/ocr'?{durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated image'}]}:{durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated speech'}]};
    res.end(JSON.stringify(result));
  };
  let tls:{key:Buffer;cert:Buffer}|undefined;
  const certificate=join(directory,'cert.pem');
  if(protocol==='https'){
    const config=join(directory,'openssl.cnf'),key=join(directory,'key.pem');
    await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:true\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-config',config,'-keyout',key,'-out',certificate],{stdio:'ignore'});
    tls={key:await readFile(key),cert:await readFile(certificate)};
  }
  const origin=tls?createHttpsServer(tls,handler):createHttpServer(handler),proxy=createHttpServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);proxied.push({path:req.url!,authorization:req.headers.authorization,body:Buffer.concat(chunks)});res.end(JSON.stringify({proxyControl:true}));});
  await Promise.all([new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve)),new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve))]);
  const address=origin.address() as {port:number},proxyAddress=proxy.address() as {port:number},endpoint=`${protocol}://127.0.0.1:${address.port}`,proxyUrl=`http://127.0.0.1:${proxyAddress.port}`;
  const sockets=new Set<import('node:net').Socket>();
  proxy.on('connect',(req,socket,head)=>{
    tunnels.push(req.url!);if(req.url!==`127.0.0.1:${address.port}`){socket.destroy();return;}
    const upstream=connect(address.port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);upstream.pipe(socket);socket.pipe(upstream);});
    sockets.add(upstream);upstream.once('close',()=>sockets.delete(upstream));upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.once('close',()=>upstream.destroy());
  });
  t.after(async()=>{for(const socket of sockets)socket.destroy();origin.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise<void>(resolve=>origin.close(()=>resolve())),new Promise<void>(resolve=>proxy.close(()=>resolve()))]);});
  for(const variables of [{HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,http_proxy:undefined,https_proxy:undefined},{HTTP_PROXY:'http://127.0.0.1:1',HTTPS_PROXY:'http://127.0.0.1:1',http_proxy:proxyUrl,https_proxy:proxyUrl}]){
    const env={...process.env,...variables,NODE_USE_ENV_PROXY:'1',NO_PROXY:'',no_proxy:'',...(tls?{NODE_EXTRA_CA_CERTS:certificate}:{})};
    const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/local-worker-proxy-client.ts',import.meta.url)),endpoint],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    const timer=setTimeout(()=>child.kill('SIGKILL'),15000);const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});clearTimeout(timer);
    assert.equal(code,0,stderr);assert.equal(stdout.trim(),'passed');
  }
  assert.equal(received.length,10);assert.ok(received.every(item=>item.authorization==='Bearer generated-worker-token'));
  for(const record of received){assert.ok(['/transcribe','/diarize','/ocr','/health'].includes(record.path));assert.deepEqual(record.body,record.path==='/health'?Buffer.alloc(0):record.path==='/ocr'?Buffer.from([137,80,78,71,0,255,3]):Buffer.from([0,255,1,2,3,10,13,0]));}
  assert.equal(received.filter(item=>item.path==='/transcribe'&&item.offline==='1').length,2);assert.ok(received.filter(item=>item.path==='/diarize').every(item=>item.offline==='1'));
  assert.ok(received.filter(item=>['/transcribe','/diarize'].includes(item.path)).every(item=>item.timeout==='1800000'),'local audio requests carry the explicitly configured budget');
  assert.ok(received.filter(item=>['/ocr','/health'].includes(item.path)).every(item=>item.timeout===undefined));
  assert.equal(proxied.length,protocol==='http'?2:0,'only unauthenticated positive-control HTTP requests may reach the proxy');
  assert.ok(proxied.every(item=>item.path===endpoint+'/proxy-control'&&item.authorization===undefined&&item.body.length===0));
  assert.equal(tunnels.length,protocol==='https'?2:0,'only the positive-control HTTPS requests use proxy tunnels');
});
