import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
const dataDir=await mkdtemp(join(tmpdir(),'mote-item-history-'));
const token='generated-item-history-fixture-token';
const config:Config={dataDir,token,tokenPath:'generated-only',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No fixture model')},close:async()=>{}}});
const lost=new Set<string>();
const proxy=createServer((req,res)=>{void(async()=>{
 if(req.headers.authorization!=='Bearer '+token || !/^\/api\/(sources|file-sync\/v1|capture-browser|files)(\/|\?|$)/.test(req.url??'')){res.writeHead(403).end();return;}
 const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
 const bytes=Buffer.concat(chunks);
 const response=await node.app.inject({method:req.method as 'GET',url:req.url!,headers:{authorization:'Bearer '+token,'content-type':req.headers['content-type']??'application/json','x-mote-ingress-version':'2'},payload:bytes.length?bytes:undefined});
 let value:any;try{value=response.json()}catch{}
 const receipt=value?.receipt;
 const lose=receipt?.state==='received'&&!lost.has(receipt.id);
 if(lose)lost.add(receipt.id);
 res.setHeader('content-type',response.headers['content-type']??'application/json');
 res.writeHead(lose?503:response.statusCode).end(lose?'{}':response.rawPayload);
 console.log(JSON.stringify({path:req.url,status:response.statusCode,returnedStatus:lose?503:response.statusCode,duplicate:receipt?.duplicate}));
})().catch(e=>{console.error(e);res.writeHead(500).end();process.exitCode=1})});
await new Promise<void>(done=>proxy.listen(47890,'127.0.0.1',done));console.log('Generated item fixture ready 47890');
async function close(){proxy.closeAllConnections();await new Promise<void>(done=>proxy.close(()=>done()));await node.app.close();await rm(dataDir,{recursive:true,force:true});process.exit(process.exitCode??0)}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
