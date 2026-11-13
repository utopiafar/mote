// Sidecars read the same mounted YAML, then isolate the inference environment.
import {resolve,join} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {readConfigDocument} from '../packages/shared/src/config-file.ts';
import {mediaWorkerArguments,mediaWorkerEnvironment,spawnMediaProcess} from './media-workers.mjs';
const deploymentRole=process.argv[2],role=deploymentRole==='asr'?'dialogue':deploymentRole;
if(!['ocr','asr','local-image'].includes(deploymentRole)||!process.env.MOTE_CONFIG_FILE)throw Error('A worker role and MOTE_CONFIG_FILE are required');
// MLX is a Native Apple Silicon resource, never a Linux/CUDA sidecar backend.
if(role==='local-image'&&(process.platform!=='darwin'||process.arch!=='arm64'))throw Error('media.runtime.unsupported_platform');
const loaded=readConfigDocument(process.env.MOTE_CONFIG_FILE),media=loaded.document.media??{};
const port=role==='ocr'?media.ocrPort:role==='dialogue'?media.asrPort:media.localImagePort;
if(!media.modelDirectory||!media.workerToken||port===undefined||port===null||port===''){
  const idle=setInterval(()=>{},60000);
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>clearInterval(idle));
}else{
  // Compose supplies a role-specific bundled interpreter. Native uses the
  // explicitly configured Python; this never changes the system PATH/Python.
  const selected=process.argv[3]??media.python??'python3';
  const python=/[\\/]/.test(selected)?resolve(loaded.baseDir,selected):selected;
  const home=await mkdtemp(join(tmpdir(),`mote-${role}-worker-`));
  try{
    const args=mediaWorkerArguments(role,{repository:process.cwd(),...media,modelDirectory:resolve(loaded.baseDir,media.modelDirectory)});
    const worker=spawnMediaProcess(python,args,{cwd:process.cwd(),env:mediaWorkerEnvironment(home,python,media.workerToken)});
    const stop=()=>{void worker.close().catch(()=>{process.exitCode=1;});};
    for(const signal of ['SIGTERM','SIGINT'])process.once(signal,stop);
    try{await worker.done;process.exitCode=worker.error?1:worker.child.exitCode??1;}
    finally{for(const signal of ['SIGTERM','SIGINT'])process.off(signal,stop);await worker.close();}
  }finally{await rm(home,{recursive:true,force:true});}
}
