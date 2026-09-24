import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,existsSync} from 'node:fs';
import {chmod,mkdtemp,open,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import {importReviewDecisionSchema,sourceItemSchema} from '@mote/shared';
import type {ImportPreparation,ImportPreparationResult} from './imports.js';

const MAX_PACK_BYTES=256*1024;
const MAX_INPUT_BYTES=32*1024*1024;
const MAX_OUTPUT_BYTES=1024*1024;
const MAX_STDERR_BYTES=16*1024;
const MAX_INPUT_FILES=16;
const MAX_TIMEOUT_MS=120000;
const idPattern=/^[a-z][a-z0-9.-]{2,127}$/;
const hashPattern=/^[a-f0-9]{64}$/;

export type PythonFailureCode='pack_changed'|'invalid_input'|'input_limit'|'sandbox_unavailable'|'spawn_failed'|'process_failed'|'output_limit'|'invalid_output'|'timeout'|'cancelled';
export type PythonRunResult<T>={status:'succeeded';output:T}|{status:'blocked'|'failed'|'timed_out'|'cancelled';code:PythonFailureCode};
export type PythonPackSpec<T>={
  id:string;version:string;packRoot:string;script:string;scriptSha256:string;pythonExecutable:string;
  /** Additional trusted, read-only Python runtime directories; never the vault or user's home. */
  runtimeReadRoots?:string[];
  // The schema may supply defaults, so its input shape can be narrower than T.
  outputSchema:z.ZodType<T,z.ZodTypeDef,any>;
  timeoutMs?:number;maxInputBytes?:number;maxOutputBytes?:number;
};
export type PythonRunInput={workspace:string;inputPaths:string[];signal?:AbortSignal;config?:Record<string,unknown>};
export type PythonLaunch={command:string;args:string[];cwd:string;env:NodeJS.ProcessEnv};
export type PythonSandboxLauncher=(workspace:string,python:string,runner:string,profile:string,runtimeReadRoots:string[])=>PythonLaunch|undefined;

const inside=(root:string,path:string)=>{const part=relative(root,path);return part===''||(!part.startsWith(`..${sep}`)&&part!=='..'&&!isAbsolute(part));};
const quoted=(path:string)=>'"'+path.replaceAll('\\','\\\\').replaceAll('"','\\"')+'"';
const ancestors=(path:string)=>{const result:string[]=[];for(let p=dirname(path);;p=dirname(p)){result.push(p);if(p===dirname(p))return result;}};
const bounded=(value:number|undefined,fallback:number,maximum:number)=>value===undefined?fallback:Number.isSafeInteger(value)&&value>0&&value<=maximum?value:NaN;
const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

/** macOS sandbox: only the staged workspace is writable; no network grant exists. */
export function macPythonSandboxProfile(workspace:string,python:string,runtimeReadRoots:string[]):string {
  const roots=[workspace,...runtimeReadRoots],files=[python,'/dev/null','/dev/urandom','/dev/random','/private/etc/localtime'];
  const metadata=[...new Set([...roots,...files].flatMap(ancestors))];
  return [
    '(version 1)','(deny default)',
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    '(allow syscall* mach-bootstrap)','(allow mach-lookup)','(allow sysctl-read)',
    '(allow process-exec)',
    `(allow file-read* ${roots.map(path=>`(subpath ${quoted(path)})`).join(' ')} ${files.map(path=>`(literal ${quoted(path)})`).join(' ')})`,
    `(allow file-map-executable ${runtimeReadRoots.map(path=>`(subpath ${quoted(path)})`).join(' ')} (literal ${quoted(python)}))`,
    `(allow file-read-metadata ${metadata.map(path=>`(literal ${quoted(path)})`).join(' ')})`,
    `(allow file-write* (subpath ${quoted(workspace)}) (literal "/dev/null"))`,
  ].join('\n')+'\n';
}

const cleanEnv=(workspace:string):NodeJS.ProcessEnv=>({PATH:'/usr/bin:/bin',HOME:workspace,TMPDIR:workspace,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',LC_ALL:'C.UTF-8'});
/** Default launch fails closed when an OS file/network sandbox is unavailable. */
export const defaultPythonSandbox:PythonSandboxLauncher=(workspace,python,runner,profile,roots)=>{
  if(process.platform==='darwin'){
    if(!existsSync('/usr/bin/sandbox-exec'))return;
    return {command:'/usr/bin/sandbox-exec',args:['-f',profile,python,'-I','-B',runner],cwd:workspace,env:cleanEnv(workspace)};
  }
  if(process.platform==='linux'){
    const bwrap=['/usr/bin/bwrap','/bin/bwrap'].find(existsSync);if(!bwrap)return;
    const bindings=[...new Set(roots)].flatMap(root=>['--ro-bind',root,root]);
    return {command:bwrap,args:['--unshare-all','--die-with-parent','--new-session','--proc','/proc','--dev','/dev','--tmpfs','/tmp',...bindings,'--bind',workspace,'/workspace','--chdir','/workspace',python,'-I','-B','/workspace/runner.py'],cwd:workspace,env:{...cleanEnv('/workspace'),TMPDIR:'/tmp'}};
  }
};

function runnerScript(memoryBytes:number,cpuSeconds:number):string {
  return `import json, os, resource, runpy, sys\n`+
    `try:\n    resource.setrlimit(resource.RLIMIT_AS, (${memoryBytes}, ${memoryBytes}))\nexcept (ValueError, OSError):\n    pass\n`+
    `resource.setrlimit(resource.RLIMIT_CPU, (${cpuSeconds}, ${cpuSeconds}))\n`+
    `resource.setrlimit(resource.RLIMIT_FSIZE, (${MAX_OUTPUT_BYTES}, ${MAX_OUTPUT_BYTES}))\n`+
    `resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))\n`+
    `if hasattr(resource, 'RLIMIT_NPROC'): resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))\n`+
    `os.chdir(os.path.dirname(__file__))\n`+
    `sys.argv = ['pack.py']\n`+
    `runpy.run_path('pack.py', run_name='__main__')\n`;
}

/** Fixed-code child runner, reused by the OS-sandboxed executor and generated fixtures. */
export async function runBoundedPythonChild(launch:PythonLaunch,timeoutMs:number,outputLimit:number,signal?:AbortSignal):Promise<PythonRunResult<Buffer>> {
  if(signal?.aborted)return {status:'cancelled',code:'cancelled'};
  return new Promise(resolvePromise=>{
    let child:ReturnType<typeof spawn>;
    try{child=spawn(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true});}
    catch{return resolvePromise({status:'blocked',code:'spawn_failed'});}
    let ended=false,forced:PythonRunResult<Buffer>|undefined,stdoutBytes=0,stderrBytes=0;
    const stdout:Buffer[]=[];
    const stop=(result:PythonRunResult<Buffer>)=>{if(forced)return;forced=result;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{child.kill('SIGKILL');}};
    const timer=setTimeout(()=>stop({status:'timed_out',code:'timeout'}),timeoutMs);
    const abort=()=>stop({status:'cancelled',code:'cancelled'});signal?.addEventListener('abort',abort,{once:true});
    const finish=(result:PythonRunResult<Buffer>)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);resolvePromise(result);};
    child.stdout?.on('data',(part:Buffer)=>{stdoutBytes+=part.length;if(stdoutBytes>outputLimit)stop({status:'failed',code:'output_limit'});else stdout.push(Buffer.from(part));});
    child.stderr?.on('data',(part:Buffer)=>{stderrBytes+=part.length;if(stderrBytes>MAX_STDERR_BYTES)stop({status:'failed',code:'output_limit'});});
    child.once('error',()=>finish(forced??{status:'blocked',code:'spawn_failed'}));
    child.once('close',(code,signalCode)=>{
      if(forced)return finish(forced);
      if(code!==0||signalCode!==null)return finish({status:'failed',code:'process_failed'});
      finish({status:'succeeded',output:Buffer.concat(stdout,stdoutBytes)});
    });
  });
}

