import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {constants,createReadStream,copyFileSync,existsSync,fstatSync,lstatSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,openSync,closeSync,fsyncSync,type Stats} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {MEDIA_MODEL_PATHS,MEDIA_MODEL_COMPONENT_PATHS,mediaRoleSchema,type MediaRole,type MediaAssetStatus} from '@mote/shared';
import {FUNASR_MODEL_IDS,FUNASR_SDK_VERSION,FUNASR_SDK_WHEEL_SHA256} from './funasr-contract.js';
import {LOCAL_IMAGE_MODEL} from './local-image-contract.js';
import {StoreError} from './store.js';

export type {MediaRole} from '@mote/shared';
type Item={name:string;size:number;sha256:string;official:string;mirror?:string;extract?:{entry:string;destination:string;kind:'tar'|'bz2'}};
type ModelSource={id:string;repository:string;revision:string;license:string;directory:string;upstream?:string};
type Catalog={version:string;files:Item[];models?:Record<string,ModelSource>};
const paddle='https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0';
const sherpa='https://github.com/k2-fsa/sherpa-onnx/releases/download';
// Immutable repository revisions, upstream sizes/LFS digests, and SHA-256 of
// the exact non-LFS config/tokenizer/code bytes. Never resolve main/master at
// install time. The conversion card has inconsistent base-model metadata; its
// immutable artifact is pinned here, not a claim about model quality/ancestry.
const imageRevision='26328eaab82cdc642fa3b73d8fa0b73db398710d';
const asrRevision='272c57b82523ada6fd87095e955f8e29100979ab';
const hfFile=(repo:string,revision:string,name:string)=>`https://huggingface.co/${repo}/resolve/${revision}/${name}`;
const msFile=(repo:string,revision:string,name:string)=>`https://modelscope.cn/api/v1/models/${repo}/repo?Revision=${revision}&FilePath=${encodeURIComponent(name)}`;
const component=(key:keyof typeof FUNASR_MODEL_IDS)=>relative(MEDIA_MODEL_PATHS.dialogue,MEDIA_MODEL_COMPONENT_PATHS.dialogue[key]);
export const MEDIA_CATALOG:Record<MediaRole,Catalog>={
  'speaker-wespeaker':{version:'wespeaker-zh-cnceleb-resnet34-f86cd6c5',files:[{name:'speaker.onnx',size:26534363,sha256:'f86cd6c509f331f0e20b07bd48d1b2eb7de54202643401c4e84695ac861a0e5a',official:`${sherpa}/speaker-recongition-models/wespeaker_zh_cnceleb_resnet34.onnx`}]},
  ocr:{version:'pp-ocrv5-mobile-onnx-1',files:[
    {name:'det.tar',size:4843520,sha256:'781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30',official:`${paddle}/PP-OCRv5_mobile_det_onnx_infer.tar`,extract:{kind:'tar',entry:'PP-OCRv5_mobile_det_onnx_infer/inference.onnx',destination:'det/inference.onnx'}},
    {name:'rec.tar',size:16701440,sha256:'f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c',official:`${paddle}/PP-OCRv5_mobile_rec_onnx_infer.tar`,extract:{kind:'tar',entry:'PP-OCRv5_mobile_rec_onnx_infer/inference.onnx',destination:'rec/inference.onnx'}},
  ]},
  'local-image':{version:`internvl3-14b-4bit-${imageRevision}`,models:{image:{id:LOCAL_IMAGE_MODEL.id,repository:'mlx-community/InternVL3-14B-4bit',revision:imageRevision,license:'Apache-2.0',directory:'.',upstream:'https://huggingface.co/OpenGVLab/InternVL3-14B'}},files:[
    {name:'added_tokens.json',size:790,sha256:'e66b6bc948dec3421f01a8986f31632cf8d556aaa89f7b39c183b3dd4b5b2c83',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'added_tokens.json')},
    {name:'config.json',size:11356,sha256:'b93f8592285fb1fe2876a7ba63a8dfbae759f8881f4b9f923914cc351da78451',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'config.json')},
    {name:'configuration_intern_vit.py',size:5548,sha256:'22dd687a5f142985407675fc6b1dc688c2ded93e54192543ecf28ef495a6efa8',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'configuration_intern_vit.py')},
    {name:'configuration_internvl_chat.py',size:4036,sha256:'6524e6deae6c318543d1022a599f011120f5a970eaa25f1118e7f5d0e346710c',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'configuration_internvl_chat.py')},
    {name:'conversation.py',size:15309,sha256:'b1b9f280e9cb9211e519e2b8071002b57cc742aadb2f49b05fa674ee3c7d83ee',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'conversation.py')},
    {name:'generation_config.json',size:69,sha256:'6491445090a6da66e04609497396c9d18942e1f0962664d481e8e03e8ae8479b',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'generation_config.json')},
    {name:'model-00001-of-00002.safetensors',size:5341325811,sha256:'d83ad047b71d40457aa403b1e06304394e76432382ba4a8ee11709c807fdb7a9',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'model-00001-of-00002.safetensors')},
    {name:'model-00002-of-00002.safetensors',size:3600584929,sha256:'e60beb55ee0cc2efcb906ab17ab772728e83330fe1f0fcc06032292d70e7f804',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'model-00002-of-00002.safetensors')},
    {name:'model.safetensors.index.json',size:85740,sha256:'7b12a4d54da11279b272d5d2e6b2755e7511fc3a13ae4098ec4a4a4216089886',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'model.safetensors.index.json')},
    {name:'modeling_intern_vit.py',size:18099,sha256:'d3e0f68f29e86be1f3e6e101dc45303ec24e5115e0034de101665972576eb348',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'modeling_intern_vit.py')},
    {name:'modeling_internvl_chat.py',size:15971,sha256:'76fe595f04acd077d168f038a15c697d1c66093a0c000bffb0568dfa90095ba8',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'modeling_internvl_chat.py')},
    {name:'preprocessor_config.json',size:333,sha256:'633b43b3f458893c342956c571dfc3e24dc72d6b97142eb32c8757f12e0dce2c',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'preprocessor_config.json')},
    {name:'special_tokens_map.json',size:613,sha256:'76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'special_tokens_map.json')},
    {name:'tokenizer.json',size:7033297,sha256:'ff61d7c33ad80987e37bcbeeeae7457c8e77d14a43a954fcde7be656fc26d6a9',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'tokenizer.json')},
    {name:'tokenizer_config.json',size:8923,sha256:'a6509924ff6f5ce70752da8a6dfa056154744147faa3a8f1f3614168c2656789',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'tokenizer_config.json')},
    {name:'vocab.json',size:3383407,sha256:'87a257b04b17642a0688c98cd1df89c398bda4fee532d6f88b38a659ecb4ac8d',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'vocab.json')},
    {name:'README.md',size:834,sha256:'aee159cbdccf4e079f87f7b41e92e2c254e52cfa674e79caf9582b893343fb17',official:hfFile('mlx-community/InternVL3-14B-4bit',imageRevision,'README.md')},
  ]},
  dialogue:{version:'funasr-nano-2512-sdk-1.4.25-1',models:{
    asr:{id:FUNASR_MODEL_IDS.asr,repository:FUNASR_MODEL_IDS.asr,revision:asrRevision,license:'Apache-2.0',directory:component('asr')},
    vad:{id:FUNASR_MODEL_IDS.vad,repository:FUNASR_MODEL_IDS.vad,revision:'f9a8b8274674755d925277e27063869038d41515',license:'Apache-2.0',directory:component('vad')},
    speaker:{id:FUNASR_MODEL_IDS.speaker,repository:FUNASR_MODEL_IDS.speaker,revision:'a045b2afcaa9c3049c98a9215a2bc274407ab237',license:'Apache-2.0',directory:component('speaker')},
    punctuation:{id:FUNASR_MODEL_IDS.punctuation,repository:FUNASR_MODEL_IDS.punctuation,revision:'45ab6961ad58a973ce7785401b4e93a0aab907a3',license:'Apache-2.0',directory:component('punctuation')},
  },files:[
    {name:`${component('asr')}/Qwen3-0.6B/config.json`,size:726,sha256:'660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'Qwen3-0.6B/config.json')},
    {name:`${component('asr')}/Qwen3-0.6B/generation_config.json`,size:239,sha256:'2325da0f15bb848e018c5ae071b7943332e9f871d6b60e2ed22ca97d4cb993d2',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'Qwen3-0.6B/generation_config.json')},
    {name:`${component('asr')}/Qwen3-0.6B/merges.txt`,size:1671853,sha256:'8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'Qwen3-0.6B/merges.txt')},
    {name:`${component('asr')}/Qwen3-0.6B/tokenizer.json`,size:11422654,sha256:'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'Qwen3-0.6B/tokenizer.json')},
    {name:`${component('asr')}/Qwen3-0.6B/tokenizer_config.json`,size:9732,sha256:'d5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'Qwen3-0.6B/tokenizer_config.json')},
    {name:`${component('asr')}/Qwen3-0.6B/vocab.json`,size:2776833,sha256:'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'Qwen3-0.6B/vocab.json')},
    {name:`${component('asr')}/config.yaml`,size:3140,sha256:'daed38ea6484f5650fb32cbd9069b9aa13880acaf2bcb1f0bf4be2712837917c',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'config.yaml')},
    {name:`${component('asr')}/configuration.json`,size:398,sha256:'b64a3a55d35bcbe2cf4d31f2d3ef25a423d3ba2ebff203298c27fa055f3c7612',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'configuration.json')},
    {name:`${component('asr')}/model.pt`,size:1971149431,sha256:'55ae0d2fee369f0f11cce0795f6927934ad17cf11b278a7e56a51272074160bb',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'model.pt')},
    {name:`${component('asr')}/multilingual.tiktoken`,size:907395,sha256:'747979631e813193436aabcff7c1c235d37de8097b71c563ec8b63b7a515c718',official:hfFile(FUNASR_MODEL_IDS.asr,asrRevision,'multilingual.tiktoken')},
    // Pin executable model code as well as weights; runtime installation belongs to CORE-02.
    {name:`${component('asr')}/funasr-${FUNASR_SDK_VERSION}-py3-none-any.whl`,size:1015440,sha256:FUNASR_SDK_WHEEL_SHA256,official:'https://files.pythonhosted.org/packages/14/b4/797868730158cafc9c715d61ecffb94c28a3bc59b822bd77a584f264ffde/funasr-1.4.25-py3-none-any.whl'},
    {name:`${component('vad')}/README.md`,size:11567,sha256:'42377011603a186fc2bae41a5cc5e548ebf98d8ec307bbae9dd405f82567f543',official:msFile(FUNASR_MODEL_IDS.vad,'f9a8b8274674755d925277e27063869038d41515','README.md')},
    {name:`${component('vad')}/am.mvn`,size:8040,sha256:'6820fef9687708c4fc3fab2530179c8fcea6262daa25514380056cd8f6eb1754',official:msFile(FUNASR_MODEL_IDS.vad,'f9a8b8274674755d925277e27063869038d41515','am.mvn')},
    {name:`${component('vad')}/config.yaml`,size:1215,sha256:'486861ca26ddb79081663b6179cb204c6bfae71c52f04aafc48a9e9d8dde1e93',official:msFile(FUNASR_MODEL_IDS.vad,'f9a8b8274674755d925277e27063869038d41515','config.yaml')},
    {name:`${component('vad')}/configuration.json`,size:365,sha256:'7bce8867e37d55c3dd8f672695ced18077a2be199ea529a5d432d5350fc0acba',official:msFile(FUNASR_MODEL_IDS.vad,'f9a8b8274674755d925277e27063869038d41515','configuration.json')},
    {name:`${component('vad')}/model.pt`,size:1721366,sha256:'b3be75be477f0780277f3bae0fe489f48718f585f3a6e45d7dd1fbb1a4255fc5',official:msFile(FUNASR_MODEL_IDS.vad,'f9a8b8274674755d925277e27063869038d41515','model.pt')},
    {name:`${component('speaker')}/README.md`,size:6732,sha256:'85e7f149c9d5910da9dbdd4ab5206e33db85e9763107d439a09ef40b004e2f4c',official:msFile(FUNASR_MODEL_IDS.speaker,'a045b2afcaa9c3049c98a9215a2bc274407ab237','README.md')},
    {name:`${component('speaker')}/campplus_cn_common.bin`,size:28036335,sha256:'3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8',official:msFile(FUNASR_MODEL_IDS.speaker,'a045b2afcaa9c3049c98a9215a2bc274407ab237','campplus_cn_common.bin')},
    {name:`${component('speaker')}/config.yaml`,size:537,sha256:'17342041bd5b22f6fd7e32f6e7a267b0bf65f018c0a721bada6547e3d28fbfc9',official:msFile(FUNASR_MODEL_IDS.speaker,'a045b2afcaa9c3049c98a9215a2bc274407ab237','config.yaml')},
    {name:`${component('speaker')}/configuration.json`,size:581,sha256:'6f7acaf1e81ca121f4a3c71b6ddb66beec24350a3ef330e2c846f17829176a8f',official:msFile(FUNASR_MODEL_IDS.speaker,'a045b2afcaa9c3049c98a9215a2bc274407ab237','configuration.json')},
    {name:`${component('punctuation')}/README.md`,size:11561,sha256:'d1f2f3c30db716fb995208608d4305b045f6ef7b7b46a84e7e2d200160df50e0',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','README.md')},
    {name:`${component('punctuation')}/config.yaml`,size:812,sha256:'c5ffb25cd063ed366cb26283908dca05a08ecfef8e90bef1d498ef9ffacd7552',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','config.yaml')},
    {name:`${component('punctuation')}/configuration.json`,size:450,sha256:'7043245e6264cea789404e498a6f55a330a18585a4690d35dfe71741e6982237',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','configuration.json')},
    {name:`${component('punctuation')}/jieba.c.dict`,size:41536866,sha256:'eb0a68f8bfa65e6956d59e8f9652b49f5c91952273e24737bc9a8c5e23055221',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','jieba.c.dict')},
    {name:`${component('punctuation')}/jieba_usr_dict`,size:11280857,sha256:'059aa2af152734d5fd011a4d69cbab171f62347074db0db5157c17b5649010f5',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','jieba_usr_dict')},
    {name:`${component('punctuation')}/model.pt`,size:1125507622,sha256:'7176cae922a872e130e6b88aef9a1153581711baf79c9124c7c95be383cd6f81',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','model.pt')},
    {name:`${component('punctuation')}/tokens.json`,size:8280697,sha256:'89951fe0669380ed33298ee048c4a2b0ebcaaf6ee8f332d85c281c41d0f38392',official:msFile(FUNASR_MODEL_IDS.punctuation,'45ab6961ad58a973ce7785401b4e93a0aab907a3','tokens.json')},
  ]},
};
// Existing processing consumers still import these pins. ASR-03 removes the
// segmentation pin when replacing its old processor; it is not installable via
// the new dialogue catalog and never makes an old model directory ready.
export const ASR_MODEL_VERSION=MEDIA_CATALOG.dialogue.version;
export const SEGMENTATION_MODEL_SHA256='24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeName=(name:string)=>{
  if(typeof name!=='string'||name.length>1000||name.split('/').some(part=>! /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part)||part.endsWith('.part')))throw Error('Invalid model asset path');
  return name;
};
const safeUrl=(value:string)=>{
  const url=new URL(value),host=url.hostname;
  if(url.protocol!=='https:'||url.username||url.password||url.hash||host==='localhost'||host.endsWith('.local')||host.startsWith('[')||/^(?:0|10|127|169\.254|192\.168)\./.test(host)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(host))throw Error('Invalid model source');
  return url.toString();
};
const sha256File=async(path:string,signal?:AbortSignal)=>{
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let stream:ReturnType<typeof createReadStream>|undefined;
  try{
    stream=createReadStream(path,{signal,fd});const hash=createHash('sha256');for await(const block of stream)hash.update(block);return hash.digest('hex');
  }finally{if(!stream)closeSync(fd);}
};
// Check every component below the chosen root, including intermediate symlinks.
// mkdir/copyFile do not by themselves enforce containment or create parents.
function assetPath(root:string,name:string,createParents=false){
  safeName(name);
  const base=lstatSync(root);if(!base.isDirectory()||base.isSymbolicLink())throw Error('Invalid model directory');
  const parts=name.split('/');let parent=root;
  for(const part of parts.slice(0,-1)){
    parent=join(parent,part);
    if(createParents&&!existsSync(parent))mkdirSync(parent,{mode:0o700});
    const stat=lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Invalid model asset directory');
  }
  const path=join(root,name);
  try{if(!lstatSync(path).isFile())throw Error('Invalid model asset file');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return path;
}
function outputNames(role:MediaRole,catalog:Catalog){
  return catalog.files.flatMap(item=>item.extract?[item.extract.destination,...(role==='ocr'?[join(dirname(item.extract.destination),'inference.yml')]:[])]:[item.name]);
}
function catalogFor(role:MediaRole):Catalog {
  mediaRoleSchema.parse(role);
  const catalog=structuredClone(MEDIA_CATALOG[role]),names=new Set<string>();
  if(!catalog.version||catalog.version.length>200||!catalog.files.length)throw Error('Invalid model catalog');
  for(const file of catalog.files){
    safeName(file.name);if(file.name==='complete.json')throw Error('Invalid model asset path');safeUrl(file.official);if(file.mirror)safeUrl(file.mirror);
    if(!Number.isSafeInteger(file.size)||file.size<1||! /^[a-f0-9]{64}$/.test(file.sha256)||names.has(file.name))throw Error('Invalid model catalog');
    names.add(file.name);if(file.extract){safeName(file.extract.entry);safeName(file.extract.destination);}
  }
  for(const paths of [[...names],outputNames(role,catalog)]){
    if(paths.includes('complete.json'))throw Error('Invalid model asset path');
    if(new Set(paths).size!==paths.length||paths.some(path=>paths.some(other=>other!==path&&other.startsWith(path+'/'))))throw Error('Conflicting model asset paths');
  }
  if(!Number.isSafeInteger(catalog.files.reduce((sum,file)=>sum+file.size,0)))throw Error('Invalid model catalog size');
  return catalog;
}
const catalogHash=(catalog:Catalog)=>digest({version:catalog.version,files:catalog.files,models:catalog.models});
/** Domain workers can use these exact catalog identities rather than echoing
 * request identities or reading a different downloaded repository revision. */
export function mediaModelIdentities(role:MediaRole){
  const catalog=catalogFor(role);
  return Object.fromEntries(Object.entries(catalog.models??{}).map(([key,model])=>[key,{id:model.id,revision:model.revision,
    manifestSha256:digest({model,files:catalog.files.filter(file=>model.directory==='.'||file.name.startsWith(model.directory+'/'))})}]));
}
type Signature=Pick<Stats,'size'|'mtimeMs'|'ctimeMs'|'ino'>;
const signature=(stat:Stats):Signature=>({size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino});
type PublishedFile=Signature&{name:string;sha256:string};
type Progress=MediaAssetStatus;
type Source='auto'|'official'|'mirror';
const inProgress=(state:string)=>['downloading','verifying','installing'].includes(state);
// A retiring service and its replacement may briefly share the same directory.
// Admission belongs to the directory/role, not only to one JavaScript object.
const installingDirectories=new Set<string>();

export class MediaAssets {
  private active=new Map<MediaRole,Progress>();
  private operations=new Map<MediaRole,{controller:AbortController;done:Promise<void>}>();
  private closing=false;
  readonly root:string;
  constructor(root:string){const path=resolve(root);mkdirSync(path,{recursive:true,mode:0o700});if(!lstatSync(path).isDirectory())throw Error('Invalid model directory');this.root=realpathSync(path);}
  path(role:MediaRole){return join(this.root,MEDIA_MODEL_PATHS[mediaRoleSchema.parse(role)]);}
  ready(role:MediaRole){try{
    const catalog=catalogFor(role),root=this.path(role),marker=assetPath(root,'complete.json',false);
    // complete.json is reserved for the installer, not a catalog/import file.
    const markerStat=lstatSync(marker);if(markerStat.size>512*1024)return false;
    const receipt=JSON.parse(readFileSync(marker,'utf8')) as {version:string;manifestSha256:string;files:PublishedFile[]};
    const names=outputNames(role,catalog);
    if(receipt.version!==catalog.version||receipt.manifestSha256!==catalogHash(catalog)||!Array.isArray(receipt.files)||receipt.files.length!==names.length)return false;
    const files=new Map(receipt.files.map(file=>[file.name,file]));if(files.size!==names.length)return false;
    return names.every(name=>{
      const file=files.get(name);if(!file||! /^[a-f0-9]{64}$/.test(file.sha256))return false;
      const stat=lstatSync(assetPath(root,name)),raw=catalog.files.find(item=>!item.extract&&item.name===name);
      // Hashes were verified before publication. Stat identity invalidation
      // detects deletion/replacement and same-size edits without hashing 9 GB
      // on every status poll. A changed file must be verified by installation.
      return (!raw||file.sha256===raw.sha256&&file.size===raw.size)&&Object.entries(signature(stat)).every(([key,value])=>file[key as keyof Signature]===value);
    });
  }catch{return false;}}
  status(role:MediaRole):MediaAssetStatus {
    const catalog=catalogFor(role),active=this.active.get(role),totalBytes=catalog.files.reduce((sum,file)=>sum+file.size,0);
    if(active&&(active.state!=='ready'||this.ready(role)))return {...active};
    const ready=this.ready(role);return {role,state:ready?'ready':'not_installed',version:catalog.version,bytes:ready?totalBytes:0,totalBytes,source:''};
  }
  statuses(){return Object.fromEntries(mediaRoleSchema.options.map(role=>[role,this.status(role)])) as Record<MediaRole,MediaAssetStatus>;}
  private available(role:MediaRole){
    if(this.closing)throw new StoreError('Media assets service is unavailable',503);
    if(installingDirectories.has(this.path(role))||this.operations.has(role)||inProgress(this.active.get(role)?.state??''))throw new StoreError('Model installation is already running',409);
  }
  private claim(role:MediaRole){
    // The offline CLI may be a separate process from Central. Use the same
    // private PID-lock admission pattern as profile commands, with no expiry
    // or task/runtime state. A dead installer leaves its resumable cache.
    const path=join(this.root,`${role}.install.lock`),busy=()=>new StoreError('Model installation is already running',409);
    for(let attempt=0;attempt<2;attempt++){
      let fd:number;
      try{fd=openSync(path,'wx',0o600);}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
        const stat=lstatSync(path);if(!stat.isFile()||stat.size>32)throw busy();
        const pid=Number(readFileSync(path,'utf8'));if(!Number.isSafeInteger(pid)||pid<1)throw busy();
        try{process.kill(pid,0);throw busy();}catch(probe){if((probe as NodeJS.ErrnoException).code!=='ESRCH')throw probe;}
        const current=lstatSync(path);if(current.ino!==stat.ino||current.ctimeMs!==stat.ctimeMs)throw busy();rmSync(path);continue;
      }
      try{writeFileSync(fd,String(process.pid));}catch(error){closeSync(fd);rmSync(path,{force:true});throw error;}
      const inode=fstatSync(fd).ino;
      return ()=>{closeSync(fd);if(existsSync(path)&&lstatSync(path).ino===inode)rmSync(path);};
    }
    throw busy();
  }
  install(role:MediaRole,source:Source='auto'){
    const done=this.installAsync(role,source);void done.catch(()=>{});return this.status(role);
  }
  installAsync(role:MediaRole,source:Source='official',signal?:AbortSignal):Promise<void>{
    this.available(role);signal?.throwIfAborted();
    if(this.ready(role)){const release=this.claim(role);release();this.active.delete(role);return Promise.resolve();}
    return this.begin(role,source,signal,(catalog,progress,ownedSignal)=>this.perform(role,catalog,source,progress,ownedSignal));
  }
  private begin(role:MediaRole,source:string,signal:AbortSignal|undefined,work:(catalog:Catalog,progress:Progress,signal:AbortSignal)=>Promise<void>){
    this.available(role);signal?.throwIfAborted();
    const catalog=catalogFor(role),release=this.claim(role),controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const progress:Progress={role,version:catalog.version,state:source==='local-import'?'verifying':'downloading',bytes:0,totalBytes:catalog.files.reduce((sum,file)=>sum+file.size,0),source};
    this.active.set(role,progress);installingDirectories.add(this.path(role));
    // Register ownership before the first async read, for imports as well as
    // downloads. close/cancel waits for verification and publication cleanup.
    const done=Promise.resolve().then(()=>work(catalog,progress,controller.signal)).catch(error=>{
      progress.state=controller.signal.aborted?'cancelled':'failed';
      progress.error=controller.signal.aborted?undefined:source==='local-import'&&error instanceof InvalidAsset?error.message.slice(0,1000):source==='local-import'?'model_import_failed':'model_install_failed';throw error;
    }).finally(()=>{signal?.removeEventListener('abort',abort);this.operations.delete(role);installingDirectories.delete(this.path(role));release();});
    this.operations.set(role,{controller,done});return done;
  }
  async cancel(role:MediaRole){const operation=this.operations.get(role);operation?.controller.abort();await operation?.done.catch(()=>{});return this.status(role);}
  async close(){this.closing=true;await Promise.all([...this.operations.keys()].map(role=>this.cancel(role)));}
  importBundle(role:MediaRole,directory:string,signal?:AbortSignal):Promise<MediaAssetStatus>{
    return this.begin(role,'local-import',signal,async(catalog,progress,ownedSignal)=>{
      const cache=this.cache(role);let temporary:string|undefined;
      try{
        for(const item of catalog.files){
          ownedSignal.throwIfAborted();
          try{
            const input=assetPath(directory,item.name),stat=lstatSync(input);if(stat.size!==item.size)throw Error();
            const target=assetPath(cache,item.name,true);temporary=target+'.'+randomUUID()+'.import';
            copyFileSync(input,temporary);if(await sha256File(temporary,ownedSignal)!==item.sha256)throw Error();
            ownedSignal.throwIfAborted();renameSync(temporary,target);temporary=undefined;progress.bytes+=item.size;
          }catch(error){ownedSignal.throwIfAborted();throw new InvalidAsset(item.name);}
        }
        progress.bytes=0;await this.perform(role,catalog,'official',progress,ownedSignal,false);
      }finally{if(temporary)rmSync(temporary,{force:true});}
    }).then(()=>this.status(role));
  }
  private cache(role:MediaRole){
    const path=join(this.root,`${role}.downloads`);if(!existsSync(path))mkdirSync(path,{mode:0o700});
    if(!lstatSync(path).isDirectory()||lstatSync(path).isSymbolicLink())throw Error('Invalid model cache');return path;
  }
  private async perform(role:MediaRole,catalog:Catalog,source:Source,progress:Progress,signal:AbortSignal,allowDownload=true){
    signal.throwIfAborted();
    const staging=join(this.root,`${role}.${randomUUID()}.install`),cache=this.cache(role);mkdirSync(staging,{mode:0o700});
    try{
      for(const item of catalog.files){
        const target=assetPath(cache,item.name,true);
        if(allowDownload)await this.download(item,target,source,progress,signal);
        else{if(lstatSync(target).size!==item.size||await sha256File(target,signal)!==item.sha256)throw new InvalidAsset(item.name);progress.bytes+=item.size;}
        signal.throwIfAborted();progress.state='installing';
        if(item.extract){
          const output=assetPath(staging,item.extract.destination,true);
          // Only the small OCR tar members use an extraction bound. Large VLM
          // shards are copied/hashed as files, never buffered as tar stdout.
          const bytes=execFileSync('tar',[item.extract.kind==='bz2'?'-xOjf':'-xOf',target,item.extract.entry],{maxBuffer:128*1024*1024,timeout:120000});
          if(!bytes.length||bytes.length>96*1024*1024)throw Error('Invalid model archive');writeFileSync(output,bytes,{mode:0o600});
          if(role==='ocr'){
            const config=execFileSync('tar',['-xOf',target,item.extract.entry.replace('inference.onnx','inference.yml')],{maxBuffer:1024*1024,timeout:120000});
            if(!config.length)throw Error('Invalid OCR model configuration');writeFileSync(assetPath(staging,join(dirname(item.extract.destination),'inference.yml'),true),config,{mode:0o600});
          }
        }else copyFileSync(target,assetPath(staging,item.name,true));
      }
      progress.state='verifying';const files:PublishedFile[]=[];
      for(const name of outputNames(role,catalog)){
        const path=assetPath(staging,name),sha256=await sha256File(path,signal),stat=lstatSync(path),raw=catalog.files.find(item=>!item.extract&&item.name===name);
        if(!stat.size||raw&&(sha256!==raw.sha256||stat.size!==raw.size))throw new InvalidAsset(name);
        const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}files.push({name,sha256,...signature(stat)});
      }
      signal.throwIfAborted();progress.state='installing';
      const marker=join(staging,'complete.json');writeFileSync(marker,JSON.stringify({version:catalog.version,manifestSha256:catalogHash(catalog),installedAt:new Date().toISOString(),files}),{mode:0o600});
      const fd=openSync(marker,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      const prior=this.path(role),old=join(this.root,`${role}.${randomUUID()}.old`),hadPrior=existsSync(prior);
      if(hadPrior){if(!lstatSync(prior).isDirectory()||lstatSync(prior).isSymbolicLink())throw Error('Invalid installed model directory');renameSync(prior,old);}
      try{renameSync(staging,prior);}catch(error){if(hadPrior)renameSync(old,prior);throw error;}
      rmSync(old,{recursive:true,force:true});progress.state='ready';progress.bytes=progress.totalBytes;
    }finally{rmSync(staging,{recursive:true,force:true});}
  }
  private async download(item:Item,target:string,source:Source,progress:Progress,signal:AbortSignal){
    signal.throwIfAborted();
    if(existsSync(target)&&lstatSync(target).size===item.size&&await sha256File(target,signal)===item.sha256){progress.bytes+=item.size;return;}
    rmSync(target,{force:true});
    const choices=source==='official'?[item.official]:source==='mirror'?[item.mirror??item.official]:[item.mirror??item.official,item.official];
    let last:unknown;const completed=progress.bytes;
    for(const candidate of new Set(choices))try{
      const partial=target+'.part';let offset=0;
      let partialStat:Stats|undefined;
      try{partialStat=lstatSync(partial);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(partialStat){
        if(!partialStat.isFile())throw Error('Invalid model partial file');offset=partialStat.size;
        if(offset===item.size&&await sha256File(partial,signal)===item.sha256){signal.throwIfAborted();renameSync(partial,target);progress.bytes=completed+item.size;return;}
        if(offset>=item.size){rmSync(partial);offset=0;}
      }
      let url=safeUrl(candidate),response:Response|undefined;
      for(let redirect=0;redirect<6;redirect++){
        response=await fetch(url,{headers:offset?{Range:`bytes=${offset}-`}:{},redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(60*60*1000)])});
        if([301,302,303,307,308].includes(response.status)){
          const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('Model redirect is missing');url=safeUrl(new URL(location,url).toString());continue;
        }break;
      }
      if(!response||!response.ok){await response?.body?.cancel();throw Error('Model source unavailable');}
      if(offset&&response.status!==206){rmSync(partial,{force:true});offset=0;}
      if(response.status===206&&response.headers.get('content-range')!==`bytes ${offset}-${item.size-1}/${item.size}`){await response.body?.cancel();rmSync(partial,{force:true});throw Error('Invalid model range');}
      const length=response.headers.get('content-length');if(length!==null&&Number(length)!==item.size-offset){await response.body?.cancel();throw Error('Invalid model response size');}
      const handle=openSync(partial,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|(offset?constants.O_APPEND:constants.O_TRUNC),0o600);let received=offset;progress.state='downloading';progress.bytes=completed+offset;
      try{
        if(!response.body)throw Error('Empty model response');const reader=response.body.getReader();
        try{for(;;){signal.throwIfAborted();const {done,value:bytes}=await reader.read();if(done)break;received+=bytes.length;if(received>item.size)throw new InvalidAsset(item.name);writeFileSync(handle,bytes);progress.bytes=completed+received;progress.source=new URL(candidate).hostname;}}
        catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      }finally{closeSync(handle);}
      progress.state='verifying';
      if(received!==item.size)throw Error('Incomplete model response');
      if(await sha256File(partial,signal)!==item.sha256){rmSync(partial,{force:true});throw new InvalidAsset(item.name);}
      signal.throwIfAborted();renameSync(partial,target);return;
    }catch(error){signal.throwIfAborted();last=error;progress.state='downloading';progress.bytes=completed;if(error instanceof InvalidAsset)rmSync(target+'.part',{force:true});}
    throw last??Error('Model download failed');
  }
}
class InvalidAsset extends Error {constructor(name:string){super(`Invalid model asset: ${name}`);}}
