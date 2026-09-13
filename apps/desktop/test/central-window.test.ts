import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: vi.fn(), session: {} }));
import { centralApiRequest, centralPartition, centralRequestAllowed } from '../src/central-window';
describe('central app boundaries', () => {
  it('only authenticates exact-origin API paths', () => {
    expect(centralApiRequest('https://central.example/api/notes', 'https://central.example')).toBe(true);
    for (const url of ['https://evil.example/api/notes', 'https://central.example.evil/api/notes', 'http://central.example/api/notes', 'https://central.example/other', 'file:///api/notes']) expect(centralApiRequest(url, 'https://central.example')).toBe(false);
    expect(centralRequestAllowed('https://elsewhere.example', 'https://central.example')).toBe(false);
  });
  it('uses stable persistent per-origin storage for drafts across reopen, isolated between central nodes', () => {
    expect(centralPartition('https://central.example')).toBe(centralPartition('https://central.example/'));
    expect(centralPartition('https://central.example')).toMatch(/^persist:mote-central-/);
    expect(centralPartition('https://central.example')).not.toBe(centralPartition('https://other.example'));
  });
});
