import {afterEach,expect,it,vi} from 'vitest';
import {centralMemoryTopics,centralMemoryTopicPage,centralMemoryTopicDetail,centralMemoryTopicEvidence} from '../src/memory-topics';
import {defaultConfig} from '../src/config';
const config={...defaultConfig(),serverUrl:'http://127.0.0.1:9999',token:'generated-token',authSignedOut:false};
afterEach(()=>vi.unstubAllGlobals());
it('rejects arbitrary paths and malformed identities before any network call',async()=>{
 const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 for(const query of [{path:'/api/config'},{treeId:'x'},{treeId:'x',nodeId:'../secret'},{cursor:'x'.repeat(8193)}])await expect(centralMemoryTopicPage(config,query)).rejects.toThrow();
 await expect(centralMemoryTopicDetail(config,'../configuration')).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
it('uses the fixed bounded route and treats permission errors as failure',async()=>{
 const fetch=vi.fn(async()=>new Response(JSON.stringify({items:[],nextCursor:null})));vi.stubGlobal('fetch',fetch);
 await centralMemoryTopicPage(config,{treeId:'auto.fixture',nodeId:'planning',cursor:'a/b'});
 expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/context-trees/auto.fixture/nodes/planning?limit=30&cursor=a%2Fb');
 fetch.mockImplementation(async()=>new Response('{}',{status:403}));await expect(centralMemoryTopics(config)).rejects.toThrow();
});
it('refuses cyclic or duplicate topic ancestry but preserves untrusted labels as data',async()=>{
 const value={items:[{id:'auto.fixture',label:'<script>fixture</script>',nodes:[{id:'a',label:'A',parentId:'b'},{id:'b',label:'B',parentId:'a'}]}]};
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(value))));await expect(centralMemoryTopics(config)).rejects.toThrow('ancestry');
 delete (value.items[0].nodes[1] as {parentId?:string}).parentId;expect((await centralMemoryTopics(config)).items[0].label).toContain('<script>');
});

it('uses only the Memory-scoped evidence route and rejects absent members, denial and changed sessions',async()=>{
 const id='11111111-1111-4111-8111-111111111111',evidence='22222222-2222-4222-8222-222222222222';
 const fetch=vi.fn(async()=>new Response(JSON.stringify({status:'published',items:[{id:evidence,ocrText:'generated original'}]})));vi.stubGlobal('fetch',fetch);
 const fence=vi.fn();expect((await centralMemoryTopicEvidence(config,id,evidence,fence)).text).toBe('generated original');expect(fence).toHaveBeenCalledOnce();
 expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/memories/'+id+'/evidence');
 fetch.mockImplementation(async()=>new Response(JSON.stringify({status:'published',items:[]})));
 fetch.mockClear();await expect(centralMemoryTopicEvidence(config,id,evidence,fence)).rejects.toThrow('not a member');expect(fetch).toHaveBeenCalledOnce();
 fetch.mockImplementation(async()=>new Response(JSON.stringify({status:'published',items:[{id:evidence,ocrText:'generated original'}]})));
 fetch.mockClear();await expect(centralMemoryTopicEvidence(config,id,evidence,()=>{throw Error('changed session');})).rejects.toThrow('changed session');expect(fetch).toHaveBeenCalledOnce();
 fetch.mockImplementation(async()=>new Response('{}',{status:403}));fetch.mockClear();await expect(centralMemoryTopicEvidence(config,id,evidence,fence)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
});