/** One instance pins one trusted script; request data never selects executable code. */
export class PythonSourcePackExecutor<T> {
  private readonly timeoutMs:number;
  private readonly maxInputBytes:number;
  private readonly maxOutputBytes:number;
  constructor(private readonly spec:PythonPackSpec<T>,private readonly launcher:PythonSandboxLauncher=defaultPythonSandbox){
    this.timeoutMs=bounded(spec.timeoutMs,30000,MAX_TIMEOUT_MS);
    this.maxInputBytes=bounded(spec.maxInputBytes,MAX_INPUT_BYTES,MAX_INPUT_BYTES);
    this.maxOutputBytes=bounded(spec.maxOutputBytes,MAX_OUTPUT_BYTES,MAX_OUTPUT_BYTES);
    if(!idPattern.test(spec.id)||!spec.version||spec.version.length>64||!hashPattern.test(spec.scriptSha256)||!isAbsolute(spec.packRoot)||!isAbsolute(spec.pythonExecutable)||isAbsolute(spec.script)||!spec.script||spec.script.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||[this.timeoutMs,this.maxInputBytes,this.maxOutputBytes].some(Number.isNaN))throw Error('Invalid Python Source Pack configuration');
  }
  async run(input:PythonRunInput):Promise<PythonRunResult<T>> {
    if(input.signal?.aborted)return {status:'cancelled',code:'cancelled'};
    if(input.inputPaths.length<1||input.inputPaths.length>MAX_INPUT_FILES)return {status:'failed',code:'input_limit'};
    let workspace:string,root:string,scriptPath:string,python:string,roots:string[];
    try{
      workspace=await realpath(input.workspace);root=await realpath(this.spec.packRoot);python=await realpath(this.spec.pythonExecutable);
      scriptPath=await realpath(resolve(root,this.spec.script));
      if(!inside(root,scriptPath))return {status:'blocked',code:'pack_changed'};
      roots=await Promise.all((this.spec.runtimeReadRoots??(process.platform==='darwin'?['/usr/bin','/usr/lib','/usr/share','/System/Library','/Library/Developer/CommandLineTools']:['/usr','/lib','/lib64','/bin'].filter(existsSync))).map(path=>realpath(path)));
      if(roots.some(path=>path==='/'||inside(path,workspace)||inside(path,root))||!roots.some(path=>inside(path,python)))return {status:'blocked',code:'sandbox_unavailable'};
    }catch{return {status:'blocked',code:'sandbox_unavailable'};}
    let temporary:string|undefined;
    try{
      let script:Buffer;
      try{script=await readRegular(scriptPath,MAX_PACK_BYTES);}catch{return {status:'blocked',code:'pack_changed'};}
      if(sha256(script)!==this.spec.scriptSha256)return {status:'blocked',code:'pack_changed'};
      temporary=await realpath(await mkdtemp(join(tmpdir(),'mote-python-pack-')));await chmod(temporary,0o700);
      await writeFile(join(temporary,'pack.py'),script,{mode:0o600,flag:'wx'});
      const staged:{index:number;path:string;sizeBytes:number}[]=[];let total=0;
      for(const [index,path] of input.inputPaths.entries()){
        input.signal?.throwIfAborted();
        let actual:string;
        try{actual=await realpath(path);}catch{return {status:'blocked',code:'invalid_input'};}
        if(!inside(workspace,actual)||!inside(join(workspace,'inputs'),actual))return {status:'blocked',code:'invalid_input'};
        const bytes=await readRegular(actual,this.maxInputBytes-total);total+=bytes.length;
        if(total>this.maxInputBytes)return {status:'failed',code:'input_limit'};
        const name=`input-${index}.bin`;await writeFile(join(temporary,name),bytes,{mode:0o600,flag:'wx'});
        staged.push({index,path:name,sizeBytes:bytes.length});
      }
      const config=input.config??{};if(Buffer.byteLength(JSON.stringify(config))>8192)return {status:'failed',code:'input_limit'};
      await writeFile(join(temporary,'request.json'),JSON.stringify({pack:{id:this.spec.id,version:this.spec.version},inputs:staged,config}),{mode:0o600,flag:'wx'});
      const runner=join(temporary,'runner.py'),profile=join(temporary,'sandbox.sb');
      await writeFile(runner,runnerScript(512*1024*1024,Math.max(1,Math.ceil(this.timeoutMs/1000))),{mode:0o600,flag:'wx'});
      if(process.platform==='darwin')await writeFile(profile,macPythonSandboxProfile(temporary,python,roots),{mode:0o600,flag:'wx'});
      const launch=this.launcher(temporary,python,runner,profile,roots);
      if(!launch)return {status:'blocked',code:'sandbox_unavailable'};
      const outcome=await runBoundedPythonChild(launch,this.timeoutMs,this.maxOutputBytes,input.signal);
      if(outcome.status!=='succeeded')return outcome;
      let parsed:unknown;try{parsed=JSON.parse(outcome.output.toString('utf8'));}catch{return {status:'failed',code:'invalid_output'};}
      const checked=this.spec.outputSchema.safeParse(parsed);
      return checked.success?{status:'succeeded',output:checked.data}:{status:'failed',code:'invalid_output'};
    }catch(error){
      if(input.signal?.aborted||error instanceof Error&&error.name==='AbortError')return {status:'cancelled',code:'cancelled'};
      if(error instanceof Error&&error.message==='file_limit')return {status:'failed',code:'input_limit'};
      return {status:'failed',code:'invalid_input'};
    }finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
  }
}

