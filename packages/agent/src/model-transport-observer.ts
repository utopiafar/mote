import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {providerHttpFailure} from '@mote/shared';
import {AgentProviderError} from './types.js';
/** Host-private transport reporting. No body, endpoint or credential is accepted.
 * This is not registered as a model tool. The host owns subsequent retry. */
export async function observeModelTransport(){
 const token=randomBytes(32).toString('hex');let reject!:(error:AgentProviderError)=>void;
 const failure=new Promise<never>((_,fail)=>reject=fail);void failure.catch(()=>{});
 const server=createServer(async(req,res)=>{
  const auth=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+token);
  if(req.method!=='POST'||req.url!=='/failure'||auth.length!==expected.length||!timingSafeEqual(auth,expected)){res.writeHead(403).end();return;}
  try{let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024)throw Error();}const value=JSON.parse(text);
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['status','retryAfter'].includes(k))||!Number.isInteger(value.status)||value.status<0||value.status>599||value.status>0&&value.status<300||value.retryAfter!==undefined&&(typeof value.retryAfter!=='string'||value.retryAfter.length>128))throw Error();
   res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');
   reject(new AgentProviderError(value.status===0?{category:'transient',code:'provider_network'}:providerHttpFailure(value.status,value.retryAfter)));
  }catch{res.writeHead(400).end();}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address();if(!address||typeof address==='string')throw Error('Transport observer unavailable');
 return {configuration:{url:'http://127.0.0.1:'+address.port+'/failure',token},failure,close:()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})};
}
