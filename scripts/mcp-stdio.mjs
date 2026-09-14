#!/usr/bin/env node
// Accept a private legacy {url,token} file or the HTTP JSON exported by the central UI.
// Stdout is reserved for MCP. Never log the connection or upstream error bodies.
import {open,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {parseMcpConnection} from './mcp-connection.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ReadResourceRequestSchema,ListResourceTemplatesRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
const args=process.argv.slice(2),index=args.indexOf('--connection');
if(index<0||!args[index+1]){process.stderr.write('Usage: node scripts/mcp-stdio.mjs --connection /absolute/private-connection.json\n');process.exit(1);}
try{
 const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
 const path=resolve(args[index+1]),fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let config;
 try{const metadata=await fd.stat();if(!metadata.isFile()||metadata.size>16384||(process.platform!=='win32'&&((metadata.mode&0o077)||(process.getuid&&metadata.uid!==process.getuid()))))throw Error('Invalid private connection file');config=JSON.parse(await fd.readFile('utf8'));}finally{await fd.close();}
 config=parseMcpConnection(config);const url=new URL(config.url);
 const upstream=new Client({name:'mote-stdio-bridge',version});
 await upstream.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:'Bearer '+config.token},redirect:'error'}}));
 const server=new Server({name:'mote',version},{capabilities:{tools:{},resources:{}}});
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
