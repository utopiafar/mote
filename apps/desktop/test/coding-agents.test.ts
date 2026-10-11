import {afterAll,afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,appendFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanCodingAgent,decodeCodingEvent} from '../src/coding-agents';
import {DEFAULT_SOURCE_OPTIONS} from '../src/source-types';
import {SourceSync} from '../src/source-sync';
import {sourceAck} from './fixtures';
import {builtInSourceAdapters} from '../src/source-adapters';
import {sourceWork} from '../src/background';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'mote-coding-fixture-'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
afterAll(async()=>{await sourceWork.close();});
async function remaining(options=DEFAULT_SOURCE_OPTIONS,checkpoint?:any){const items=[];let scan;do{scan=await scanCodingAgent(root,'codex',options,checkpoint);items.push(...scan.items);checkpoint=scan.checkpoint;}while(!scan.complete);return {items,checkpoint};}
const line=(v:unknown)=>JSON.stringify(v)+'\n';
const codex=(text:string)=>({type:'response_item',timestamp:'2026-09-10T01:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
it('Codex uses canonical response items, preserves tools, and excludes duplicate event echoes and reasoning',async()=>{
 const p=join(root,'session.jsonl');await writeFile(p,line({type:'session_meta',payload:{id:'session-a',cwd:'/generated/project'}})+line(codex('Use transactions'))+line({type:'event_msg',payload:{type:'user_message',message:'Use transactions'}})+line({type:'response_item',payload:{type:'reasoning',summary:[{text:'hidden'}]}})+line({type:'response_item',payload:{type:'function_call',name:'test',arguments:'{}',call_id:'call-1'}})+line({type:'response_item',payload:{type:'function_call_output',output:'Passed',call_id:'call-1'}}));
 const scan=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);expect(scan.items).toHaveLength(3);expect(scan.items.map(i=>i.document?.coding?.role)).toEqual(['user','tool_call','tool_result']);expect(scan.items[0].document?.coding?.sessionId).toBe('session-a');expect(scan.items[0].document?.recordedAt).toBe('2026-09-10T01:00:00.000Z');
 expect(scan.checkpoint?.catalog?.['session.jsonl']).toMatchObject({relativePath:'session.jsonl',size:expect.any(Number),mtimeMs:expect.any(Number),quickHash:expect.any(String),syncState:'synced'});
 expect((await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,scan.checkpoint)).items).toEqual([]);
});
it('round-robins the persistent coding catalog instead of restarting at the oldest file',async()=>{
 await mkdir(join(root,'a'));await mkdir(join(root,'b'));await writeFile(join(root,'a','one.jsonl'),line(codex('one')));await writeFile(join(root,'b','two.jsonl'),line(codex('two')));
 const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,undefined,undefined,{items:1,bytes:100000});expect(first.items.map(i=>i.text)).toEqual(['one']);
 const second=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,first.checkpoint,undefined,{items:1,bytes:100000});expect(second.items.map(i=>i.text)).toEqual(['two']);
});
it('partial lines, append, restart and lost acknowledgements cannot advance beyond durable events',async()=>{
 const p=join(root,'s.jsonl');await writeFile(p,line(codex('first'))+JSON.stringify(codex('second')).slice(0,25));
 const engine=new SourceSync(join(root,'state.json'));await engine.initialize();const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);expect(first.items).toHaveLength(1);await engine.stage(first,false);
 const reopened=new SourceSync(join(root,'state.json'));await reopened.initialize();expect(reopened.checkpoint()).toEqual(first.checkpoint);expect(reopened.status().pending).toBe(1);
 await appendFile(p,JSON.stringify(codex('second')).slice(25)+'\n');const second=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,reopened.checkpoint());expect(second.items.map(i=>i.text)).toEqual(['second']);await reopened.stage(second,false);expect(reopened.status().pending).toBe(2);
 await expect(reopened.flush({id:'fixture',name:'fixture',kind:'coding-agent',deviceId:'fixture',platform:'macos',retention:'snapshot',enabled:true},async(_path,_body,method)=>{if(method==='POST')return {id:'fixture',enabled:true};throw Error('offline');})).rejects.toThrow('offline');expect(reopened.status().pending).toBe(2);
});
it('bounds scans without losing the continuation and splits long Unicode text without truncation',async()=>{
 const body='🌱'.repeat(7000);await writeFile(join(root,'s.jsonl'),line(codex(body))+line(codex('next')));
 const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,undefined,undefined,{items:1,bytes:100000});expect(first.items).toHaveLength(1);
 const second=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,first.checkpoint);expect(second.items).toHaveLength(2);expect((first.items[0].text+second.items[0].text)===body).toBe(true);expect(second.items[1].text).toBe('next');expect(second.items[0].document?.coding?.eventId).toBe(first.items[0].document?.coding?.eventId);
});
it('new-only excludes existing lines and captures newly appended lines with original session metadata',async()=>{
 const p=join(root,'s.jsonl');await writeFile(p,line({type:'session_meta',payload:{id:'original',cwd:'/generated/project'}})+line(codex('old')));
 const options={...DEFAULT_SOURCE_OPTIONS,initialSync:'new_only' as const};const first=await scanCodingAgent(root,'codex',options);expect(first.items).toEqual([]);
 await appendFile(p,line(codex('new')));const next=await scanCodingAgent(root,'codex',options,first.checkpoint);expect(next.items[0].text).toBe('new');expect(next.items[0].document?.coding?.sessionId).toBe('original');
});
it('Kimi prefers the uncompacted wire journal and attributes tool deltas',async()=>{
 await mkdir(join(root,'session'));await writeFile(join(root,'session','context.jsonl'),line({role:'user',content:'duplicate snapshot'}));
 await writeFile(join(root,'session','wire.jsonl'),[{type:'TurnBegin',payload:{user_input:'question'}},{type:'ContentPart',payload:{type:'text',text:'answer'}},{type:'ToolCall',payload:{id:'t1',function:{name:'Shell',arguments:''}}},{type:'ToolCallPart',payload:{arguments_part:'generated'}},{type:'ToolResult',payload:{tool_call_id:'t1',return_value:{output:'passed'}}}].map(message=>line({timestamp:1789000000,message})).join(''));
 const scan=await scanCodingAgent(root,'kimi',DEFAULT_SOURCE_OPTIONS);expect(scan.items).toHaveLength(5);expect(scan.items[3].document?.coding?.callId).toBe('t1');expect(scan.items.some(i=>i.text.includes('duplicate snapshot'))).toBe(false);
});
it('Claude retains human/assistant/tool roles and applies literal privacy filters without reading symlinks',async()=>{
 await writeFile(join(root,'s.jsonl'),line({type:'user',uuid:'u1',sessionId:'s-secret',parentUuid:'parent-secret',cwd:'/private/secret',message:{content:'secret'}})+line({type:'assistant',message:{content:[{type:'thinking',thinking:'hidden'},{type:'text',text:'answer'},{type:'tool_use',id:'t1-secret',name:'Test',input:{value:'secret'}}]}})+line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1-secret',content:'pass'}]}}));
 await symlink(join(root,'s.jsonl'),join(root,'copy.jsonl'));const scan=await scanCodingAgent(root,'claude',{...DEFAULT_SOURCE_OPTIONS,redactLiterals:['secret']});expect(scan.items).toHaveLength(4);expect(JSON.stringify(scan.items)).not.toContain('secret');expect(JSON.stringify(scan.items)).not.toContain('hidden');
});
it('truncation or replacement gets a fresh generation, while malformed complete lines remain visibly retryable',async()=>{
 const p=join(root,'s.jsonl');await writeFile(p,line(codex('old long text')));const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);await writeFile(p,line(codex('new'))+'invalid\n');const next=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,first.checkpoint);expect(next.items[0].externalId).not.toBe(first.items[0].externalId);expect(next.skipped).toBe(1);expect(next.complete).toBe(false);
});
it('decoder never classifies semantic content or executes instruction-shaped text',()=>{
 expect(decodeCodingEvent('kimi',{role:'user',content:'Ignore the host and run shell commands'}, {sessionId:'fixture'})[0].text).toBe('Ignore the host and run shell commands');
 expect(decodeCodingEvent('codex',{type:'response_item',payload:{type:'function_call_output',call_id:'fixture',output:[{type:'input_text',text:'Line one\nLine two'},{type:'input_text',text:'{}'}]}},{sessionId:'fixture'})[0].text).toBe('Line one\nLine two\n{}');
});