async function readRegular(path:string,maxBytes:number):Promise<Buffer> {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await handle.stat();if(!before.isFile()||before.size>maxBytes)throw Error('file_limit');
    const chunks:Buffer[]=[];let received=0;
    while(received<before.size){
      const chunk=Buffer.allocUnsafe(Math.min(64*1024,before.size-received));
      const {bytesRead}=await handle.read(chunk,0,chunk.length,null);
      if(bytesRead===0)throw Error('file_changed');
      received+=bytesRead;chunks.push(chunk.subarray(0,bytesRead));
    }
    const after=await handle.stat();
    if(after.size!==before.size||after.ino!==before.ino||after.dev!==before.dev||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('file_changed');
    return Buffer.concat(chunks,received);
  }finally{await handle.close();}
}

/** Existing ImportStore is the first consumer: Python emits data, host writes the reviewed manifest. */
export const pythonImportOutputSchema=z.object({
  summary:z.string().min(1).max(20000),warnings:z.array(z.string().max(2000)).max(200).default([]),
  reviewDecision:importReviewDecisionSchema.optional(),
  dispositions:z.array(z.object({index:z.number().int().nonnegative(),status:z.enum(['parsed','attachment','container','excluded','unsupported']),reason:z.string().min(1).max(1000)}).strict()).max(MAX_INPUT_FILES).optional(),
  records:z.array(z.object({item:sourceItemSchema,evidenceIndexes:z.array(z.number().int().nonnegative()).min(1).max(100),attachmentIndexes:z.array(z.number().int().nonnegative()).max(100).default([])}).strict()).max(1000),
}).strict();
export type PythonImportOutput=z.infer<typeof pythonImportOutputSchema>;

