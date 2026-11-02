import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {buildApp} from '../../apps/server/src/app.ts';

const repository=new URL('../..',import.meta.url).pathname;

export class HttpError extends Error{
  constructor(status,code,body,url){
    super(`${code} (${status}) at ${url}`);
    this.name='HttpError';this.status=status;this.code=code;this.body=body;this.url=url;
  }
}

export function candidateSha(){
  if(process.env.MOTE_CANDIDATE_SHA)return process.env.MOTE_CANDIDATE_SHA;
  return execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
}

export async function requestJson(baseUrl,path,{method='GET',body,token,headers={}}={}){
  const url=new URL(path,baseUrl.endsWith('/')?baseUrl:baseUrl+'/').toString();
  const merged={Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers,...(body===undefined?{}:{'Content-Type':'application/json'})};
  const response=await fetch(url,{method,headers:merged,...(body===undefined?{}:{body:JSON.stringify(body)})});
  const raw=Buffer.from(await response.arrayBuffer()),text=raw.toString('utf8');
  let parsed;try{parsed=text?JSON.parse(text):undefined;}catch{parsed=text;}
  if(!response.ok)throw new HttpError(response.status,parsed?.error??'http_error',parsed,url);
  return parsed;
}

function configFor(dataDir,token){
  return {dataDir,token,tokenPath:'generated-fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,
    retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
}

/** One real Central process surface, owned by the generated fixture directory. */
export async function createPrivateRun({root,version='1',dataDir,token,backgroundWorker=false,distribution}={}){
  const ownsDataDir=dataDir===undefined;
  const directory=dataDir??(root?join(root,`run-${randomUUID()}`):mkdtempSync(join(tmpdir(),'mote-native-plugin-run-')));
  if(root&&!dataDir)mkdirSync(directory,{recursive:true,mode:0o700});
  const actualToken=token??randomBytes(32).toString('hex'),runId=randomUUID(),sha=candidateSha();
  let node;
  async function start(){
    let candidate;
    try{
      candidate=await buildApp(configFor(directory,actualToken),{backgroundWorker,...(distribution?{distribution}:{})});
      const baseUrl=await candidate.app.listen({host:'127.0.0.1',port:0});
      node=candidate;
      return baseUrl;
    }catch(error){
      try{await candidate?.app.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native plugin run startup and cleanup failed',{cause:error});}
      throw error;
    }
  }
  let baseUrl;
  try{baseUrl=await start();}
  catch(error){
    if(ownsDataDir)rmSync(directory,{recursive:true,force:true});
    throw error;
  }
  const run={
    runId,candidateSha:sha,version,dataDir:directory,token:actualToken,
    get url(){return baseUrl;},
    get node(){return node;},
    metadata(){return {runId,candidateSha:sha,version};},
    request(path,options={}){return requestJson(baseUrl,path,{token:actualToken,...options});},
    async writeNote(note){return this.request('/api/notes',{method:'POST',body:note});},
    async readNote(id){return this.request('/api/notes/'+encodeURIComponent(id));},
    async restart(){
      await node.app.close();
      baseUrl=await start();
      return this;
    },
    async close({remove=ownsDataDir}={}){
      try{await node?.app.close();}finally{if(remove)rmSync(directory,{recursive:true,force:true});}
    }
  };
  return run;
}

/** Two independently owned runs; the caller gets only their own cleanup. */
export async function createTwoRuns({versions=['1','2'],backgroundWorker=false}={}){
  const root=mkdtempSync(join(tmpdir(),'mote-native-plugin-pair-'));
  const runs=[];
  try{
    for(const version of versions)runs.push(await createPrivateRun({root,version,backgroundWorker}));
    return {root,runs,runId:randomUUID(),candidateSha:candidateSha(),
      async close(){
        const results=await Promise.allSettled(runs.map(run=>run.close({remove:true})));
        rmSync(root,{recursive:true,force:true});
        const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
        if(errors.length)throw new AggregateError(errors,'Native plugin run cleanup failed');
      }};
  }catch(error){
    const results=await Promise.allSettled(runs.map(run=>run.close({remove:true})));
    rmSync(root,{recursive:true,force:true});
    const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
    if(errors.length)throw new AggregateError([error,...errors],'Native plugin run setup and cleanup failed',{cause:error});
    throw error;
  }
}

export function generatedNote(seed,{deviceId='generated-native-device',deviceName='Generated native device'}={}){
  const id=randomUUID(),text=`Generated native plugin ${seed} ${randomUUID()} original`;
  return {id,deviceId,deviceName,platform:'import',capturedAt:new Date().toISOString(),text};
}
