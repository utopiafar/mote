import {afterEach,expect,it,vi} from 'vitest';
import {AskClient,type AskConversation} from '../src/ask';
import {currentTurnCites,prependConversationTurns,resolveAskConversation} from '../src/ask-conversation';
import {defaultConfig} from '../src/config';

afterEach(()=>vi.unstubAllGlobals());
const id='11111111-1111-4111-8111-111111111111';
const turn=(id:string)=>({id,question:'Generated '+id,status:'completed'});
const page=(ids:string[],nextCursor:string|null,revision=3):AskConversation=>({id,title:'Generated shared conversation',revision,nextCursor,turns:ids.map(turn)});

it('loads every older turn in order without duplicating boundary identities',()=>{
 let value=page(['41','42'],'40');
 value=prependConversationTurns(value,page(['21','40','41'],'20'));
 value=prependConversationTurns(value,page(['1','20'],null));
 expect(value.turns.map(turn=>turn.id)).toEqual(['1','20','21','40','41','42']);
 expect(value.nextCursor).toBeNull();
});
it('rejects older pages from another conversation or a changed current revision',()=>{
 const current=page(['41'],'40');
 expect(()=>prependConversationTurns(current,{...page(['1'],null),id:'22222222-2222-4222-8222-222222222222'})).toThrow();
 expect(()=>prependConversationTurns(current,page(['1'],null,4))).toThrow();
 expect(current.turns.map(turn=>turn.id)).toEqual(['41']);
});

it('reads the server-selected main conversation and validates the returned identity',async()=>{
 const selected='22222222-2222-4222-8222-222222222222';
 const client=new AskClient(),config={...defaultConfig(),credentialScope:'owner' as const,token:'generated-owner-token'.repeat(3)};
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({id:selected})).mockResolvedValueOnce(Response.json({...page(['selected'],null),id:selected})).mockResolvedValueOnce(Response.json({id:'../other'}));
 vi.stubGlobal('fetch',fetcher);
 const chosen=await resolveAskConversation(undefined,()=>client.request(config,'main') as Promise<{id:string}>);
 const conversation=await client.request(config,'conversation',{id:chosen}) as AskConversation;
 expect(conversation.id).toBe(selected);
 expect(fetcher.mock.calls.map(call=>String(call[0]))).toEqual([config.serverUrl+'/api/conversations/main',config.serverUrl+'/api/conversations/'+selected+'?limit=20']);
 expect(await resolveAskConversation(id,()=>client.request(config,'main') as Promise<{id:string}>)).toBe(id);
 await expect(client.request(config,'main')).rejects.toThrow('Invalid conversation ID');
});
it('uses the bounded current conversation endpoint and validates its turn cursor before sending',async()=>{
 const client=new AskClient(),config={...defaultConfig(),credentialScope:'owner' as const,token:'generated-owner-token'.repeat(3)};
 const fetcher=vi.fn(async()=>Response.json(page(['1'],null)));vi.stubGlobal('fetch',fetcher);
 await client.request(config,'conversation',{id});
 await client.request(config,'conversation',{id,cursor:'20'});
 expect(fetcher.mock.calls.map(call=>String(call[0]))).toEqual([config.serverUrl+'/api/conversations/'+id+'?limit=20',config.serverUrl+'/api/conversations/'+id+'?limit=20&cursor=20']);
 for(const cursor of ['../secret','-1','20&limit=10000','1234567890'])await expect(client.request(config,'conversation',{id,cursor})).rejects.toThrow('Invalid turn cursor');
 expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps the current snapshot scope when older turn pages are prepended',()=>{
 const current={...page(['41'],'40'),scope:{anchorEvidenceIds:['current-record']}};
 const older={...page(['1'],null),scope:{evidenceIds:['old-record']}};
 expect(prependConversationTurns(current,older).scope).toEqual(current.scope);
});
it('reads scope unchanged and omits selection fields when continuing the same conversation',async()=>{
 const client=new AskClient(),config={...defaultConfig(),credentialScope:'owner' as const,token:'generated-owner-token'.repeat(3)};
 const value={...page(['1'],null),scope:{evidenceIds:['generated-evidence']}};
 const fetcher=vi.fn(async (_url:string,init?:RequestInit)=>Response.json(init?.method==='POST'?{id,status:'running',events:[]}:value));vi.stubGlobal('fetch',fetcher);
 expect((await client.request(config,'conversation',{id}) as AskConversation).scope).toEqual(value.scope);
 await client.request(config,'start',{id,conversationId:id,question:'Generated follow-up'});
 const body=JSON.parse((fetcher.mock.calls[1] as unknown as [string,RequestInit])[1].body as string);
 expect(body.input.conversationId).toBe(id);expect(body.input).not.toHaveProperty('evidenceIds');expect(body.input).not.toHaveProperty('anchorEvidenceIds');expect(body.input).not.toHaveProperty('anchorMaterialRef');
});


it('checks current reference availability through the exact conversation before any archive navigation',async()=>{
 const client=new AskClient(),config={...defaultConfig(),token:'generated-owner-token'.repeat(3)},evidenceId='22222222-2222-4222-8222-222222222222';
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({id:evidenceId,available:false})));vi.stubGlobal('fetch',fetcher);
 expect(await client.request(config,'reference',{id:evidenceId,conversationId:id})).toEqual({id:evidenceId,available:false});
 expect(String(fetcher.mock.calls[0][0])).toBe(config.serverUrl+'/api/conversations/'+id+'/references/'+evidenceId);
 await expect(client.request(config,'reference',{id:evidenceId,conversationId:'../other'})).rejects.toThrow('Invalid conversation ID');
 await expect(client.request(config,'reference',{id:'../other',conversationId:id})).rejects.toThrow('Invalid ID');expect(fetcher).toHaveBeenCalledTimes(1);
 fetcher.mockImplementation(async()=>new Response(JSON.stringify({id:evidenceId,available:'true'})));
 await expect(client.request(config,'reference',{id:evidenceId,conversationId:id})).rejects.toThrow('Invalid reference availability');
});

it('requires the exact historical turn to retain its citation even if another turn cites the same record',async()=>{
 const evidence='22222222-2222-4222-8222-222222222222';
 const citation={id:evidence,appName:'Generated',capturedAt:'2026-01-01T00:00:00Z',excerpt:'Generated'};
 const newer={...page(['newer'],'20'),turns:[{...turn('newer'),result:{answer:'Other answer',citations:[citation]}}]};
 const erased={...page(['older'],null),turns:[{...turn('older'),evidenceDeleted:true as const,result:{answer:'',citations:[]}}]};
 const load=vi.fn(async(cursor?:string)=>cursor?erased:newer);
 expect(await currentTurnCites(id,'older',evidence,load)).toBe(false);
 expect(load.mock.calls.map(call=>call[0])).toEqual([undefined,'20']);
 const retained={...erased,turns:[{...turn('older'),result:{answer:'Retained answer',citations:[citation]}}]};
 expect(await currentTurnCites(id,'older',evidence,async cursor=>cursor?retained:newer)).toBe(true);
 await expect(currentTurnCites(id,'older',evidence,async cursor=>cursor?{...retained,revision:4}:newer)).rejects.toThrow('对话状态已变化');
 await expect(currentTurnCites(id,'missing',evidence,async()=>newer)).rejects.toThrow('对话状态已变化');
});
