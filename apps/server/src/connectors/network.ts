import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {ConnectorError} from './types.js';

const loopback=(ip:string)=>ip==='::1'||isIP(ip)===4&&ip.startsWith('127.');
export function publicAddress(ip:string):boolean {
  if(isIP(ip)===4){const [a,b,c]=ip.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===88&&c===99)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113||a>=224);}
  // IPv4 mapped forms and special-purpose IPv6 ranges are never treated as public targets.
  const value=ip.toLowerCase();return isIP(ip)===6&&!value.startsWith('::')&&!value.startsWith('fc')&&!value.startsWith('fd')&&!/^fe[89ab]/.test(value)&&!value.startsWith('ff')&&!value.startsWith('2001:db8')&&!value.startsWith('64:ff9b:')&&!value.startsWith('2002:')&&!/^2001:(?:0:|::)/.test(value);
}
export function remoteUrl(raw:string,allowLocal=false):URL {
  let url:URL;try{url=new URL(raw);}catch{throw new ConnectorError('mcp_endpoint_invalid');}
  const host=url.hostname.replace(/^\[|\]$/g,'');
  if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||url.protocol==='http:'&&!(allowLocal&&(host==='localhost'||loopback(host))))throw new ConnectorError('mcp_endpoint_invalid');
  return url;
}
/** Every connection uses the address actually validated here, preventing DNS rebinding and redirects. */
export function restrictedFetch(endpoint:URL,allowLocal=false):typeof fetch {
  return (async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=new URL(input instanceof Request?input.url:input.toString());
    if(url.origin!==endpoint.origin||url.pathname!==endpoint.pathname||url.search||url.hash)throw new ConnectorError('mcp_redirect_rejected',502);
    const host=url.hostname.replace(/^\[|\]$/g,'');
    const records=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true});
    if(!records.length||records.some(r=>!publicAddress(r.address)&&!(allowLocal&&loopback(r.address))))throw new ConnectorError('mcp_address_rejected',502);
    const selected=records[0],headers=new Headers(init?.headers);let length=0;
    // MCP requests are bounded JSON. Remote servers cannot ask this transport to upload files.
    const body=init?.body;if(body!==undefined&&body!==null&&typeof body!=='string'&&!(body instanceof Uint8Array))throw new ConnectorError('mcp_body_invalid');
    if(body&&Buffer.byteLength(body)>256*1024)throw new ConnectorError('mcp_body_too_large',413);
    return await new Promise<Response>((resolve,reject)=>{
      const outgoing:Record<string,string>={};headers.forEach((value,key)=>{outgoing[key]=value;});
      const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
        method:init?.method??'GET',headers:outgoing,
        lookup:((_name:unknown,options:unknown,cb:(error:null,address:unknown,family?:number)=>void)=>{
          if((options as {all?:boolean})?.all)cb(null,[selected]);else cb(null,selected.address,selected.family);
        }) as never,
      },res=>{
        const status=res.statusCode??502;
        if(status>=300&&status<400){res.destroy();reject(new ConnectorError('mcp_redirect_rejected',502));return;}
        if(status<200||status>599){res.destroy();reject(new ConnectorError('mcp_response_invalid',502));return;}
        const chunks:Buffer[]=[];
        res.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>2*1024*1024){res.destroy();reject(new ConnectorError('mcp_response_too_large',413));}else chunks.push(chunk);});
        res.on('error',()=>reject(new ConnectorError('mcp_network_error',502)));
        res.on('end',()=>{
          // Event handlers run after the Promise executor; protocol conversion errors must reject, never escape and crash the node.
          try{const responseHeaders=new Headers();for(const [key,value]of Object.entries(res.headers))if(value!==undefined)responseHeaders.set(key,Array.isArray(value)?value.join(', '):value);resolve(new Response([204,205,304].includes(status)?null:Buffer.concat(chunks),{status,headers:responseHeaders}));}
          catch{reject(new ConnectorError('mcp_response_invalid',502));}
        });
      });
      const abort=()=>req.destroy(new Error('aborted'));
      if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});
      req.setTimeout(20000,()=>req.destroy(new Error('timeout')));
      const deadline=setTimeout(()=>req.destroy(new Error('timeout')),20000);
      req.on('error',()=>reject(new ConnectorError('mcp_network_error',502)));
      req.on('close',()=>{clearTimeout(deadline);init?.signal?.removeEventListener('abort',abort);});
      req.end(body??undefined);
    });
  }) as typeof fetch;
}
