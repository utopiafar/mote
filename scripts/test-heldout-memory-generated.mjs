import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';

const files=process.argv.slice(2);
if(!files.length)throw Error('Pass the generated heldout test inventory');

const root=await realpath(await mkdtemp(join(tmpdir(),'mote-heldout-generated-')));
const recoveryE=join(root,'recovery-e');
const reviewAncestor=join(root,'recovery-e-review-ancestor');
const normalReview=join(root,'normal-review');
const askRecovery=join(root,'ask-recovery');
const env={
  ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_')&&!key.startsWith('NODE_'))),
  MOTE_HELDOUT_FIXTURE_ROOT:root,
  MOTE_HELDOUT_RECOVERY_E_TEST_OUTPUT:recoveryE,
  MOTE_HELDOUT_NORMAL_GENERATED_ANCESTOR:reviewAncestor,
  MOTE_HELDOUT_NORMAL_REVIEW_GENERATED_ANCESTOR:reviewAncestor,
  MOTE_HELDOUT_NORMAL_REVIEW_TEST_OUTPUT:normalReview,
  MOTE_HELDOUT_ASK_RECOVERY_GENERATED_NORMAL_REVIEW:normalReview,
  MOTE_HELDOUT_ASK_RECOVERY_TEST_OUTPUT:askRecovery,
  MOTE_HELDOUT_POST_ASK_RECOVERY_GENERATED_SOURCE:askRecovery,
  MOTE_HELDOUT_POST_ASK_RECOVERY_TEST_OUTPUT:join(root,'post-ask-recovery'),
  MOTE_REVIEW_TEST_OUTPUT:join(root,'review-export'),
};

// Generated tests pin distinct supervisor bytes. Only the Ask denial test
// executes its fixture. A generated launcher must never start a live replay.
for(const name of ['stage','phase-v2','phase-e','normal-phase','normal-phase-v2','ask']){
  await writeFile(join(root,`run-heldout-${name}-supervised.py`),`# Generated ${name} fixture
import argparse
import json
import sys

parser = argparse.ArgumentParser()
for name in ("repo", "manifest", "ledger", "output"):
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
with open(args.manifest, encoding="utf-8") as file:
    manifest = json.load(file)
if manifest.get("kind") == "mechanical":
    sys.exit("generated_supervisor_refuses_mechanical_manifest")
sys.exit("generated_supervisor_cannot_launch_live_replay")
`,{mode:0o600,flag:'wx'});
}

const ordered=['recovery-e','normal','normal-review','ask-recovery','post-ask-recovery']
  .map(name=>`test-heldout-memory-replay-${name}.test.ts`);
const rank=file=>ordered.indexOf(basename(file));
function run(file,testEnv,label=file){
  console.log(`\n${label}`);
  const result=spawnSync(process.execPath,['--import','tsx','--test',file],{env:testEnv,stdio:'inherit'});
  if(result.error)console.error(result.error);
  if(result.status!==0)process.exitCode=1;
  return result.status===0;
}

console.log(`Generated heldout fixtures: ${root}`);
for(const file of files.sort((a,b)=>rank(a)-rank(b))){
  const passed=run(file,env);
  if(rank(file)===0&&files.some(candidate=>rank(candidate)>0)){
    // Keep the original 24-input E check. The review lineage needs a second
    // E ancestor whose third batch has the historical four-input shape.
    run(file,{...env,MOTE_HELDOUT_RECOVERY_E_TEST_OUTPUT:reviewAncestor,MOTE_HELDOUT_E_FIXTURE_VARIANT:'review'},`${file} (review ancestor)`);
  }
  if(passed&&rank(file)===3){
    const report=await readFile(join(askRecovery,'ROOT_SAFE_ask-recovery.json'));
    env.MOTE_HELDOUT_POST_ASK_RECOVERY_REPORT_SHA256=createHash('sha256').update(report).digest('hex');
  }
}

for(const mode of ['clock-probe','duplicate-probe']){
  console.log(`\n${mode}`);
  const output=join(root,mode);
  const result=spawnSync(process.execPath,['--import','tsx','scripts/test-heldout-memory-replay.ts'],{
    env:{...env,MOTE_HELDOUT_MODE:mode,MOTE_HELDOUT_OUTPUT:output},stdio:'inherit',
  });
  if(result.status!==0){process.exitCode=1;continue;}
  const report=JSON.parse(await readFile(join(output,'metadata.json'),'utf8'));
  if(report.status!=='prepared'||report.probe?.status!=='passed'||report.realModelCalls!==0){
    console.error(`Generated probe failed: ${mode}`);
    process.exitCode=1;
  }
}