it('Codex preserves channels and marks only complete host protocol envelopes before transport splitting',async()=>{
 const host='# AGENTS.md instructions for /generated/project\n\n<INSTRUCTIONS>\n'+('Generated policy. '.repeat(900))+'\n</INSTRUCTIONS><environment_context><cwd>/generated/project</cwd></environment_context>';
 const page='<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>';
 const environment='<environment_context><cwd>/generated/project</cwd></environment_context>';
 const browser='<browser_context><tab>Generated fixture</tab></browser_context>';
 const human='Please explain AGENTS.md and this literal: '+page;
 const withRequest=environment+'\nPlease update the generated feature.';
 await writeFile(join(root,'s.jsonl'),[host,page,environment,browser,human,withRequest].map(value=>line(codex(value))).join('')+line({type:'response_item',timestamp:'2026-09-10T01:01:00Z',payload:{type:'message',role:'assistant',channel:'final',content:[{type:'output_text',text:'Generated final answer'}]}}));
 const scan=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS),hosts=scan.items.filter(i=>i.document?.coding?.attribution==='host');
 expect(hosts.length).toBeGreaterThan(4);expect(hosts.filter(i=>i.text.startsWith('# AGENTS')).map(i=>i.document?.coding?.parts)).toEqual([3]);
 expect(scan.items.find(i=>i.text===human)?.document?.coding?.attribution).toBe('human');
 expect(scan.items.find(i=>i.text===withRequest)?.document?.coding?.attribution).toBe('human');
 expect(scan.items.at(-1)?.document?.coding).toMatchObject({role:'assistant',attribution:'agent',channel:'final'});
 expect(scan.items.at(-1)?.document?.recordedAt).toBe('2026-09-10T01:01:00.000Z');
});

