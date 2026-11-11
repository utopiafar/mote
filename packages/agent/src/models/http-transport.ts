import {AsyncResource} from 'node:async_hooks';
import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {ProviderFailure,providerHttpFailure} from '@mote/shared';
import {AgentProviderError,type AgentOptions} from '../types.js';

type FetchTransport = typeof fetch;
type TransportConfiguration = Pick<AgentOptions,'protocol'|'provider'|'reasoningEffort'|'headers'|'extraBody'> & {baseUrl:string};
type FailureReport = {status:number;retryAfter?:string};

/** Bound decoded provider bytes before the SDK buffers SSE or error bodies.
 * A token parameter and wall-clock timeout do not constrain a hostile response.
 * The limit covers retries and repair turns in this isolated agent process. */
export function boundedModelFetch(transport:FetchTransport,bridge:string,maximumBytes=32*1024*1024,configuration?:TransportConfiguration,reportFailure?:(value:FailureReport)=>void|Promise<void>,authorizeRequest?:()=>void|Promise<void>){
  let received=0;
  let exceeded=false;
  const tooLarge=()=>new Error('Model response exceeds the agent byte budget');
  return async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=input instanceof Request?input.url:String(input);
    // Bridge responses already have their own authenticated evidence byte budget.
    if(url.startsWith(bridge+'/'))return transport(input,init);
    if(exceeded)throw tooLarge();
    // Redirects can forward personal evidence to a destination the owner never
    // selected. SSE is the only enabled SDK transport, so this covers every turn.
    let requestInit:RequestInit={...init,redirect:'manual'};
    if(configuration){
      const destination=new URL(url),base=new URL(configuration.baseUrl);
      const prefix=base.pathname.replace(/\/+$/,'');
      const method=init?.method??(input instanceof Request?input.method:'GET');
      if(destination.origin!==base.origin||(destination.pathname!==prefix&&!destination.pathname.startsWith(prefix+'/'))||method.toUpperCase()!=='POST')throw new Error('Unexpected model transport destination');
      // Mote has no remote-file retention contract. The native adapter catches
      // file-resolution failures and sends the already-authorized image inline.
      // Refuse before I/O, request admission, or multipart body consumption.
      if(configuration.protocol==='deepseek'&&destination.pathname===prefix+(prefix.endsWith('/v1')?'/files':'/v1/files'))throw new Error('Mote sends DeepSeek images inline without remote file storage');
      if(configuration.protocol==='deepseek'&&destination.pathname!==prefix+(prefix.endsWith('/v1')?'/messages':'/v1/messages'))throw new Error('Unexpected model transport destination');
      const headers=new Headers(input instanceof Request?input.headers:undefined);
      new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
      if(configuration.provider==='azure-openai'){
        headers.delete('authorization');
        headers.set('api-key',process.env.MOTE_MODEL_API_KEY as string);
      }
      for(const [key,value] of Object.entries(configuration.headers??{}))headers.set(key,value);
      const raw=init?.body??(input instanceof Request?await input.clone().text():undefined);
      if(typeof raw!=='string')throw new Error('Model request must contain a JSON body');
      const body=JSON.parse(raw);
      if(configuration.protocol==='deepseek'&&configuration.reasoningEffort==='auto'){
        // The adapter cannot omit its own defaults. Remove only those
        // defaults before applying the owner's explicitly supplied parameters.
        delete body.thinking;
        delete body.reasoning_effort;
        if(body.output_config){
          delete body.output_config.effort;
          if(!Object.keys(body.output_config).length)delete body.output_config;
        }
      }
      // MiniMax's default inline <think> output would mix reasoning into the
      // final JSON. This changes wire format only, not whether the model thinks.
      if(configuration.provider==='minimax'&&configuration.protocol==='openai-completions')body.reasoning_split=true;
      const merge=(base:Record<string,unknown>,extra:Record<string,unknown>):Record<string,unknown>=>{
        const result={...base};
        for(const [key,value] of Object.entries(extra))result[key]=value&&typeof value==='object'&&!Array.isArray(value)&&result[key]&&typeof result[key]==='object'&&!Array.isArray(result[key])?merge(result[key] as Record<string,unknown>,value as Record<string,unknown>):value;
        return result;
      };
      const customized=merge(body,configuration.extraBody??{});
      // Defense in depth: profile changes cannot add upload metadata to evidence requests.
      if(configuration.protocol==='deepseek'){delete customized.dsh_session_log;delete customized.dsh_plugin_packages;}
      if(configuration.protocol==='openai-responses')customized.store=false;
      headers.delete('content-length');
      requestInit={...requestInit,headers,body:JSON.stringify(customized)};
    }
    await authorizeRequest?.();
    let response:Response;
    try{response=await transport(input,requestInit);}catch(error){if(reportFailure&&!requestInit.signal?.aborted)await reportFailure({status:0});throw error;}
    if(reportFailure&&!response.ok){
      await response.body?.cancel();
      const retryAfter=response.headers.get('retry-after');
      await reportFailure({status:response.status,...(retryAfter&&retryAfter.length<=128?{retryAfter}:{})});
      // Suppress opaque SDK retries. The durable host received the real status.
      return new Response(JSON.stringify({error:{message:'Model request stopped by host'}}),{status:400,headers:{'Content-Type':'application/json'}});
    }
    if(response.status>=300&&response.status<400){
      await response.body?.cancel();
      // A deterministic refusal avoids the SDK treating a redirect as a
      // transient network exception and repeatedly resending the same evidence.
      return new Response(JSON.stringify({error:{message:'Model redirects are not allowed'}}),{status:400,headers:{'Content-Type':'application/json'}});
    }
    if(!response.body)return response;
    const reader=response.body.getReader();
    const body=new ReadableStream({
      async pull(controller){
        try{
          const {done,value}=await reader.read();
          if(done){reader.releaseLock();controller.close();return;}
          received+=value.byteLength;
          if(received>maximumBytes){
            exceeded=true;
            await reader.cancel().catch(()=>undefined);
            reader.releaseLock();
            controller.error(tooLarge());
            return;
          }
          controller.enqueue(value);
        }catch(error){controller.error(error);}
      },
      async cancel(reason){try{await reader.cancel(reason);}finally{reader.releaseLock();}},
    });
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}

