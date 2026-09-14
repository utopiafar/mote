/** Interpret endpoint configuration as data; never execute command/args from imported JSON. */
export function parseMcpConnection(value) {
  const fail=()=>{throw Error('Invalid private MCP connection');};
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  let url,token;
  if(Object.keys(value).sort().join(',')==='token,url')({url,token}=value);
  else {
    if(Object.keys(value).join(',')!=='mcpServers'||!value.mcpServers||Object.keys(value.mcpServers).join(',')!=='mote')return fail();
    const server=value.mcpServers.mote;
    if(!server||Object.keys(server).sort().join(',')!=='headers,type,url'||server.type!=='http'||!server.headers||Object.keys(server.headers).join(',')!=='Authorization'||typeof server.headers.Authorization!=='string'||!server.headers.Authorization.startsWith('Bearer '))return fail();
    url=server.url;token=server.headers.Authorization.slice(7);
  }
  if(typeof url!=='string'||url.length>2048||url!==url.trim()||/[\s\\\u0000-\u001f\u007f]/u.test(url)||typeof token!=='string'||token.length<32||token.length>4096||/[\r\n\0]/.test(token))return fail();
  let endpoint;try{endpoint=new URL(url);}catch{return fail();}
  if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!(endpoint.protocol==='https:'||(endpoint.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))))return fail();
  return {url:endpoint.href,token};
}