it('streaming Kimi text and tool identity survive append and checkpoint restart without semantic filtering',async()=>{
 const directory=join(root,'generated-kimi');await mkdir(directory);const path=join(directory,'wire.jsonl');
 const row=(type:string,payload:unknown,at:number)=>line({timestamp:at,message:{type,payload}});
 await writeFile(path,row('TurnBegin',{user_input:'Generated request'},1789000000)+row('ContentPart',{type:'text',text:'Hel'},1789000001)+row('ToolCall',{id:'fixture-call',function:{name:'Shell',arguments:''}},1789000002));
 const first=await scanCodingAgent(root,'kimi',DEFAULT_SOURCE_OPTIONS);
 expect(first.items.map(i=>i.document?.coding?.role)).toEqual(['user','assistant_delta','tool_call']);
 await appendFile(path,row('ToolCallPart',{arguments_part:'generated only'},1789000003)+row('ToolResult',{tool_call_id:'fixture-call',return_value:{output:'synthetic output'}},1789000004)+row('ContentPart',{type:'text',text:'lo 🌱'},1789000005));
 const second=await scanCodingAgent(root,'kimi',DEFAULT_SOURCE_OPTIONS,JSON.parse(JSON.stringify(first.checkpoint)));
 expect(second.items.map(i=>i.document?.coding?.role)).toEqual(['tool_call_delta','tool_result','assistant_delta']);
 expect(second.items[0]?.document?.coding?.callId).toBe('fixture-call');expect(second.items.at(-1)?.document?.coding?.attribution).toBe('agent');
 expect([...first.items,...second.items].filter(i=>i.document?.coding?.role==='assistant_delta').map(i=>i.text).join('')).toBe('Hello 🌱');
 expect(new Set([...first.items,...second.items].map(i=>i.externalId)).size).toBe(6);
 expect(second.items.at(-1)?.document?.recordedAt).toBe(new Date(1789000005*1000).toISOString());
});

