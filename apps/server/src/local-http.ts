import {Agent as HttpAgent,request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {Agent as HttpsAgent,request as httpsRequest} from 'node:https';
import {once} from 'node:events';
import {ProviderFailure,providerHttpFailure} from '@mote/shared';
import {StoreError} from './store.js';

export function isLoopback(endpoint:string){try{return ['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname);}catch{return false;}}

// Local execution is a transport boundary, including when the server is started
// directly with NODE_USE_ENV_PROXY. Never inherit the proxy-enabled global agent.
const httpAgent=new HttpAgent({keepAlive:false,proxyEnv:{}});
const httpsAgent=new HttpsAgent({keepAlive:false,proxyEnv:{}});
export function requestLocalJson(endpoint:string|URL,input:{method?:'GET'|'POST'|'DELETE';headers?:Record<string,string>;body?:AsyncIterable<Buffer>;signal:AbortSignal;limit?:number;requireOfflineExecution?:boolean;onRequest?:()=>void;onResponseHeaders?:(headers:IncomingHttpHeaders)=>void}):Promise<unknown>{
  const url=new URL(endpoint),headers=input.headers??{},limit=input.limit??32*1024*1024;
  if(!isLoopback(url.toString())||!['http:','https:'].includes(url.protocol))throw new StoreError('Local processing requires a loopback service',409);
  const request=url.protocol==='https:'?httpsRequest:httpRequest,agent=url.protocol==='https:'?httpsAgent:httpAgent;
  return new Promise((resolve,reject)=>{
    const rejected=new AbortController(),bodySignal=AbortSignal.any([input.signal,rejected.signal]);
    input.signal.throwIfAborted();input.onRequest?.();
    const outgoing=request(url,{method:input.method??'GET',headers,signal:input.signal,agent},async incoming=>{
      try{
        input.onResponseHeaders?.(incoming.headers);
        if((incoming.statusCode??0)<200||(incoming.statusCode??0)>=300){
          const failure=new ProviderFailure({...providerHttpFailure(incoming.statusCode??502,String(incoming.headers['retry-after']??'')),...(incoming.headers['x-mote-execution']==='local'&&incoming.headers['x-mote-execution-started']==='false'?{executionStarted:false as const}:{})},undefined,{source:'http',httpStatus:incoming.statusCode??502});
          // A local worker can reject before consuming the upload. Stop reading
          // the original and preserve that typed response instead of replacing
          // it with a later request-body EPIPE/drain failure.
          rejected.abort(failure);incoming.destroy();outgoing.destroy();throw failure;
        }
        if(input.requireOfflineExecution&&incoming.headers['x-mote-execution']!=='local'){incoming.resume();throw new StoreError('Local worker did not confirm offline execution',502);}
        const chunks:Buffer[]=[];let length=0;
        for await(const chunk of incoming){length+=chunk.length;if(length>limit)throw new StoreError('Processing response exceeds limit',502);chunks.push(chunk);}
        resolve(JSON.parse(Buffer.concat(chunks,length).toString('utf8')));
      }catch(error){reject(error);}
    });
    outgoing.on('error',error=>{if(!rejected.signal.aborted)reject(error);});
    void (async()=>{
      let sent=0;
      if(input.body)for await(const chunk of input.body){if(rejected.signal.aborted)return;bodySignal.throwIfAborted();sent+=chunk.length;if(!outgoing.write(chunk))await once(outgoing,'drain',{signal:bodySignal});}
      if(rejected.signal.aborted)return;
      if(headers['Content-Length']!==undefined&&sent!==Number(headers['Content-Length']))throw new StoreError('Local upload size changed',409);
      outgoing.end();
    })().catch(error=>{if(rejected.signal.aborted)return;outgoing.destroy();reject(error);});
  });
}
