// Test-only relay: the restricted import process never receives the real provider key.
// Only one fixed model endpoint is reachable; no redirects or arbitrary proxy URLs.
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

export async function createLiveModelRelay(apiKey:string,model:string){
  const token=randomBytes(32).toString('hex'),authorization=Buffer.from('Bearer '+token);
  const server=createServer(async(req,res)=>{
    const supplied=Buffer.from(req.headers.authorization??'');
    if(req.method!=='POST'||!['/chat/completions','/v1/chat/completions'].includes(req.url??'')||supplied.length!==authorization.length||!timingSafeEqual(supplied,authorization)){res.writeHead(403).end();return;}
    const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),300000);
    res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
      const chunks:Buffer[]=[];let size=0;
      for await(const raw of req){const chunk=Buffer.from(raw);size+=chunk.length;if(size>4*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
      const body=Buffer.concat(chunks);if(JSON.parse(body.toString()).model!==model){res.writeHead(400).end();return;}
      const upstream=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},body,redirect:'error',signal:controller.signal});
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json','cache-control':'no-store'});
      let returned=0;if(upstream.body){const reader=upstream.body.getReader();try{while(true){const {done,value}=await reader.read();if(done)break;returned+=value.byteLength;if(returned>32*1024*1024)throw Error('Response exceeded relay limit');if(!res.write(value))await once(res,'drain',{signal:controller.signal});}}finally{reader.releaseLock();}}
      res.end();
    }catch{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"error":"Model relay request failed"}');}
    finally{clearTimeout(deadline);}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as AddressInfo).port;
  return {port,baseUrl:`http://127.0.0.1:${port}`,apiKey:token,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
