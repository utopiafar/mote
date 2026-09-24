import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createReadStream,copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,renameSync,rmSync,statSync,writeFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {StoreError} from './store.js';

type Role='ocr'|'dialogue';
type Item={name:string;size:number;sha256:string;official:string;mirror?:string;extract?:{entry:string;destination:string;kind:'tar'|'bz2'}};
const hf='536b0662742c02347bc0e980a01041f333bce120';
const hfFile=(name:string,mirror=false)=>`https://${mirror?'hf-mirror.com':'huggingface.co'}/Systran/faster-whisper-small/resolve/${hf}/${name}`;
const paddle='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0';
const sherpa='https://github.com/k2-fsa/sherpa-onnx/releases/download';
export const MEDIA_CATALOG:Record<Role,{version:string;files:Item[]}>= {
  ocr:{version:'pp-ocrv5-mobile-onnx-1',files:[
    {name:'det.tar',size:4843520,sha256:'781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',official:`${paddle}/PP-OCRv5_mobile_det_onnx_infer.tar`,extract:{kind:'tar',entry:'PP-OCRv5_mobile_det_onnx_infer/inference.onnx',destination:'det/inference.onnx'}},
    {name:'rec.tar',size:16701440,sha256:'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c',official:`${paddle}/PP-OCRv5_mobile_rec_onnx_infer.tar`,extract:{kind:'tar',entry:'PP-OCRv5_mobile_rec_onnx_infer/inference.onnx',destination:'rec/inference.onnx'}},
  ]},
  dialogue:{version:'faster-whisper-small-sherpa-1',files:[
    {name:'config.json',size:2370,sha256:'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828',official:hfFile('config.json'),mirror:hfFile('config.json',true)},
    {name:'model.bin',size:483546902,sha256:'3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',official:hfFile('model.bin'),mirror:hfFile('model.bin',true)},
    {name:'tokenizer.json',size:2203239,sha256:'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab',official:hfFile('tokenizer.json'),mirror:hfFile('tokenizer.json',true)},
    {name:'vocabulary.txt',size:459861,sha256:'34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913',official:hfFile('vocabulary.txt'),mirror:hfFile('vocabulary.txt',true)},
    {name:'segmentation.tar.bz2',size:6958444,sha256:'24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488',official:`${sherpa}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2`,extract:{kind:'bz2',entry:'sherpa-onnx-pyannote-segmentation-3-0/model.onnx',destination:'segmentation.onnx'}},
    {name:'speaker.onnx',size:39593761,sha256:'1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',official:`${sherpa}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`},
  ]},
};
const safeUrl=(url:string)=>{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.hostname==='localhost'||u.hostname.startsWith('127.')||u.hostname.endsWith('.local'))throw new Error('Invalid model source');return u.toString();};
const sha256File=async(path:string)=>{const hash=createHash('sha256');for await(const block of createReadStream(path))hash.update(block);return hash.digest('hex');};
type Progress={role:Role;state:'downloading'|'verifying'|'installing'|'ready'|'failed';bytes:number;totalBytes:number;source:string;error?:string};
export class MediaAssets {
  private active=new Map<Role,Progress>();
  constructor(readonly root:string){mkdirSync(root,{recursive:true,mode:0o700});}
  path(role:Role){return join(this.root,role);}
  ready(role:Role){const m=MEDIA_CATALOG[role],root=this.path(role),path=join(root,'complete.json');try{
    if(JSON.parse(readFileSync(path,'utf8')).version!==m.version)return false;
    return role==='ocr'?['det/inference.onnx','det/inference.yml','rec/inference.onnx','rec/inference.yml'].every(name=>existsSync(join(root,name))):['model.bin','config.json','tokenizer.json','vocabulary.txt','segmentation.onnx','speaker.onnx'].every(name=>existsSync(join(root,name)));
  }catch{return false;}}
  status(role:Role){const m=MEDIA_CATALOG[role],active=this.active.get(role),totalBytes=m.files.reduce((sum,file)=>sum+file.size,0);return active?{...active,version:m.version}:{role,state:this.ready(role)?'ready':'not_installed',bytes:this.ready(role)?totalBytes:0,totalBytes,source:'',version:m.version};}
  statuses(){return {ocr:this.status('ocr'),dialogue:this.status('dialogue')};}
  install(role:Role,source:'auto'|'official'|'mirror'='auto'){
    if(this.active.get(role)?.state==='downloading'||this.active.get(role)?.state==='installing')throw new StoreError('Model installation is already running',409);
    if(this.ready(role))return this.status(role);
    const totalBytes=MEDIA_CATALOG[role].files.reduce((sum,file)=>sum+file.size,0),progress:Progress={role,state:'downloading',bytes:0,totalBytes,source};this.active.set(role,progress);
    void this.perform(role,source,progress).catch(()=>{progress.state='failed';progress.error='model_install_failed';});
    return progress;
  }
  async importBundle(role:Role,directory:string){
    if(this.active.get(role)?.state==='downloading'||this.active.get(role)?.state==='installing')throw new StoreError('Model installation is already running',409);
    const catalog=MEDIA_CATALOG[role],cache=join(this.root,`${role}.downloads`),progress:Progress={role,state:'verifying',bytes:0,totalBytes:catalog.files.reduce((sum,file)=>sum+file.size,0),source:'local-import'};
    this.active.set(role,progress);mkdirSync(cache,{recursive:true,mode:0o700});
    try{
      for(const item of catalog.files){const input=join(directory,item.name),stat=lstatSync(input);if(!stat.isFile()||stat.size!==item.size||await sha256File(input)!==item.sha256)throw new Error(`Invalid model asset: ${item.name}`);
        copyFileSync(input,join(cache,item.name));progress.bytes+=item.size;}
      progress.state='installing';progress.bytes=0;await this.perform(role,'official',progress);return this.status(role);
    }catch(error){progress.state='failed';progress.error=error instanceof Error?error.message:'model_import_failed';throw error;}
  }
  private async perform(role:Role,source:'auto'|'official'|'mirror',progress:Progress){
    const catalog=MEDIA_CATALOG[role],staging=join(this.root,`${role}.${randomUUID()}.install`),cache=join(this.root,`${role}.downloads`);
    mkdirSync(staging,{recursive:true,mode:0o700});mkdirSync(cache,{recursive:true,mode:0o700});
    try{
      for(const item of catalog.files){
        const target=join(cache,item.name);await this.download(item,target,source,progress);
        if(item.extract){
          const output=join(staging,item.extract.destination);mkdirSync(dirname(output),{recursive:true,mode:0o700});
          const flag=item.extract.kind==='bz2'?'-xOjf':'-xOf';
          const bytes=execFileSync('tar',[flag,target,item.extract.entry],{maxBuffer:128*1024*1024,timeout:120000});
          if(bytes.length===0||bytes.length>96*1024*1024)throw new Error('Invalid model archive');writeFileSync(output,bytes,{mode:0o600});
          if(role==='ocr'){
            const config=execFileSync('tar',['-xOf',target,item.extract.entry.replace('inference.onnx','inference.yml')],{maxBuffer:1024*1024,timeout:120000});
            if(config.length===0||config.length>1024*1024)throw new Error('Invalid OCR model configuration');
            writeFileSync(join(dirname(output),'inference.yml'),config,{mode:0o600});
          }
        }else{const output=join(staging,item.name);renameSync(target,output);}
      }
      progress.state='installing';
      const marker=join(staging,'complete.json');writeFileSync(marker,JSON.stringify({version:catalog.version,installedAt:new Date().toISOString()}),{mode:0o600});const fd=openSync(marker,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      const prior=this.path(role),old=join(this.root,`${role}.${randomUUID()}.old`),hadPrior=existsSync(prior);
      if(hadPrior)renameSync(prior,old);
      try{renameSync(staging,prior);}catch(error){if(hadPrior)renameSync(old,prior);throw error;}
      rmSync(old,{recursive:true,force:true});progress.state='ready';progress.bytes=progress.totalBytes;
    }finally{rmSync(staging,{recursive:true,force:true});}
  }
  private async download(item:Item,target:string,source:'auto'|'official'|'mirror',progress:Progress){
    if(existsSync(target)&&statSync(target).size===item.size&&await sha256File(target)===item.sha256){progress.bytes+=item.size;return;}
    rmSync(target,{force:true});
    const choices=source==='official'?[item.official]:source==='mirror'?[item.mirror??item.official]:[item.mirror??item.official,item.official];
    let last:unknown;const completed=progress.bytes;
    for(const candidate of [...new Set(choices)])try{
      const partial=target+'.part';let offset=existsSync(partial)?statSync(partial).size:0;if(offset>item.size){rmSync(partial,{force:true});offset=0;}
      let url=safeUrl(candidate);let response:Response|undefined;
      for(let redirect=0;redirect<6;redirect++){
        response=await fetch(url,{headers:offset?{Range:`bytes=${offset}-`}:{},redirect:'manual',signal:AbortSignal.timeout(60*60*1000)});
        if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('Model redirect is missing');url=safeUrl(new URL(location,url).toString());continue;}break;
      }
      if(!response||!response.ok)throw Error('Model source unavailable');
      if(offset&&response.status!==206){rmSync(partial,{force:true});offset=0;}
      const handle=openSync(partial,offset?'a':'w',0o600);let received=offset;progress.bytes=Math.min(progress.totalBytes,completed+offset);
      try{if(!response.body)throw Error('Empty model response');const reader=response.body.getReader();try{for(;;){const {done,value:bytes}=await reader.read();if(done)break;received+=bytes.length;if(received>item.size)throw Error('Model exceeds expected size');writeFileSync(handle,bytes);progress.bytes=Math.min(progress.totalBytes,completed+received);progress.source=new URL(candidate).hostname;}}finally{reader.releaseLock();}}finally{closeSync(handle);}
      progress.state='verifying';if(received!==item.size||await sha256File(partial)!==item.sha256)throw Error('Model checksum mismatch');renameSync(partial,target);progress.state='downloading';return;
    }catch(error){last=error;progress.state='downloading';progress.bytes=completed;if(error instanceof Error&&/checksum mismatch|exceeds expected size/.test(error.message))rmSync(target+'.part',{force:true});}
    throw last??Error('Model download failed');
  }
}
