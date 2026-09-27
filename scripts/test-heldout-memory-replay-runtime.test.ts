/** Zero-model runtime identity checks; no corpus, vault, or provider is opened. */
import {after,test} from 'node:test';
import {mkdir,writeFile,realpath,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sha256} from '../apps/server/src/store.js';
import {assertRuntimePin,runtimePin,type RuntimePin} from './test-heldout-memory-replay-stage.js';
import {base,check,json,SafeFailure} from './test-heldout-memory-replay.js';
const output=process.env.MOTE_HELDOUT_TEST_OUTPUT??join(base,'heldout-runtime-pin-'+Date.now());await mkdir(output,{mode:0o700});
const runtime=await runtimePin(),passed:string[]=[];
test('runtime freeze captures the running absolute real executable, bytes, and version',async()=>{check(runtime.nodeVersion===process.version,'runtime_test_version');check(runtime.nodeExecutable===await realpath(process.execPath),'runtime_test_realpath');check(runtime.nodeExecutableSha256===sha256(await readFile(process.execPath)),'runtime_test_binary_hash');await assertRuntimePin(runtime);passed.push('actual-runtime');});
for(const [field,value,code] of [
  ['nodeVersion','v0.0.0','runtime_node_changed'],
  ['nodeExecutable',runtime.nodeExecutable+'.different','runtime_node_path_changed'],
  ['nodeExecutableSha256','0'.repeat(64),'runtime_node_binary_changed'],
] as const)test('changed '+field+' is refused before ledger/admission',async()=>{let actual='';try{await assertRuntimePin({...runtime,[field]:value} as RuntimePin);}catch(error){actual=error instanceof SafeFailure?error.code:'unknown';}check(actual===code,'runtime_test_gate_mismatch');passed.push(field);});
after(async()=>{await writeFile(join(output,'ROOT_SAFE_runtime.json'),json({schema:'mote-heldout-runtime-pin-test@1',status:passed.length===4?'passed':'incomplete',checks:passed,runtime,realModelCalls:0,stubModelCalls:0,heldoutSemanticInputsRead:false}),{mode:0o600});});
