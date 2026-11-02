import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {parseAnswer} from '../dist/index.js';
import {startBridge} from '../dist/bridge.js';
import {CodexSession} from '../dist/codex-session.js';
import {generatedImageRead,digest} from './image-region-fixture.mjs';

const id = 'b54d3aaa-4ca3-5073-bb47-ad2db6e84a13';
const waitFor = async (path, attempts = 1000) => {
  for (let index = 0; index < attempts; index++) {
    try { await access(path); return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timeout waiting for ${path}`);
};

async function fixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-ack-'));
  const auth = join(root, 'auth.json'), bin = join(root, 'fake-codex');
  const started = join(root, 'steer-started'), release = join(root, 'release');
  const previous = {home: process.env.MOTE_CODEX_HOME, bin: process.env.MOTE_CODEX_BIN};
  t.after(async () => {
    if (previous.home === undefined) delete process.env.MOTE_CODEX_HOME; else process.env.MOTE_CODEX_HOME = previous.home;
    if (previous.bin === undefined) delete process.env.MOTE_CODEX_BIN; else process.env.MOTE_CODEX_BIN = previous.bin;
    await rm(root, {recursive: true, force: true});
  });
  await writeFile(auth, '{}', {mode: 0o600});
  await writeFile(bin, `#!${process.execPath}
import readline from 'node:readline';
import {writeFileSync,existsSync} from 'node:fs';
const root=${JSON.stringify(root)},started=${JSON.stringify(started)},release=${JSON.stringify(release)},mode=${JSON.stringify(mode)};
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'thread-fixture',model:m.params.model},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn-fixture'}}});
  send({id:999,method:'item/tool/call',params:{threadId:'thread-fixture',turnId:'turn-fixture',tool:'read_image',namespace:null,arguments:{id:${JSON.stringify(id)}}}});
 }else if(m.method==='turn/steer'){
  writeFileSync(started,'');
  while(!existsSync(release))await new Promise(resolve=>setTimeout(resolve,5));
  if(mode==='stale'){send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});return;}
  send({id:m.id,result:{turnId:mode==='wrong'?'other-turn':'turn-fixture'}});
 }else if(m.id===999&&m.result?.success){
  send({method:'item/completed',params:{threadId:'thread-fixture',item:{id:'message-fixture',type:'agentMessage',text:JSON.stringify({answer:'Generated image answer',citationIds:[]})}}});
  send({method:'turn/completed',params:{threadId:'thread-fixture',turn:{status:'completed'}}});
 }
});
`,{mode:0o700});
  process.env.MOTE_CODEX_HOME = root;
  process.env.MOTE_CODEX_BIN = bin;
  const bytes = await sharp({create:{width:4,height:4,channels:3,background:'#abcabc'}}).png().toBuffer();
  const reader = {search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[],readImage:async args=>generatedImageRead(bytes,args)};
  const bridge = await startBridge(reader,{question:'Generated Codex image ack',directImages:[{id,name:'Generated image',mimeType:'image/png',hash:digest(bytes),sizeBytes:bytes.length}]},12);
  t.after(()=>bridge.close());
  const tokens = [], ackBodies = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/_image_delivery')) ackBodies.push(JSON.parse(options.body));
    return originalFetch(url, options);
  };
  t.after(() => {globalThis.fetch = originalFetch;});
  const toolCall = async (name, args) => {
    const response = await fetch(bridge.url + '/' + name, {method:'POST',headers:{Authorization:'Bearer ' + bridge.token,'Content-Type':'application/json'},body:JSON.stringify(args)});
    const body = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(body));
    if (name === 'read_image' && typeof body.imageDelivery === 'string') tokens.push(body.imageDelivery);
    return body;
  };
  const session = new CodexSession({model:'fixture',agentTimeoutMs:5000},toolCall,undefined,undefined,async (token, delivered) => {
    const response = await fetch(bridge.url + '/_image_delivery',{method:'POST',headers:{Authorization:'Bearer ' + bridge.token,'Content-Type':'application/json'},body:JSON.stringify({token,delivered})});
    if (!response.ok) throw new Error('image ack rejected');
  });
  t.after(() => session.close());
  await session.start('Generated image ack', []);
  return {bridge, session, tokens, ackBodies, started, release};
}

test('Codex confirms the same bridge token only after the same-active steer succeeds', async t => {
  const f = await fixture(t, 'success');
  const running = f.session.run('Read generated image');
  await waitFor(f.started);
  assert.equal(f.ackBodies.length, 0, 'no receipt before the steer ACK');
  assert.equal(f.bridge.records.size, 0);
  assert.deepEqual(f.bridge.evidenceDependencies.ids, []);
  await writeFile(f.release, '');
  await running;
  assert.equal(f.ackBodies.length, 1);
  assert.deepEqual(f.ackBodies[0], {token: f.tokens[0], delivered: true});
  assert.equal(f.bridge.records.get(id).ocrText, '');
  assert.deepEqual(f.bridge.evidenceDependencies.ids, [id]);
  assert.equal(parseAnswer(JSON.stringify({answer:`Generated [${id}]`,citationIds:[id]}), f.bridge.records).citations[0].id, id);
  const read = async args => {
    const response = await fetch(f.bridge.url + '/read_image', {method:'POST',headers:{Authorization:'Bearer ' + f.bridge.token,'Content-Type':'application/json'},body:JSON.stringify(args)});
    return {status:response.status, body:await response.json()};
  };
  const duplicate = await read({id});
  assert.equal(duplicate.body.imageDisclosure.status, 'already_disclosed');
  assert.equal(duplicate.body.imageDelivery, undefined);
  assert.equal(f.ackBodies.length, 1, 'duplicate pixels do not issue a second receipt');
  assert.equal(f.bridge.records.size, 1);
  const metadata = await read({id, view:'metadata'});
  assert.equal(metadata.body.imageDelivery, undefined);
  assert.equal(f.ackBodies.length, 1, 'metadata-only reads issue no receipt');
  assert.deepEqual(f.bridge.evidenceDependencies.ids, [id]);
});

for (const mode of ['wrong', 'stale']) {
  test(`Codex releases the image reservation with false on ${mode} steer`, async t => {
    const f = await fixture(t, mode);
    const running = f.session.run('Read generated image');
    await waitFor(f.started);
    await writeFile(f.release, '');
    await assert.rejects(running);
    assert.equal(f.ackBodies.length, 1);
    assert.deepEqual(f.ackBodies[0], {token: f.tokens[0], delivered: false});
    assert.equal(f.bridge.records.size, 0);
    assert.deepEqual(f.bridge.evidenceDependencies.ids, []);
    assert.throws(() => parseAnswer(JSON.stringify({answer:`Generated [${id}]`,citationIds:[id]}), f.bridge.records), {reason:'unretrieved_citation'});
  });
}