export function modelFailureReporter(transport:FetchTransport){
  const configured=process.env.MOTE_MODEL_OBSERVER;if(!configured)return undefined;
  const {url,token}=JSON.parse(configured) as {url:string;token:string};
  return async(value:FailureReport)=>{const response=await transport(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(value),redirect:'error',signal:AbortSignal.timeout(5000)});await response.body?.cancel();if(!response.ok)throw Error('Host transport observer unavailable');};
}

export function modelRequestAuthorization(transport:FetchTransport){
  const configured=process.env.MOTE_MODEL_OBSERVER;if(!configured)return undefined;
  const {authorizationUrl,token}=JSON.parse(configured) as {authorizationUrl?:string;token:string};if(!authorizationUrl)return undefined;
  return async()=>{const response=await transport(authorizationUrl,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:'{}',redirect:'error',signal:AbortSignal.timeout(5000)});await response.body?.cancel();if(!response.ok)throw Error('Host model evidence authorization denied');};
}

/** Host-private transport reporting. No body, endpoint or credential is accepted.
 * This is not registered as a model tool. The host owns subsequent retry. */
export async function observeModelTransport(authorize?:()=>void|Promise<void>){
 const authorization=authorize?AsyncResource.bind(authorize):undefined;
 const token=randomBytes(32).toString('hex');let reject!:(error:AgentProviderError)=>void;
 const failure=new Promise<never>((_,fail)=>reject=fail);void failure.catch(()=>{});
 const server=createServer(async(req,res)=>{
  const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
  if(req.method!=='POST'||!['/failure','/authorize'].includes(req.url??'')||auth.length!==expected.length||!timingSafeEqual(auth,expected)){res.writeHead(403).end();return;}
  try{let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024)throw Error();}const value=JSON.parse(text);
   if(req.url==='/authorize'){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==0)throw Error();
    try{await authorization?.();res.writeHead(200).end();}catch(error){res.writeHead(409).end();reject(error instanceof ProviderFailure?new AgentProviderError(error.details):new AgentProviderError({category:'blocked',code:'context_evidence_restricted'}));}return;
   }
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['status','retryAfter'].includes(k))||!Number.isInteger(value.status)||value.status<0||value.status>599||value.status>0&&value.status<300||value.retryAfter!==undefined&&(typeof value.retryAfter!=='string'||value.retryAfter.length>128))throw Error();
   res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');
   reject(new AgentProviderError(value.status===0?{category:'transient',code:'provider_network'}:providerHttpFailure(value.status,value.retryAfter),{source:'http',stage:'model',...(value.status?{httpStatus:value.status}:{code:'unknown'})}));
  }catch{res.writeHead(400).end();}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw Error('Transport observer unavailable');
 return {configuration:{url:'http://127.0.0.1:'+address.port+'/failure',authorizationUrl:'http://127.0.0.1:'+address.port+'/authorize',token},failure,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