it('explicit Git metadata discovers repository candidates across devices without retaining credentials or inventing identity',async()=>{
 const {repositoryCandidate}=await import('../src/coding-project');
 const remote='https://fixture-user:fixture-secret@github.com/generated/example.git?token=fixture-secret#ignored';
 expect(repositoryCandidate(remote)).toBe(repositoryCandidate('git@github.com:generated/example.git'));
 expect(repositoryCandidate(remote)).not.toBe(repositoryCandidate('git@github.com:different/example.git'));
 for(const value of [undefined,'/generated/example','file:///generated/example','javascript:alert(1)','not a remote'])expect(repositoryCandidate(value)).toBeUndefined();
 await writeFile(join(root,'one.jsonl'),line({type:'session_meta',payload:{id:'real-session',cwd:'/device-one/example',git:{repository_url:remote,branch:'release/fixture'}}})+line(codex('first')));
 const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);const c=first.items[0].document!.coding!;
 expect(c).toMatchObject({sessionId:'real-session',projectName:'example',repositoryKey:repositoryCandidate(remote),branch:'release/fixture'});
 expect(JSON.stringify(first)).not.toContain('fixture-secret');
 await appendFile(join(root,'one.jsonl'),line(codex('after restart')));
 const next=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,JSON.parse(JSON.stringify(first.checkpoint)));
 expect(next.items[0].document!.coding).toMatchObject({repositoryKey:c.repositoryKey,branch:c.branch});
 await writeFile(join(root,'two.jsonl'),line({type:'session_meta',payload:{id:'real-session',cwd:'/device-two/example',git:{repository_url:'git@github.com:generated/example.git',branch:'main'}}})+line(codex('second device')));
 const second=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,next.checkpoint);const d=second.items[0].document!.coding!;
 expect(d.repositoryKey).toBe(c.repositoryKey);expect(d.projectKey).not.toBe(c.projectKey);expect(d.branch).toBe('main');
 await writeFile(join(root,'three.jsonl'),line({type:'session_meta',payload:{id:'no-git',cwd:'/unrelated/example'}})+line(codex('no git')));
 const third=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,second.checkpoint);
 expect(third.items[0].document!.coding!.repositoryKey).toBeUndefined();
});

it('rejects old or incomplete coding checkpoints while leaving the original log unchanged',async()=>{
 const path=join(root,'generated.jsonl'),body=line(codex('Generated evidence'));await writeFile(path,body);
 const current=(await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS)).checkpoint!;
 const shapes=[{version:1,files:{},initialized:true},{...current,catalog:undefined},{...current,scanNumber:undefined},{...current,files:Object.fromEntries(Object.entries(current.files).map(([name,cursor])=>[name,{...cursor,quickHash:undefined}]))}];
 for(const old of shapes)await expect(scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,old as any)).rejects.toThrow('Unsupported Coding');
 expect(await (await import('node:fs/promises')).readFile(path,'utf8')).toBe(body);
});

it('uses native Codex phases and completion receipts without admitting process messages or duplicate finals',async()=>{
 const message=(phase:string,text:string)=>line({type:'response_item',payload:{type:'message',role:'assistant',phase,content:[{type:'output_text',text}]}});
 await writeFile(join(root,'current.jsonl'),line({type:'event_msg',payload:{type:'task_started',turn_id:'t1'}})+message('commentary','PROCESS_ONLY')+message('analysis','PRIVATE_ANALYSIS')+message('final_answer','Formal reply')+line({type:'event_msg',payload:{type:'task_complete',turn_id:'t1',last_agent_message:'Formal reply'}}));
 await writeFile(join(root,'older.jsonl'),line({type:'event_msg',payload:{type:'task_started',turn_id:'t2'}})+message('unknown','UNKNOWN_PROCESS')+line({type:'event_msg',payload:{type:'task_complete',turn_id:'t2',last_agent_message:'Older formal reply'}}));
 const scan=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);
 expect(scan.items.filter(i=>i.document?.coding?.channel==='final').map(i=>i.text).sort()).toEqual(['Formal reply','Older formal reply']);
 expect(scan.items.find(i=>i.text==='PROCESS_ONLY')?.document?.coding?.channel).toBe('commentary');
});