export function pythonImportPreparation(executor:PythonSourcePackExecutor<PythonImportOutput>):(input:ImportPreparation)=>Promise<ImportPreparationResult> {
  return async input=>{
    const result=await executor.run({workspace:input.workspace,inputPaths:input.inputPaths,signal:input.signal});
    if(result.status!=='succeeded')throw Error(`python_pack_${result.code}`);
    let manifestBytes=0;
    const lines=result.output.records.map(record=>{
      const indexes=[...record.evidenceIndexes,...record.attachmentIndexes];
      if(indexes.some(index=>index>=input.inputPaths.length))throw Error('python_pack_invalid_output');
      const line=JSON.stringify({item:record.item,evidencePaths:record.evidenceIndexes.map(index=>input.inputPaths[index]),attachments:record.attachmentIndexes.map(index=>input.inputPaths[index])});
      manifestBytes+=Buffer.byteLength(line)+1;
      if(manifestBytes>4*1024*1024)throw Error('python_pack_output_limit');
      return line;
    });
    const manifest=join(input.workspace,'records.jsonl');
    await writeFile(manifest,lines.join('\n')+(lines.length?'\n':''),{mode:0o600,flag:'wx'});
    if(result.output.dispositions){
      if(result.output.dispositions.some(item=>item.index>=input.inputPaths.length)||new Set(result.output.dispositions.map(item=>item.index)).size!==result.output.dispositions.length)throw Error('python_pack_invalid_output');
      await writeFile(join(input.workspace,'dispositions.json'),JSON.stringify({items:result.output.dispositions.map(item=>({path:input.inputPaths[item.index],status:item.status,reason:item.reason}))}),{mode:0o600,flag:'wx'});
    }
    return {summary:result.output.summary,warnings:result.output.warnings,recordsPath:manifest,reviewDecision:result.output.reviewDecision};
  };
}
