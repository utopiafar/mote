import { expect, it, vi } from 'vitest';
import { openCentralBrowser } from '../src/central-browser';
it('opens the requested central page in Chrome without credentials', async () => {
  const chrome = vi.fn().mockResolvedValue(undefined), fallback = vi.fn();
  await openCentralBrowser('https://central.example', 'notes', 'darwin', chrome, fallback);
  expect(chrome).toHaveBeenCalledWith('https://central.example/#notes');
  expect(fallback).not.toHaveBeenCalled();
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
it('opens historical bare capture IDs directly in the central evidence reader', async () => {
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
it('preserves memory and versioned evidence identities when Chrome needs a fallback', async () => {
  const chrome = vi.fn().mockRejectedValue(Error('missing')), fallback = vi.fn();
  for (const reference of ['memory:11111111-2222-4333-8444-555555555555', 'artifact:generated-record:version%3A2', 'material:generated-record']) {
    await openCentralBrowser('https://central.example', 'ask', 'darwin', chrome, fallback, reference);
    const url = new URL(fallback.mock.calls.at(-1)![0]);
    expect(new URLSearchParams(url.hash.split('?')[1]).get('evidence')).toBe(reference);
    expect(url.hash.split('?')[0]).toBe('#/ask');
  }
});
it('encodes untrusted citation text as one evidence value, never a destination or extra parameter', async () => {
  const chrome = vi.fn(), fallback = vi.fn();
  const reference = 'https://elsewhere.example/#/settings?token=synthetic&evidence=other';
  await openCentralBrowser('https://central.example', 'https://elsewhere.example', 'linux', chrome, fallback, reference);
  const url = new URL(fallback.mock.calls[0][0]);
  expect(url.origin).toBe('https://central.example');
  expect(url.hash.split('?')[0]).toBe('#/ask');
  expect([...new URLSearchParams(url.hash.split('?')[1])]).toEqual([['evidence', reference]]);
  expect(url.search).toBe('');
  expect(chrome).not.toHaveBeenCalled();
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
