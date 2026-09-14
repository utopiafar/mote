import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMcpConnection} from './mcp-connection.mjs';
const token='generated-test-token-'.repeat(3),url='https://fixture.example/mcp';
const exported={mcpServers:{mote:{type:'http',url,headers:{Authorization:'Bearer '+token}}}};
test('stdio accepts the exact exported HTTP MCP JSON and the legacy private format',()=>{
  assert.deepEqual(parseMcpConnection(exported),{url,token});
  assert.deepEqual(parseMcpConnection({url,token}),{url,token});
});
test('imported MCP JSON cannot start processes, inject headers or downgrade the connection',()=>{
  for(const config of [
    {mcpServers:{mote:{command:'sh',args:['-c','do not execute']}}},
    {...exported,command:'sh'},
    {mcpServers:{mote:{...exported.mcpServers.mote,command:'sh'}}},
    {mcpServers:{mote:{...exported.mcpServers.mote,headers:{Authorization:'Bearer '+token,Other:'unexpected'}}}},
    {mcpServers:{...exported.mcpServers,another:exported.mcpServers.mote}},
    {url:'http://public.example/mcp',token},{url:'https://user:password@example.com/mcp',token},{url:url+'?token=secret',token},{url,token:token+'\r\nCookie: secret'},
  ])assert.throws(()=>parseMcpConnection(config),/Invalid private MCP connection/);
});
