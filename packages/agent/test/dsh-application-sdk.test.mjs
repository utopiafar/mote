import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.ts';

test('APP uses the original SDK wire and Factory resume to retain a private session across children, with one writer', {timeout: 30000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-application-sdk-')), cwd = join(root, 'workspace'), trace = join(root, 'factory.jsonl');
  await mkdir(cwd);
  const requests = [], children = [];
  const firstRequest = Promise.withResolvers(), firstResponse = Promise.withResolvers();
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (requests.length === 1) {firstRequest.resolve(); await firstResponse.promise;}
    writeMessagesResponse(res, {stage: requests.length, model: 'generated-app', text: 'GENERATED-NATIVE-OUTPUT-' + requests.length});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    firstResponse.resolve();
    try {
      await Promise.allSettled(children.map(child => child.close()));
    } finally {
      server.closeAllConnections();
      try {await new Promise(resolve => server.close(resolve));}
      finally {await rm(root, {recursive: true, force: true});}
    }
  });
  const factory = join(root, 'original-factory.mjs');
  // SDK append is best-effort; an awaited session flush materializes the session
  // and holds its cross-process writer lease until the owning handle closes.
  await writeFile(factory, `import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import Loop from ${JSON.stringify(import.meta.resolve('@deepseek-ai/dsh-agent-loop'))};const trace=method=>appendFileSync(${JSON.stringify(trace)},JSON.stringify({method,pid:process.pid})+'\\n');export const name='original-application-factory';export const inject=['agents','sessions','sessionProjections','systemPrompt','tools','llm','sessionPersistence'];export function apply(ctx){class OriginalLoop extends Loop{async createAgent(owner,options){trace('create');const handle=await super.createAgent(owner,options);if(!await ctx.sessions.flush(handle.agent.session))throw new Error('Session persistence flush listener is required');return handle;}async resume(owner,options){trace('resume');return super.resume(owner,options);}}new OriginalLoop(ctx,{agents:[],maxParallelToolCalls:{get:()=>10}});ctx.on('agent/request',async(_,next)=>{const path=join(process.cwd(),'application-state.json'),count=existsSync(path)?JSON.parse(readFileSync(path,'utf8')).count:0;writeFileSync(path,JSON.stringify({count:count+1}));return next();});}`);
  const adapter = new URL('../dist/runtime/dsh/application-sdk.js', import.meta.url).href;
  const patch = async application => {
    const file = join(root, application ? 'application.patch.json' : 'original.patch.json');
    await writeFile(file, JSON.stringify([
      {id: 'agent-loop', disabled: true}, {id: 'persistent-bash', disabled: true}, {id: 'persistent-pwsh', disabled: true},
      {id: 'llm-deepseek', config: {thinking: 'disabled', maxTokens: 1024, streamIdleTimeoutMs: 10000, baseURL: `http://127.0.0.1:${server.address().port}/v1`, models: [{id: 'generated-app', name: 'generated-app', contextWindow: 128000, maxTokens: 1024, inputModalities: ['text']}] }},
      ...(application ? [{id: 'sdk-jsonrpc-server', disabled: true}] : []),
      {insert: [{id: 'original-application-factory', name: pathToFileURL(factory).href}, ...(application ? [{id: 'mote-application-sdk', name: adapter, inject: ['sdkAppStartup', 'loader', 'agents', 'sessionPersistence']}] : [])]},
    ]));
    return file;
  };
  const make = async application => {
    const child = new DeepSeekHarness({profile: 'sdk-minimal', patches: [await patch(application)], dshHome: join(root, 'home'), cwd, processCwd: cwd, provider: 'deepseek-official', model: 'generated-app', maxTokens: 1024, initializeTimeoutMs: 10000, requestTimeoutMs: 10000, env: {PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: root, DEEPSEEK_API_KEY: 'generated-unused'}});
    children.push(child); return child;
  };
  const first = await make(false);
  const firstRun = first.run('FIRST-GENERATED-APPLICATION-STEP', {sessionId: 'application-session'});
  try {
    await Promise.race([firstRequest.promise, firstRun.then(() => assert.fail('First run completed before its held provider request'))]);
    const concurrent = await make(true);
    await assert.rejects(concurrent.run('A second writer cannot take the session', {sessionId: 'application-session'}));
    await concurrent.close(); assert.equal(requests.length, 1);
  } finally {
    firstResponse.resolve();
  }
  assert.equal((await firstRun).finalResponse, 'GENERATED-NATIVE-OUTPUT-1');
  await first.close();
  const original = await make(false);
  await assert.rejects(original.run('Original SDK creation cannot reopen stored history', {sessionId: 'application-session'}), /already exists/);
  await original.close(); assert.equal(requests.length, 1);
  const restored = await make(true);
  assert.equal((await restored.run('SECOND-GENERATED-APPLICATION-STEP', {sessionId: 'application-session'})).finalResponse, 'GENERATED-NATIVE-OUTPUT-2');
  await restored.close();
  assert.ok(JSON.stringify(requests[1]).includes('FIRST-GENERATED-APPLICATION-STEP'));
  assert.ok(JSON.stringify(requests[1]).includes('GENERATED-NATIVE-OUTPUT-1'));
  assert.equal(JSON.parse(await readFile(join(cwd, 'application-state.json'), 'utf8')).count, 2);
  const events = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.method === 'resume').length, 2);
  assert.equal(new Set(events.map(event => event.pid)).size, 4);
  for (const pid of new Set(events.map(event => event.pid))) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});
