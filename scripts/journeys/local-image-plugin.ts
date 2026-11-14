/** IMG-08's narrow acceptance entry. No arguments is inert; the full Central
 * journey, live models, UI and release matrix require a separate stage run.
 * Keep this outside ordinary test globs and the automatic affected plan. */
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,open,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repository=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export const contractFiles=[
 'test/local-image-processing.test.ts',
 'test/image-processing.test.ts',
 'test/image-regions.test.ts',
 'test/local-image-materials.test.ts',
 'test/material-organizers.test.ts',
 'test/memory-selected-output.test.ts',
 'test/memory-image-journey.test.ts',
 'test/memory-image-proof.test.ts',
 'test/local-image-query.test.ts',
 'test/query-direct-images.test.ts',
 'test/evidence-images.test.ts',
] as const;
export const contractArguments=['--import','tsx','--test','--test-reporter=tap','--test-concurrency=4','--test-timeout=120000',...contractFiles];
const matrix=[
 ['plugin-lifecycle','Plugin off/on, missing model and worker failure'],
 ['intake-policy','Four intake entrances, source/batch selection and existing authorization'],
 ['image-products','Wordless/small-text/long/cropped images and independent OCR failures'],
 ['memory','Independent extraction/review pixels, selected models and original-backed proof'],
 ['ask','Direct image, search then original, region follow-up and citations'],
 ['recovery','Cancellation, deletion, replacement, source changes and restart'],
 ['clients','Web/Android/Mac controls and the same Central facts'],
 ['asr-coexistence','Independent OCR/ASR/VLM lifecycle and controlled concurrency'],
] as const;
export type Options={mode:'help'|'plan'|'fixtures'|'contracts';output?:string};

export function parseArguments(args:readonly string[]):Options {
 let mode:Options['mode']|undefined,output:string|undefined;
 const modes:Record<string,Options['mode']>={'--help':'help','--dry-run':'plan','--fixtures-only':'fixtures','--run-contracts':'contracts'};
 for(let index=0;index<args.length;index++){
  const argument=args[index];
  if(Object.hasOwn(modes,argument)){
   if(mode)throw Error('Choose exactly one mode.');
   mode=modes[argument];
  }else if(argument==='--output'){
   if(output!==undefined)throw Error('Specify --output once.');
   output=args[++index];
   if(!output||output.startsWith('--')||output.includes('\0')||!isAbsolute(output))throw Error('--output requires an absolute, new directory outside the repository.');
  }else throw Error('Unknown argument. Use --help; input images, profiles, endpoints and live-model options are not accepted.');
 }
 mode??='help';
 if(output&&mode!=='fixtures'&&mode!=='contracts')throw Error('--output is only valid with --fixtures-only or --run-contracts.');
 return {mode,...(output?{output:resolve(output)}:{})};
}

export function acceptancePlan(candidate:string,worktreeDirty=false){
 return {
  task:'IMG-08',candidate,worktreeDirty,evidenceKind:'generated-fixture',personalDataUsed:false,liveModel:false,
  fullJourneyCompleted:false,releaseAccepted:false,
  paths:{
   A:{state:'not_run',description:'Default Central → official plugin → local worker → current interpretation → Material/index → selected Ask → original/crop → citation'},
   B:{state:'not_run',description:'Same original → existing Memory admission → selected extractor pixels → independent reviewer pixels → published proof → original deletion invalidation'},
  },
  releaseMatrix:matrix.map(([id,scenario])=>({id,scenario,state:'not_run'})),
  checks:[{cwd:'apps/server',executable:'node',arguments:contractArguments}],
  boundaries:{
   generatedInputs:'Six procedural IMG-00 rasters; no external image or profile input',
   fixtureValidation:'Production imageOutput, request/response parsers and exact original/crop pixels; no Central or inference',
   contracts:'Existing IMG-03/04/05/06 module assemblies; each retained assertion, concurrency and timeout stays intact',
   defaultAssembly:'Separate stage evidence required; module fixtures do not prove default startup or platform support',
  },
  modelMeasurements:{actualModel:null,weightsRevision:null,dependencyRevision:null,coldLatencyMs:null,warmLatencyMs:null,memoryBytes:null},
 };
}

const help=`IMG-08 local image acceptance entry

Usage: node --import tsx scripts/journeys/local-image-plugin.ts [mode] [--output ABSOLUTE_NEW_DIRECTORY]

  --help           Show this help (also the default); no files or services.
  --dry-run        Print the candidate, exact narrow checks and untested A/B/release matrix.
  --fixtures-only  Generate and validate six IMG-00 rasters and real pixel/transport examples.
  --run-contracts  Explicitly run only the existing IMG-03/04/05/06 narrow fixture files.
  --output PATH    Retain generated artifacts in a new directory outside the repository.
                   Otherwise create a private temporary directory and print its location.

This entry does not execute the full Central journey, install or run real models,
prepare dependencies, start Docker, contact an existing Central, or use personal input.
Fixture checks cannot mark A/B or any release-matrix row complete.
`;