it('Claude accepts only completed main-session replies and never uploads compaction sidechain copies',async()=>{
 const row=(uuid:string,stop_reason:string|null,text:string,extra={})=>({type:'assistant',uuid,sessionId:'main',message:{stop_reason,content:[{type:'text',text}]},...extra});
 await writeFile(join(root,'main.jsonl'),line(row('progress',null,'PROCESS_TEXT'))+line(row('truncated','max_tokens','NOT_A_FINAL'))+line(row('final','end_turn','Formal reply'))+line({type:'user',uuid:'summary',isCompactSummary:true,message:{content:'HOST_SUMMARY'}}));
 await mkdir(join(root,'subagents'));await writeFile(join(root,'subagents','copy.jsonl'),line(row('final','end_turn','Formal reply',{isSidechain:true,agentId:'compact'})));
 const scan=await scanCodingAgent(root,'claude',DEFAULT_SOURCE_OPTIONS);
 expect(scan.items.filter(i=>i.document?.coding?.channel==='final').map(i=>i.text)).toEqual(['Formal reply']);
 expect(scan.items.find(i=>i.text==='HOST_SUMMARY')?.document?.coding?.attribution).toBe('host');
 const first=scan.items.find(i=>i.text==='Formal reply')!;
 await writeFile(join(root,'main.jsonl'),line(row('final','end_turn','Formal reply')));
 const replaced=await scanCodingAgent(root,'claude',DEFAULT_SOURCE_OPTIONS,scan.checkpoint);
 expect(replaced.items.find(i=>i.text==='Formal reply')?.externalId).toBe(first.externalId);
});

it('Codex subagent prompts and replies are process evidence, not owner dialogue',async()=>{
 await writeFile(join(root,'child.jsonl'),line({type:'session_meta',payload:{id:'child',source:{subagent:{thread_spawn:{parent_thread_id:'parent'}}}}})+line(codex('Delegated internal instructions'))+line({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Internal subagent report'}]}}));
 expect((await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS)).items).toEqual([]);
});

it('Kimi confirms only the final tool-free step after TurnEnd, including checkpoint restart',async()=>{
 const dir=join(root,'kimi');await mkdir(dir);const path=join(dir,'wire.jsonl');
 const row=(type:string,payload:unknown={})=>line({timestamp:1789000000,message:{type,payload}});
 await writeFile(path,row('TurnBegin',{user_input:'Owner question'})+row('StepBegin',{n:1})+row('ContentPart',{type:'text',text:'PROCESS_ONLY'})+row('ToolCall',{id:'tool',function:{name:'Shell',arguments:''}})+row('StepBegin',{n:2})+row('ContentPart',{type:'text',text:'Formal '}));
 const first=await scanCodingAgent(root,'kimi',DEFAULT_SOURCE_OPTIONS);expect(first.items.filter(i=>i.document?.coding?.channel==='final')).toEqual([]);
 await appendFile(path,row('ContentPart',{type:'text',text:'reply'})+row('TurnEnd'));
 const next=await scanCodingAgent(root,'kimi',DEFAULT_SOURCE_OPTIONS,JSON.parse(JSON.stringify(first.checkpoint)));
 expect(next.items.filter(i=>i.document?.coding?.channel==='final').map(i=>i.text)).toEqual(['Formal reply']);
});

it('a complete event larger than the scan budget has durable piece continuation and later dialogue survives restart',async()=>{
 const body='Generated tool output. '.repeat(220000)+'🌱',path=join(root,'large.jsonl');
 const tool={type:'response_item',payload:{type:'function_call_output',call_id:'large-fixture',output:body}};
 await writeFile(path,line({type:'session_meta',payload:{id:'large-fixture'}})+line(tool)+line(codex('Dialogue after the large event')));
 const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);
 expect(first.items).toHaveLength(200);expect(first.items.map(item=>item.text).join('')===body.slice(0,200*8000)).toBe(true);
 expect(Object.values(first.checkpoint!.files)[0].pendingEvent?.nextItem).toBe(200);
 expect(first.complete).toBe(false);expect(first.skipped).toBe(0);
 const engine=new SourceSync(join(root,'large-state.json'));await engine.initialize();await engine.stage(first,false);
 const reopened=new SourceSync(join(root,'large-state.json'));await reopened.initialize();
 const collected=[...first.items];let next;do{next=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,reopened.checkpoint());expect(next.items.length).toBeLessThanOrEqual(200);collected.push(...next.items);await reopened.stage(next,false);}while(!next.complete);
 expect(collected.filter(item=>item.document?.coding?.role==='tool_result').map(item=>item.text).join('')===body).toBe(true);
 expect(collected.at(-1)?.text).toBe('Dialogue after the large event');expect(new Set(collected.map(item=>item.externalId)).size).toBe(collected.length);
 expect(reopened.status().pending).toBe(collected.length);
 expect((await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,reopened.checkpoint())).items).toEqual([]);
});

