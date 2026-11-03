import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const entries=['codex-agent','task-context'];

const checks={
  'codex-agent':"if(typeof module.createCodexAgent!=='function')throw Error('missing createCodexAgent');",
  'task-context':"if(!module.taskTools({question:'Generated'}).includes('read_image'))throw Error('official read packs are not registered');",
};

test('Agent entry modules import directly without an ESM temporal-dead-zone failure',()=>{
  for(const entry of entries){
    const module=fileURLToPath(new URL('../dist/'+entry+'.js',import.meta.url));
    const script=`const module=await import(${JSON.stringify(module)});${checks[entry]}`;
    const result=spawnSync(process.execPath,['--input-type=module','--eval',script],{encoding:'utf8'});
    assert.equal(result.status,0,`${entry} failed to import:\n${result.stderr}`);
  }
});
