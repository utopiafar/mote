import { expect, it, vi } from 'vitest';
import { openCentralBrowser } from '../src/central-browser';
it('opens the requested central page in Chrome without credentials', async () => {
  const chrome = vi.fn().mockResolvedValue(undefined), fallback = vi.fn();
  await openCentralBrowser('https://central.example', 'notes', 'darwin', chrome, fallback);
  expect(chrome).toHaveBeenCalledWith('https://central.example/#notes');
  expect(fallback).not.toHaveBeenCalled();
});

it('hands off an exact work identity as activity query data through both login exchanges',async()=>{
  const workId='memory-source:generated/identity?query=untrusted&fragment=#one';
  for(const handoff of ['ticket','request']){
    const chrome=vi.fn(),fallback=vi.fn();
    await openCentralBrowser('https://central.example','activity','darwin',chrome,fallback,undefined,handoff==='ticket'?'generated-ticket':undefined,handoff==='request'?'generated-request':undefined,workId);
    const url=new URL(chrome.mock.calls[0][0]),params=new URLSearchParams(url.hash.split('?')[1]);
    expect(url.origin).toBe('https://central.example');expect(url.pathname).toBe('/');expect(url.search).toBe('');expect(url.hash.split('?')[0]).toBe('#/activity');expect(params.get('work')).toBe(workId);expect(params.get(handoff==='ticket'?'loginTicket':'loginRequest')).toBe('generated-'+handoff);expect(params.has('token')).toBe(false);expect(params.has('evidence')).toBe(false);
  }
});
it('rejects malformed work identities and mixed destinations before any browser opens',async()=>{
  const chrome=vi.fn(),fallback=vi.fn();
  for(const workId of ['', ' ', 'x'.repeat(513), 'bad\nidentity',42,{}])await expect(openCentralBrowser('https://central.example','activity','darwin',chrome,fallback,undefined,undefined,undefined,workId as string)).rejects.toThrow('Invalid work reference');
  await expect(openCentralBrowser('https://central.example','ask','darwin',chrome,fallback,undefined,undefined,undefined,'generated')).rejects.toThrow('Invalid work destination');
  await expect(openCentralBrowser('https://central.example','activity','darwin',chrome,fallback,'11111111-2222-4333-8444-555555555555',undefined,undefined,'generated')).rejects.toThrow('Invalid work destination');
  expect(chrome).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();
});
it('keeps the central Feishu source destination through an owner login handoff',async()=>{
 const chrome=vi.fn(),fallback=vi.fn();
 await openCentralBrowser('https://central.example','lark','darwin',chrome,fallback,undefined,undefined,'generated-request');
 const url=new URL(chrome.mock.calls[0][0]);
 expect(url.hash.split('?')[0]).toBe('#/connections/lark');
 expect(new URLSearchParams(url.hash.split('?')[1]).get('loginRequest')).toBe('generated-request');
 expect(url.search).toBe('');expect(fallback).not.toHaveBeenCalled();
});
it('falls back when Chrome is unavailable and rejects unsafe URLs', async () => {
  const chrome = vi.fn().mockRejectedValue(new Error('missing')), fallback = vi.fn();
  await openCentralBrowser('https://central.example', 'unknown', 'darwin', chrome, fallback);
  expect(fallback).toHaveBeenCalledWith('https://central.example/');
  for (const url of ['javascript:alert(1)', 'https://central.example/?token=secret', 'https://secret@central.example']) {
    await expect(openCentralBrowser(url, undefined, 'darwin', chrome, fallback)).rejects.toThrow();
  }
  expect(chrome).toHaveBeenCalledTimes(1);
});
it('opens explicitly typed local capture IDs directly in the central evidence reader', async () => {
  const chrome = vi.fn(), fallback = vi.fn();
  const id = '11111111-2222-4333-8444-555555555555';
  await openCentralBrowser('https://central.example', 'ask', 'darwin', chrome, fallback, id);
  const url = new URL(chrome.mock.calls[0][0]);
  expect(url.origin).toBe('https://central.example');
  expect(url.pathname).toBe('/');
  expect(url.hash.split('?')[0]).toBe('#/ask');
  expect(new URLSearchParams(url.hash.split('?')[1]).get('evidence')).toBe('capture:' + id);
  expect(url.search).toBe('');
  expect(fallback).not.toHaveBeenCalled();
});
it('retains exact pinned Material or capture identity and its conversation through both login handoffs',async()=>{
 const conversationId='11111111-2222-4333-8444-555555555555',material='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64);
 for(const reference of [material,'capture:'+conversationId])for(const login of ['ticket','request']){
  const chrome=vi.fn();await openCentralBrowser('https://central.example','ask','darwin',chrome,vi.fn(),reference,login==='ticket'?'generated-ticket':undefined,login==='request'?'generated-request':undefined,undefined,conversationId);
  const url=new URL(chrome.mock.calls[0][0]),params=new URLSearchParams(url.hash.split('?')[1]);expect(url.origin).toBe('https://central.example');expect(url.hash.split('?')[0]).toBe('#/ask');expect(params.get('evidence')).toBe(reference);expect(params.get('conversation')).toBe(conversationId);expect(params.get(login==='ticket'?'loginTicket':'loginRequest')).toBe('generated-'+login);expect(url.search).toBe('');expect(params.has('token')).toBe(false);
 }
});
it('rejects malformed Material revisions and conversation destinations before browser launch',async()=>{
 const chrome=vi.fn(),fallback=vi.fn(),material='material:mat_'+'a'.repeat(64)+'@'+'b'.repeat(64);
 for(const reference of [material.replace(/b$/,'g'),material+'?next=https://elsewhere.example',material.replace('@','@%00')])await expect(openCentralBrowser('https://central.example','ask','darwin',chrome,fallback,reference)).rejects.toThrow('Invalid evidence reference');
 for(const conversation of ['','not-an-id','11111111-2222-4333-8444-555555555555&token=bad'])await expect(openCentralBrowser('https://central.example','ask','darwin',chrome,fallback,material,undefined,undefined,undefined,conversation)).rejects.toThrow('Invalid conversation destination');
 await expect(openCentralBrowser('https://central.example','vault','darwin',chrome,fallback,undefined,undefined,undefined,undefined,'11111111-2222-4333-8444-555555555555')).rejects.toThrow('Invalid conversation destination');expect(chrome).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();
});
it('rejects other namespaces and arbitrary citation text before opening the browser',async()=>{
 const chrome=vi.fn(),fallback=vi.fn();for(const reference of ['memory:11111111-2222-4333-8444-555555555555','artifact:generated-record:version%3A2','material:generated-record','https://elsewhere.example/#/settings?token=synthetic'])await expect(openCentralBrowser('https://central.example','ask','darwin',chrome,fallback,reference)).rejects.toThrow('Invalid evidence reference');
 expect(chrome).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();
});
it('rejects invalid evidence input instead of silently opening the home page', async () => {
  const chrome = vi.fn(), fallback = vi.fn();
  for (const reference of ['', ' ', 'x'.repeat(4097), 'capture:bad\nref', 42, {}]) {
    await expect(openCentralBrowser('https://central.example', 'ask', 'darwin', chrome, fallback, reference as string)).rejects.toThrow('Invalid evidence reference');
  }
  expect(chrome).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
});
it('hands off an expiring login code while preserving the requested evidence and keeping the bearer out of URLs',async()=>{
 const chrome=vi.fn(),fallback=vi.fn();const ticket='x'.repeat(43);
 await openCentralBrowser('https://central.example','ask','darwin',chrome,fallback,'capture:11111111-2222-4333-8444-555555555555',ticket);
 const url=new URL(chrome.mock.calls[0][0]),params=new URLSearchParams(url.hash.split('?')[1]);
 expect(params.get('loginTicket')).toBe(ticket);expect(params.get('evidence')).toBe('capture:11111111-2222-4333-8444-555555555555');expect(url.search).toBe('');expect(params.has('token')).toBe(false);
});
it.each(['overview', 'about', 'guide', 'activity', 'plugins'])('preserves the %s destination through both login handoffs', async page => {
  for (const handoff of ['ticket', 'request']) {
    const chrome = vi.fn(), fallback = vi.fn();
    await openCentralBrowser('https://central.example', page, 'darwin', chrome, fallback, undefined, handoff === 'ticket' ? 'generated-ticket' : undefined, handoff === 'request' ? 'generated-request' : undefined);
    const url = new URL(chrome.mock.calls[0][0]);
    expect(url.hash.split('?')[0]).toBe(page === 'plugins' ? '#/system/plugins' : '#/' + page);
    expect(new URLSearchParams(url.hash.split('?')[1]).get(handoff === 'ticket' ? 'loginTicket' : 'loginRequest')).toBe('generated-' + handoff);
    expect(url.search).toBe('');
    expect(fallback).not.toHaveBeenCalled();
  }
});

it.each([['sources','#/connections'],['actions','#/actions'],['models','#/system/models']])('keeps the existing %s destination through a real login handoff',async(page,route)=>{const chrome=vi.fn();await openCentralBrowser('http://127.0.0.1:47832',page,'darwin',chrome,vi.fn(),undefined,'generated-ticket');const url=new URL(chrome.mock.calls[0][0]);expect(url.hash.split('?')[0]).toBe(route);expect(new URLSearchParams(url.hash.split('?')[1]).get('loginTicket')).toBe('generated-ticket');expect(url.search).toBe('');});

it('opens the retained source-detail Central library action through either login handoff',async()=>{
 for(const login of ['ticket','request']){const chrome=vi.fn();await openCentralBrowser('https://central.example','library','darwin',chrome,vi.fn(),undefined,login==='ticket'?'generated-ticket':undefined,login==='request'?'generated-request':undefined);const url=new URL(chrome.mock.calls[0][0]);expect(url.hash.split('?')[0]).toBe('#/library');expect(new URLSearchParams(url.hash.split('?')[1]).get(login==='ticket'?'loginTicket':'loginRequest')).toBe('generated-'+login);expect(url.search).toBe('');}
});
