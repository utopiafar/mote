// Explicit native installer regression. Requires the pinned uv and Python 3.11;
// all packages/indexes are generated locally, with network access disabled.
// node apps/server/test/media-index-resolution.mjs --uv /path/to/uv --python /path/to/python
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {zipSync,strToU8} from 'fflate';
import {prepareNativeMediaRuntime,runMediaCommand,nativeMediaPlatform,MEDIA_UV_VERSION} from '../src/media-native-runtime.mjs';

const {values}=parseArgs({options:{uv:{type:'string'},python:{type:'string'}}});
assert.ok(values.uv&&values.python,'Supply the pinned --uv executable and a --python 3.11 interpreter');
assert.match(String(await runMediaCommand(values.uv,['--version'])),new RegExp(`^uv ${MEDIA_UV_VERSION.replaceAll('.','\\.')}\\b`));
await runMediaCommand(values.python,['-c','import sys; assert sys.version_info[:2] == (3,11)']);
const root=await mkdtemp(join(tmpdir(),'mote-media-indexes-'));
try{
 const repository=join(root,'repository'),directory=join(root,'runtime'),primary=join(root,'pypi'),cpu=join(root,'cpu');
 await mkdir(join(repository,'scripts'),{recursive:true,mode:0o700});
 async function wheel(index,name,version,files={}){
  const normalized=name.replaceAll('-','_'),info=`${normalized}-${version}.dist-info`,contents={
   [`${normalized}/__init__.py`]:'',...files,
   [`${info}/METADATA`]:`Metadata-Version: 2.1\nName: ${name}\nVersion: ${version}\n`,
   [`${info}/WHEEL`]:'Wheel-Version: 1.0\nGenerator: Mote generated fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
  };
  const entries=Object.fromEntries(Object.entries(contents).map(([path,content])=>[path,strToU8(content)]));
  entries[`${info}/RECORD`]=strToU8(Object.entries(entries).map(([path,data])=>`${path},sha256=${createHash('sha256').update(data).digest('base64url')},${data.length}\n`).join('')+`${info}/RECORD,,\n`);
  const folder=join(index,name),filename=`${normalized}-${version}-py3-none-any.whl`;
  await mkdir(folder,{recursive:true});await writeFile(join(folder,filename),zipSync(entries));
  await writeFile(join(folder,'index.html'),`<a href="${filename}">${filename}</a>`);
 }
 // The secondary CPU index shadows a package but lacks the locked version.
 // Torch exists only on that index, so simply dropping it cannot pass either.
 await wheel(cpu,'mote-index-pin','1.0');await wheel(primary,'mote-index-pin','2.0');
 await wheel(cpu,'torch','1.0+cpu');
 for(const name of ['pip','setuptools','wheel'])await wheel(primary,name,'100.0');
 for(const name of ['funasr','numpy'])await wheel(primary,name,'1.0');
 await wheel(primary,'imageio-ffmpeg','1.0',{'imageio_ffmpeg/__init__.py':
  "import os\ndef get_ffmpeg_exe():\n p=os.path.join(os.path.dirname(__file__),'ffmpeg')\n with open(p,'w') as f: f.write('#!/bin/sh\\nexit 0\\n')\n os.chmod(p,0o700)\n return p\n"});
 await writeFile(join(repository,'scripts','mote_asr_contract.py'),"SDK_VERSION='1.0'\n");
 await writeFile(join(repository,'scripts','requirements-audio.txt'),`--extra-index-url ${pathToFileURL(cpu+'/').href}\nmote-index-pin==2.0\ntorch==1.0+cpu\nfunasr==1.0\nnumpy==1.0\nimageio-ffmpeg==1.0\n`);
 const platform=nativeMediaPlatform(),bootstrap=join(directory,'dialogue','bootstrap',MEDIA_UV_VERSION,platform.target),binary=await readFile(values.uv);
 await mkdir(bootstrap,{recursive:true,mode:0o700});await writeFile(join(bootstrap,'uv'),binary,{mode:0o700});await chmod(join(bootstrap,'uv'),0o700);
 await writeFile(join(bootstrap,'receipt.json'),JSON.stringify({archiveSha256:platform.sha256,binarySha256:createHash('sha256').update(binary).digest('hex')}));
 const calls=[],stages=[];
 // Substitute only network endpoints. Use the real uv resolver, venv, Python,
 // production imports, ffmpeg verification and atomic runtime publication.
 const run=async(command,args,options={})=>{
  calls.push(args[0]);
  const fixtureArgs=args.map(value=>value==='https://pypi.org/simple'?pathToFileURL(primary+'/').href:value);
  try{return await runMediaCommand(command,fixtureArgs,{...options,env:{...options.env,UV_INDEX_URL:pathToFileURL(primary+'/').href,UV_OFFLINE:'1'}});}
  catch(cause){throw Error(`Generated fixture command failed: ${args[0]}`,{cause});}
 };
 const prepared=await prepareNativeMediaRuntime({repository,directory,role:'dialogue',sourcePython:values.python,run,onStage:stage=>stages.push(stage),fetchImpl:async()=>{throw Error('Unexpected bootstrap network request');}});
 assert.equal(prepared.created,true);assert.deepEqual(stages,['dependencies','verifying_dependencies']);
 const installed=JSON.parse(String(await runMediaCommand(prepared.python,['-c',"import json,importlib.metadata as m; print(json.dumps({p:m.version(p) for p in ['mote-index-pin','torch']}))"])));
 assert.deepEqual(installed,{'mote-index-pin':'2.0',torch:'1.0+cpu'});
 const published=JSON.parse(await readFile(join(directory,'dialogue','current.json'),'utf8'));assert.equal(published.generation,prepared.generation);
 calls.length=0;
 const restored=await prepareNativeMediaRuntime({repository,directory,role:'dialogue',allowInstall:false,run});
 assert.equal(restored.created,false);assert.equal(restored.python,prepared.python);assert.deepEqual(calls,['-c','-version']);
 console.log('PASS: pinned PyPI fallback + CPU-only package + verified publication + offline restart');
}finally{await rm(root,{recursive:true,force:true});}