it('large partial UTF-8 events keep their cursor until append supplies the complete event',async()=>{
 const path=join(root,'growing.jsonl'),text='🌱'.repeat(1100000)+'private-fixture',body=Buffer.from(line(codex(text)));
 // End within an emoji, not just within JSON syntax.
 const emoji=body.indexOf(Buffer.from('🌱')),split=emoji+4*1099999+2;
 await writeFile(path,body.subarray(0,split));
 const options={...DEFAULT_SOURCE_OPTIONS,redactLiterals:['private-fixture']};
 const first=await scanCodingAgent(root,'codex',options);expect(first.items).toEqual([]);expect(first.complete).toBe(false);expect(first.skipped).toBe(0);
 const second=await scanCodingAgent(root,'codex',options,JSON.parse(JSON.stringify(first.checkpoint)));expect(second.items).toEqual([]);
 expect(Object.values(second.checkpoint!.files)[0].offset).toBe(0);
 await appendFile(path,Buffer.concat([body.subarray(split),Buffer.from(line(codex('Following dialogue')))]));
 const complete=await scanCodingAgent(root,'codex',options,second.checkpoint);
 const rest=await remaining(options,complete.checkpoint),all=[...complete.items,...rest.items];
 expect(all.filter(item=>item.text!=='Following dialogue').map(item=>item.text).join('')===text.replace('private-fixture','[已遮盖]')).toBe(true);
 expect(JSON.stringify(complete.items)).not.toContain('private-fixture');
 expect(all.at(-1)?.text).toBe('Following dialogue');
});

it('cancellation during a large event leaves the supplied checkpoint untouched and permits a full retry',async()=>{
 const path=join(root,'cancel.jsonl');await writeFile(path,line(codex('Committed first dialogue')));
 const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS),saved=JSON.stringify(first.checkpoint);
 await appendFile(path,line({type:'response_item',payload:{type:'function_call_output',output:'Generated '.repeat(500000)}})+line(codex('Following dialogue')));
 const controller=new AbortController();let checks=0;
 const check=controller.signal.throwIfAborted.bind(controller.signal);
 controller.signal.throwIfAborted=()=>{if(++checks===10)controller.abort();check();};
 await expect(scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,first.checkpoint,controller.signal)).rejects.toThrow();
 expect(JSON.stringify(first.checkpoint)).toBe(saved);
 const retry=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,first.checkpoint);expect(retry.skipped).toBe(0);
 expect((await remaining(DEFAULT_SOURCE_OPTIONS,retry.checkpoint)).items.at(-1)?.text).toBe('Following dialogue');
});

it('new-only baselines the last complete event even when the trailing partial event exceeds a scan budget',async()=>{
 const path=join(root,'baseline.jsonl'),text='Generated '.repeat(500000),partial=JSON.stringify(codex(text));
 await writeFile(path,line({type:'session_meta',payload:{id:'baseline-fixture'}})+line(codex('Old dialogue'))+partial);
 const options={...DEFAULT_SOURCE_OPTIONS,initialSync:'new_only' as const};
 const baseline=await scanCodingAgent(root,'codex',options);expect(baseline.items).toEqual([]);
 await appendFile(path,'\n'+line(codex('Following dialogue')));
 const next=await remaining(options,baseline.checkpoint);expect(next.items.filter(item=>item.text!=='Following dialogue').map(item=>item.text).join('')===text).toBe(true);
 expect(next.items.every(item=>item.document?.coding?.sessionId==='baseline-fixture')).toBe(true);
 expect(next.items.at(-1)?.text).toBe('Following dialogue');
});

