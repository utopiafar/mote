import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import test from 'node:test';

function cliFixture(t,checkout='Application Support # % ? 中文'){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-reset-cli-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const script=join(checkout,'scripts','reset-mvp-vault.mjs');
  mkdirSync(dirname(join(root,script)),{recursive:true});
  copyFileSync(new URL('../reset-mvp-vault.mjs',import.meta.url),join(root,script));
  const directory=join(root,'vault data # % ? 中文');
  const evidence=['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','mote.sqlite-journal','blobs/item','files/item','source-archive/item','imports/item','import-uploads/item','model-settings.json','file-processing.json'];
  const preserved=['access-token','content-key','connectors/client-connections.json','connectors/remote-account.json','logs/item','media-models/item','unrelated.txt'];
  for(const name of [...evidence,...preserved]){
    mkdirSync(dirname(join(directory,name)),{recursive:true});
    writeFileSync(join(directory,name),`generated content: ${name}`);
  }
  return {
    root,directory,evidence,preserved,
    run(args){
      const result=spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8',timeout:15_000});
      assert.ifError(result.error);
      assert.equal(result.signal,null);
      return result;
    },
    assertIntact(){
      for(const name of [...evidence,...preserved])assert.equal(readFileSync(join(directory,name),'utf8'),`generated content: ${name}`);
    },
  };
}

test('MVP vault CLI resets evidence and preserves credentials from URL-escaped checkout paths',async t=>{
  for(const checkout of ['plain-checkout','Application Support','release#candidate','release%20candidate','release?candidate','发布目录']){
    await t.test(checkout,t=>{
      const fixture=cliFixture(t,checkout);
      const result=fixture.run(['--data-dir',fixture.directory,'--confirm-clear']);
      assert.equal(result.status,0,result.stderr);
      assert.equal(result.stderr,'');
      const receipt=JSON.parse(result.stdout);
      assert.equal(receipt.storageEpoch,7);
      assert.equal(receipt.dataDir,fixture.directory);
      assert.deepEqual(receipt.removed.sort(),fixture.evidence.map(name=>name.split('/')[0]).sort());
      for(const name of fixture.evidence)assert.equal(existsSync(join(fixture.directory,name.split('/')[0])),false,name);
      for(const name of fixture.preserved)assert.equal(readFileSync(join(fixture.directory,name),'utf8'),`generated content: ${name}`);
    });
  }
});

test('MVP vault CLI rejects unconfirmed or unsafe resets without deleting generated evidence',async t=>{
  const cases=[
    {name:'missing confirmation',status:2,message:/Usage:/,args:directory=>['--data-dir',directory]},
    {name:'unexpected argument',status:2,message:/Usage:/,args:directory=>['--data-dir',directory,'--confirm-clear','extra']},
    {name:'active server',message:/Stop the Mote server/,prepare:({directory})=>writeFileSync(join(directory,'server.pid'),String(process.pid))},
    {name:'invalid PID',message:/PID marker is invalid/,prepare:({directory})=>writeFileSync(join(directory,'server.pid'),'invalid')},
    {name:'linked PID marker',message:/PID marker must be an ordinary file/,prepare:({directory})=>symlinkSync(join(directory,'access-token'),join(directory,'server.pid'))},
    {name:'directory PID marker',message:/PID marker must be an ordinary file/,prepare:({directory})=>mkdirSync(join(directory,'server.pid'))},
    {name:'linked data directory',message:/non-symlink Mote data directory/,prepare:fixture=>{
      const link=join(fixture.root,'linked-vault');
      symlinkSync(fixture.directory,link,'dir');
      return link;
    }},
    {name:'missing data directory',message:/existing, non-symlink/,prepare:fixture=>join(fixture.root,'missing-vault')},
    {name:'file data directory',message:/existing, non-symlink/,prepare:fixture=>join(fixture.directory,'mote.sqlite')},
    {name:'linked connector storage',message:/Connector storage must be an ordinary directory/,prepare:({root,directory})=>{
      const target=join(root,'generated-connectors');
      renameSync(join(directory,'connectors'),target);
      symlinkSync(target,join(directory,'connectors'),'dir');
    }},
  ];
  for(const scenario of cases){
    await t.test(scenario.name,t=>{
      const fixture=cliFixture(t);
      const directory=scenario.prepare?.(fixture)??fixture.directory;
      const result=fixture.run(scenario.args?.(directory)??['--data-dir',directory,'--confirm-clear']);
      assert.equal(result.status,scenario.status??1,result.stderr);
      assert.equal(result.stdout,'');
      assert.match(result.stderr,scenario.message);
      fixture.assertIntact();
    });
  }
});

