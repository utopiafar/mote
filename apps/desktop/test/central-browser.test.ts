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