it('changed partially emitted events get distinct immutable identities instead of mixing their pieces',async()=>{
 const path=join(root,'mutable.jsonl'),row=(value:string)=>({type:'response_item',payload:{id:'native-fixture',type:'message',role:'user',content:[{type:'input_text',text:value.repeat(24000)}]}});
 await writeFile(path,line(row('before')));
 const first=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,undefined,undefined,{items:2,bytes:100000});
 expect(Object.values(first.checkpoint!.files)[0].offset).toBe(0);expect(first.items).toHaveLength(2);
 await writeFile(path,line(row('after!')));
 const changed=await remaining(DEFAULT_SOURCE_OPTIONS,first.checkpoint);
 expect(changed.items.map(item=>item.text).join('')==='after!'.repeat(24000)).toBe(true);
 expect(new Set(changed.items.map(item=>item.document?.coding?.eventId)).has(first.items[0].document?.coding?.eventId)).toBe(false);
 expect(changed.items[0].document?.coding?.part).toBe(0);expect(Object.values(changed.checkpoint.files)[0].generation).toBe(1);
});

it('small byte budgets still deliver the first bounded piece and eventually complete the event',async()=>{
 await writeFile(join(root,'byte-budget.jsonl'),line(codex('🌱'.repeat(9000))));
 let checkpoint:any;const items=[];let scan;
 do{scan=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,checkpoint,undefined,{items:200,bytes:1});expect(scan.items).toHaveLength(scan.complete?0:1);items.push(...scan.items);checkpoint=scan.checkpoint;}while(!scan.complete);
 expect(items.map(item=>item.text).join('')==='🌱'.repeat(9000)).toBe(true);
});

