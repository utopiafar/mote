import {createServer} from 'node:http';
import {requestJson} from './runs.mjs';

/** A real loopback proxy in front of a real run. It drops one successful ACK
 * after the upstream commit, so the retry exercises the actual producer. */
export async function createAckLossProxy(targetBase,{path='/api/notes',status=502,code='generated_receipt_lost'}={}){
  const target=new URL(targetBase),server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks),headers={...req.headers};
    delete headers.host;delete headers['content-length'];delete headers.connection;
    let upstream;
    try{
      upstream=await fetch(new URL(req.url??'/',target),{method:req.method,headers,...(body.length?{body}:{})});
    }catch(error){
      res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'generated_upstream_unavailable',message:String(error)}));return;
    }
    const bytes=Buffer.from(await upstream.arrayBuffer()),kind=new URL(req.url??'/',target).pathname;
    if(armed&&req.method==='POST'&&kind===path&&upstream.ok){
      armed=false;drops++;
      res.writeHead(status,{'content-type':'application/json'});
      res.end(JSON.stringify({error:code,message:'Generated receipt lost after upstream commit'}));return;
    }
    res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
    res.end(bytes);
  });
  let armed=true,drops=0;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {url,drops:()=>drops,arm(){armed=true;},close(){server.closeAllConnections();return new Promise(resolve=>server.close(()=>resolve()));},
    request(pathname,options={}){return requestJson(url,pathname,options);}};
}

/** Held loopback request with explicit release/abort observation; no sleep. */
export async function createControlledHttpBoundary({body={ok:true},status=200}={}){
  let releaseGate,seenGate,abortGate;
  const released=new Promise(resolve=>releaseGate=resolve),seen=new Promise(resolve=>seenGate=resolve),aborted=new Promise(resolve=>abortGate=resolve);
  const state={requests:0,aborted:false,released:false};
  const markAborted=()=>{if(!state.released){state.aborted=true;abortGate();}};
  const server=createServer(async(req,res)=>{
    state.requests++;seenGate();
    req.once('aborted',markAborted);
    res.once('close',markAborted);
    await released;
    if(state.aborted)return;
    state.released=true;
    res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {url,state,waitForRequest:()=>seen,waitForAbort:()=>aborted,release(){releaseGate();},
    close(){server.closeAllConnections();return new Promise(resolve=>server.close(()=>resolve()));}};
}
