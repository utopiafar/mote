#!/usr/bin/env node
// A private connection file contains {url:"https://host/mcp",token:"..."}.
// Stdout is reserved for MCP. Never log the connection or upstream error bodies.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,ListResourceTemplatesRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
const args=process.argv.slice(2),index=args.indexOf('--connection');
if(index<0||!args[index+1]){process.stderr.write('Usage: node scripts/mcp-stdio.mjs --connection /absolute/private-connection.json\n');process.exit(1);}
try{
 const path=resolve(args[index+1]),fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let config;
 try{const metadata=await fd.stat();if(!metadata.isFile()||metadata.size>16384||(process.platform!=='win32'&&((metadata.mode&0o077)||(process.getuid&&metadata.uid!==process.getuid()))))throw Error('Invalid private connection file');config=JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}
 const url=new URL(config.url);
 if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||typeof config.token!=='string'||config.token.length<32||config.token.length>4096||/[\r\n\0]/.test(config.token))throw Error('Invalid private MCP connection');
 const upstream=new Client({name:'mote-stdio-bridge',version:'0.4.0'});
 await upstream.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+config.token},redirect:'error'}}));
 const server=new Server({name:'mote',version:'0.4.0'},{capabilities:{tools:{},resources:{}}});
 const safeRead=operation=>async request=>{try{return await operation(request);}catch{throw new McpError(ErrorCode.InternalError,'Mote read request failed. Check the node and credential scope.');}};
 server.setRequestHandler(ListToolsRequestSchema,safeRead(request=>upstream.listTools(request.params)));
 server.setRequestHandler(CallToolRequestSchema,async request=>{try{return await upstream.callTool(request.params);}catch{return {isError:true,content:[{type:'text',text:'Mote tool request failed. Check the node and credential scope.'}]};}});
 server.setRequestHandler(ListResourcesRequestSchema,safeRead(request=>upstream.listResources(request.params)));
 server.setRequestHandler(ListResourceTemplatesRequestSchema,safeRead(request=>upstream.listResourceTemplates(request.params)));
 server.setRequestHandler(ReadResourceRequestSchema,safeRead(request=>upstream.readResource(request.params)));
 await server.connect(new StdioServerTransport());
 let stopping=false;async function close(){if(stopping)return;stopping=true;await Promise.allSettled([server.close(),upstream.close()]);}
 process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());process.stdin.once('end',()=>void close());
}catch{process.stderr.write('Mote MCP bridge could not start. Check the private connection file, node URL, and MCP token.\n');process.exitCode=1;}