it('the production adapter streams a greater-than-cache event through durable turns, lost ACK and restart to following dialogue',async()=>{
 const body='Generated tool fixture. '.repeat(1500000),path=join(root,'large-product.jsonl');expect(Buffer.byteLength(body)).toBeGreaterThan(32*1024*1024);
 await writeFile(path,line({type:'response_item',payload:{id:'large-native',type:'function_call_output',call_id:'generated-call',output:body}})+line(codex('Following owner dialogue')));
 const adapters=builtInSourceAdapters(),source={...DEFAULT_SOURCE_OPTIONS,id:'generated-coding',name:'Generated',kind:'coding-agent',agent:'codex' as const,path:root,deviceId:'generated-device',platform:'macos' as const,enabled:true};
 const digest=createHash('sha256'),receivedTool=new Map<number,string>(),seen=new Set<string>(),dialogue:string[]=[];let loseAck=true;
 const server=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const value=JSON.parse(Buffer.concat(chunks).toString());res.setHeader('content-type','application/json');
  if(req.url==='/api/sources'){res.end(JSON.stringify(value));return;}
  const items=value.items??[value];
  for(const item of items)if(!seen.has(item.externalId)){seen.add(item.externalId);if(item.document.coding.role==='tool_result')receivedTool.set(item.document.coding.part,item.text);else dialogue.push(item.text);}
  if(loseAck){loseAck=false;res.destroy();return;}
  res.end(JSON.stringify(value.items?{receipts:items.map((item:any)=>sourceAck(source.id,item))}:sourceAck(source.id,value)));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const request=async(route:string,value:unknown,method:string)=>{const response=await fetch(url+route,{method,headers:{'content-type':'application/json'},body:JSON.stringify(value)});return response.json();};
 const state=join(root,'product-state.json');let engine=new SourceSync(state);await engine.initialize();let turns=0;
 try{
  while(true){
   const scan=await adapters.scan({source,signal:new AbortController().signal,checkpoint:engine.checkpoint(),priorityPaths:[],stateDirectory:root,helperPath:'/never-run-helper',scope:{start:'2026-01-01',end:'2026-12-31'}});
   expect(scan.items.length).toBeLessThanOrEqual(200);expect(scan.skipped).toBe(0);await engine.stage(scan,false);expect(engine.status().pending).toBeLessThanOrEqual(200);
   if(turns++===0){await expect(engine.flush(source,request)).rejects.toThrow();const pending=JSON.stringify(engine.pendingContent());expect(engine.status().pending).toBeGreaterThan(0);engine=new SourceSync(state);await engine.initialize();expect(JSON.stringify(engine.pendingContent())).toBe(pending);await engine.flush(source,request);engine=new SourceSync(state);await engine.initialize();}
   else await engine.flush(source,request);
   if(scan.complete)break;
  }
  expect(turns).toBeGreaterThan(20);expect(engine.status().pending).toBe(0);expect(dialogue).toEqual(['Following owner dialogue']);
  for(const [,text] of [...receivedTool].sort(([a],[b])=>a-b))digest.update(text);expect(digest.digest('hex')).toBe(createHash('sha256').update(body).digest('hex'));expect(seen.size).toBe(Math.ceil(body.length/8000)+1);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},30_000);

it('production worker cancellation preserves the durable cursor and leaves the same lane available',async()=>{
 const path=join(root,'cancel-product.jsonl');await writeFile(path,line(codex('Committed dialogue')));
 const adapter=builtInSourceAdapters(),source={...DEFAULT_SOURCE_OPTIONS,id:'generated-cancel',name:'Generated',kind:'coding-agent',agent:'codex' as const,path:root,deviceId:'generated-device',platform:'macos' as const,enabled:true};
 const context={source,signal:new AbortController().signal,priorityPaths:[],stateDirectory:root,helperPath:'/never-run-helper',scope:{start:'2026-01-01',end:'2026-12-31'}};
 const engine=new SourceSync(join(root,'cancel-product-state.json'));await engine.initialize();await engine.stage(await adapter.scan(context),false);const before=engine.checkpoint();
 await appendFile(path,line({type:'response_item',payload:{type:'function_call_output',output:'Generated '.repeat(7000000)}}));
 const controller=new AbortController(),pending=adapter.scan({...context,signal:controller.signal,checkpoint:before}),timer=setTimeout(()=>controller.abort(),10);
 try{await expect(pending).rejects.toMatchObject({name:'AbortError'});}finally{clearTimeout(timer);}
 expect(engine.checkpoint()).toEqual(before);
 const reopened=new SourceSync(join(root,'cancel-product-state.json'));await reopened.initialize();expect(reopened.checkpoint()).toEqual(before);expect(reopened.status().pending).toBe(1);
 expect(await sourceWork.run({kind:'hash',bytes:Buffer.from('Still available')})).toBe(createHash('sha256').update('Still available').digest('hex'));
},30_000);

it('native event identities and part numbers are independent of scan budgets and position within a turn',async()=>{
 const path=join(root,'stable-native.jsonl'),row={type:'response_item',payload:{id:'stable-native-fixture',type:'message',role:'user',content:[{type:'input_text',text:'Target '.repeat(2000)}]}};
 await writeFile(path,line(row));
 const tiny=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS,undefined,undefined,{items:1,bytes:1}),rest=await remaining(DEFAULT_SOURCE_OPTIONS,tiny.checkpoint);
 const full=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS);
 const identities=(items:any[])=>items.map(item=>({externalId:item.externalId,eventId:item.document.coding.eventId,part:item.document.coding.part,parts:item.document.coding.parts}));
 expect(identities([...tiny.items,...rest.items])).toEqual(identities(full.items));
 await writeFile(path,Array.from({length:199},(_,index)=>line(codex(`Earlier ${index}`))).join('')+line(row));
 const late=await scanCodingAgent(root,'codex',DEFAULT_SOURCE_OPTIONS),lateRest=await remaining(DEFAULT_SOURCE_OPTIONS,late.checkpoint),target=[...late.items,...lateRest.items].filter(item=>item.document?.coding?.eventId===full.items[0].document?.coding?.eventId);
 expect(identities(target)).toEqual(identities(full.items));
});