/** Resolve the parent before creating anything: an output symlink must not
 * redirect artifacts into this or another lane. Never reuse/overwrite a run. */
export async function createOutput(output?:string){
 const parent=await realpath(output?dirname(output):tmpdir()),destination=join(parent,output?basename(output):'mote-img08-generated-');
 const worktrees=execFileSync('git',['worktree','list','--porcelain'],{cwd:repository,encoding:'utf8'}).split('\n').filter(line=>line.startsWith('worktree ')).map(line=>resolve(line.slice(9)));
 for(const protectedRoot of [await realpath(repository),...worktrees]){
  const part=relative(protectedRoot,destination);
  if(!part||part!=='..'&&!part.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(part))throw Error('Output must be outside repository and lane worktrees.');
 }
 if(!output)return mkdtemp(destination);
 await mkdir(destination,{mode:0o700}); // no recursive/force: EEXIST fails closed
 return destination;
}

/** Do not inherit old example destinations or deployment/model/profile knobs.
 * Every selected test declares its own generated connections and private Store. */
export function contractEnvironment(environment:NodeJS.ProcessEnv){
 return Object.fromEntries(Object.entries(environment).filter(([key])=>!key.startsWith('MOTE_')&&key!=='NODE_TEST_CONTEXT'));
}

export function contractOutcome(exitCode:number|null,signal:NodeJS.Signals|null,tail:string){
 const count=(name:string)=>{const value=tail.match(new RegExp('^# '+name+' (\\d+)$','m'));return value?Number(value[1]):null;};
 const counts={tests:count('tests'),passed:count('pass'),failed:count('fail'),cancelled:count('cancelled'),skipped:count('skipped')};
 const passed=exitCode===0&&signal===null&&counts.tests!==null&&counts.tests>0&&counts.passed===counts.tests&&counts.failed===0&&counts.cancelled===0&&counts.skipped===0;
 return {state:passed?'passed':'failed',exitCode,signal,...counts,log:'contracts.tap'};
}

/** The CLI always supplies the fixed contractArguments. Export the subprocess
 * boundary so its log/exit handling can be checked with tiny generated tests
 * without rerunning unchanged server fixtures. */
export async function runTestProcess(directory:string,args:readonly string[]){
 const log=await open(join(directory,'contracts.tap'),'wx+',0o600);
 try{
  const child=spawn(process.execPath,args,{cwd:join(repository,'apps/server'),env:contractEnvironment(process.env),stdio:['ignore',log.fd,log.fd]});
  let interrupted:NodeJS.Signals|null=null;
  const interrupt=()=>{interrupted='SIGINT';child.kill('SIGTERM');},terminate=()=>{interrupted='SIGTERM';child.kill('SIGTERM');};
  process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
  try{
   const result=await new Promise<{exitCode:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{
    child.once('error',reject);child.once('close',(exitCode,signal)=>done({exitCode,signal}));
   });
   const {size}=await log.stat(),bytes=Buffer.alloc(Math.min(size,24000));
   await log.read(bytes,0,bytes.length,size-bytes.length);
   return contractOutcome(result.exitCode,interrupted??result.signal,bytes.toString('utf8'));
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);}
 }finally{await log.close();}
}

export async function main(args:readonly string[]){
 // Validate ALL arguments before imports that can generate inputs or run code.
 const options=parseArguments(args);
 if(options.mode==='help'){process.stdout.write(help);return;}
 const candidate=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
 const worktreeDirty=Boolean(execFileSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:repository,encoding:'utf8'}).trim());
 const plan=acceptancePlan(candidate,worktreeDirty);
 if(options.mode==='plan'){console.log(JSON.stringify({mode:'plan',...plan},null,2));return;}
 const directory=await createOutput(options.output);
 const report:{mode:Options['mode'];status:string;plan:ReturnType<typeof acceptancePlan>;fixtures?:unknown;contracts?:unknown;failure?:string}={mode:options.mode,status:'running',plan};
 const save=()=>writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 try{
  await save();
  if(options.mode==='fixtures'){
   const {writeGeneratedFixtures}=await import('./fixtures/local-image-plugin.js');
   report.fixtures=await writeGeneratedFixtures(directory);
  }else{
   const result=await runTestProcess(directory,contractArguments);report.contracts=result;
   if(result.state!=='passed')process.exitCode=1;
  }
  report.status=process.exitCode?'failed':'passed';
 }catch(error){
  report.status='failed';report.failure=error instanceof Error?error.message:'Fixture check failed';process.exitCode=1;
 }finally{await save();}
 console.log(JSON.stringify({status:report.status,candidate,worktreeDirty,mode:options.mode,artifacts:directory,fullJourneyCompleted:false,releaseAccepted:false}));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 void main(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:'IMG-08 entry failed');process.exitCode=1;});
}
