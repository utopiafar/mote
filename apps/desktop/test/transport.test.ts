import { afterEach, describe, expect, it, vi } from 'vitest';
import { heartbeat, uploadCapture,uploadCaptureBatch } from '../src/transport';
import { defaultConfig } from '../src/config';
import { captureAck,event, image } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
describe('acknowledgment-gated uploads', () => {
  it('normalizes batch network failures without exposing transport internals', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic-private-server synthetic-secret')));
    await expect(uploadCaptureBatch({ ...defaultConfig(), token: 'synthetic-secret' }, [{ event: event() }])).rejects.toMatchObject({ classification: 'NETWORK', message: '无法连接中央节点，已保留本地队列并等待重试' });
  });
  it.each(['not-json', 'null', '{"results":[null]}'])('preserves queued records and reports invalid batch receipt envelopes (%s)', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    await expect(uploadCaptureBatch({ ...defaultConfig(), token: 'synthetic-token' }, [{ event: event() }])).rejects.toMatchObject({ classification: 'RESPONSE' });
  });
  it.each([401,403,429])('batch HTTP %s never probes a less privileged or different upload endpoint',async status=>{
    const fakeFetch=vi.fn().mockImplementation(async()=>new Response('generated error',{status}));vi.stubGlobal('fetch',fakeFetch);
    await expect(uploadCaptureBatch({...defaultConfig(),token:'synthetic-token'},[{event:event()}])).rejects.toMatchObject({httpStatus:status});
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
  it('splits oversized capture batches and preserves the exact receipt identities',async()=>{
    const entries=Array.from({length:8},(_,i)=>({event:{...event(),id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}})),sizes:number[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,options:RequestInit)=>{
      expect(url.endsWith('/api/captures/batch')).toBe(true);
      const body=JSON.parse(await new Response(options.body).text());sizes.push(body.captures.length);
      return body.captures.length>2?new Response('too large',{status:413}):new Response(JSON.stringify({results:body.captures.map((c:{id:string})=>({...captureAck(c.id),status:201}))}),{status:200});
    }));
    const receipts=await uploadCaptureBatch({...defaultConfig(),token:'synthetic-token'},entries);
    expect(sizes).toEqual([8,4,2,2,4,2,2]);expect([...receipts.keys()]).toEqual(entries.map(e=>e.event.id));
  });
  it('does not recursively retry an individual oversized record',async()=>{
    const fakeFetch=vi.fn(async()=>new Response('too large',{status:413}));vi.stubGlobal('fetch',fakeFetch);
    await expect(uploadCaptureBatch({...defaultConfig(),token:'synthetic-token'},[{event:event()}])).rejects.toMatchObject({httpStatus:413});
    expect(fakeFetch).toHaveBeenCalledOnce();
  });
  it.each([404,405])('does not retry a missing batch route through a different endpoint (%s)',async status=>{
    const urls:string[]=[];vi.stubGlobal('fetch',vi.fn(async(url:string)=>{urls.push(url);return new Response('',{status});}));
    const entries=[{event:event()},{event:{...event(),id:'00000000-0000-4000-8000-000000000002'}}];
    await expect(uploadCaptureBatch({...defaultConfig(),token:'synthetic-token'},entries)).rejects.toMatchObject({httpStatus:status});expect(urls).toHaveLength(1);
  });
  it('requires a matching 200/201 event ID, preserving retry identity', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(captureAck(event().id)), { status: 201 }));
    vi.stubGlobal('fetch', fakeFetch);
    const config = { ...defaultConfig(), token: 'synthetic-token' };
    await uploadCapture(config, event(), image);
    expect(fakeFetch.mock.calls[0][0]).toBe('http://127.0.0.1:47832/api/captures');
    const options = fakeFetch.mock.calls[0][1];
    expect(options.redirect).toBe('error');
    expect(options.credentials).toBe('omit');
    expect(options.headers['X-Mote-Ingress-Version']).toBe('2');
    expect(JSON.parse(await new Response(options.body).text())).toEqual({ ...event(), imageBase64: image.toString('base64') });
  });
  it.each([
    {receipt:undefined},
    {receipt:{version:1}},
    {receipt:{state:'queued'}},
    {receipt:{kind:'source-item'}},
    {receipt:{id:'f50650f0-fb31-4215-90cd-c96dc62d5e93'}},
    {receipt:{duplicate:'false'}},
  ])('does not settle a capture without a complete v2 receipt (%j)',async change=>{
    const base=captureAck(event().id),ack={...base,receipt:change.receipt===undefined?undefined:{...base.receipt,...change.receipt}};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(ack,{status:201})));
    await expect(uploadCapture({...defaultConfig(),token:'synthetic-token'},event(),image)).rejects.toMatchObject({classification:'RESPONSE'});
  });
  it('requires v2 receipts for every accepted capture batch result',async()=>{
    const id=event().id;
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({results:[{id,status:201}]})));
    await expect(uploadCaptureBatch({...defaultConfig(),token:'synthetic-token'},[{event:event()}])).rejects.toMatchObject({classification:'RESPONSE'});
  });
  it.each([200, 201, 202, 401, 409, 500])('keeps queue ownership when HTTP %s does not acknowledge the exact record', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'wrong-id', privateText: 'must-not-leak' }), { status })));
    await expect(uploadCapture({ ...defaultConfig(), token: 'synthetic-token' }, event(), image)).rejects.toThrow('队列已保留');
  });
  it('does not expose network internals or tokens in errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('url has synthetic-secret')));
    await expect(uploadCapture({ ...defaultConfig(), token: 'synthetic-secret' }, event(), image)).rejects.toThrow('无法连接中央节点');
  });
  it('cancels an oversized streamed acknowledgement and preserves the pending record', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel }), { status: 201 })));
    await expect(uploadCapture({ ...defaultConfig(), token: 'synthetic-token' }, event(), image)).rejects.toThrow('队列已保留');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([200, 500])('cancels unused heartbeat response bodies on HTTP %s', async status => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status })));
    await heartbeat({ ...defaultConfig(), token: 'synthetic-token' }, {});
    expect(cancel).toHaveBeenCalledOnce();
  });
});
