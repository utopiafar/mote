import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

// Generated-only loopback fault proxy: Central commits the first request, but its ACK is lost.
const dataDir = await mkdtemp(join(tmpdir(), 'mote-upload-replay-'));
const token = 'generated-upload-history-fixture-token';
const config: Config = {dataDir, token, tokenPath:'generated-only', host:'127.0.0.1', port:0,
 maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,
 allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
 embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const node = await buildApp(config, {backgroundWorker:false, agent:{configured:false,
 query:async()=>{throw Error('No model in this fixture');},close:async()=>{}}});
let requests = 0, identity = '';
const proxy = createServer((req, res) => { void (async () => {
 if (req.method !== 'POST' || req.url !== '/api/captures') { res.writeHead(404).end(); return; }
 const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
 const body = JSON.parse(Buffer.concat(chunks).toString());
 assert.equal(body.ocrText, 'Generated replay original');
 assert.equal(req.headers.authorization, 'Bearer '+token);
 const response = await node.app.inject({method:'POST',url:'/api/captures',headers:{authorization:'Bearer '+token},payload:body});
 assert.ok([200,201].includes(response.statusCode), response.body);
 const receipt = response.json().receipt; requests++;
 if (requests === 1) { identity = receipt.id; assert.equal(receipt.duplicate,false); }
 else { assert.equal(receipt.id,identity); assert.equal(receipt.duplicate,true); }
 res.setHeader('content-type','application/json');
 if (requests === 1) res.writeHead(503).end('{"error":"generated_response_lost_after_commit"}');
 else res.writeHead(response.statusCode).end(response.body);
 console.log(JSON.stringify({requests,committed:true,duplicate:receipt.duplicate,returnedStatus:requests===1?503:response.statusCode}));
 })().catch(error=>{console.error(error);res.writeHead(500).end();process.exitCode=1;}); });
await new Promise<void>(done=>proxy.listen(47888,'127.0.0.1',done));
console.log('Generated upload replay fixture ready on 47888');
async function close() { proxy.closeAllConnections(); await new Promise<void>(done=>proxy.close(()=>done())); await node.app.close(); await rm(dataDir,{recursive:true,force:true}); process.exit(process.exitCode??0); }
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
