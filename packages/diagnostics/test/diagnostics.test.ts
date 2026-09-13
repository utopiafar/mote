import { it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticsRecorder } from '../src/index';

it('records bounded numeric device changes and excludes content, tokens and prompts even on import', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mote-diagnostics-')); const recorder=new DiagnosticsRecorder(dir);
  let battery=80;
  try {
    await recorder.configure({enabled:true,intervalMs:60000,maxSamples:2},async()=>({queueBytes:120,modelBytes:737504352,batteryPercent:battery--,charging:false,onBattery:true,ocrText:'PRIVATE NOTE',token:'SECRET',prompt:'SECRET'} as any));
    recorder.recordCapture({outcome:'saved',imageBytes:100,inferenceMs:40}); recorder.recordUpload(100);
    await recorder.sample(); await recorder.sample();
    expect(recorder.status().sampleCount).toBe(2); expect(recorder.status().latest?.deviceBatteryDeltaPct).toBe(-1);
    expect(recorder.status().counters).toMatchObject({saved:1,imageBytes:100,uploadedBytes:100,inferenceMs:40});
    const path=join(dir,'export.json');await recorder.exportTo(path);const raw=await readFile(path,'utf8');
    expect(raw).not.toContain('PRIVATE'); expect(raw).not.toContain('SECRET'); expect(raw).not.toContain('prompt');
    await recorder.close();
    const tampered=JSON.parse(raw);tampered.samples[0].ocrText='INJECTED';tampered.counters.token='INJECTED';await writeFile(join(dir,'diagnostics.json'),JSON.stringify(tampered));
    const next=new DiagnosticsRecorder(dir);await next.configure({enabled:false,intervalMs:60000},async()=>({queueBytes:0,modelBytes:0}));await next.exportTo(path);
    expect(await readFile(path,'utf8')).not.toContain('INJECTED'); await next.close();
  } finally {await recorder.close();await rm(dir,{recursive:true,force:true});}
});
it('disabled diagnostics do not sample or create a log; unavailable battery remains unavailable', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mote-diagnostics-')); const recorder=new DiagnosticsRecorder(dir); let calls=0;
  try {
    await recorder.configure({enabled:false,intervalMs:60000},async()=>{calls++;return{queueBytes:0,modelBytes:0};});recorder.recordCapture({outcome:'saved'});await recorder.sample();
    expect(calls).toBe(0);expect(recorder.status().counters.saved).toBe(0);await expect(readFile(join(dir,'diagnostics.json'))).rejects.toThrow();
    await recorder.configure({enabled:true,intervalMs:60000},async()=>({queueBytes:0,modelBytes:0}));expect(recorder.status().latest?.batteryPercent).toBeUndefined();
    await expect(recorder.configure({enabled:true,intervalMs:1},async()=>({queueBytes:0,modelBytes:0}))).rejects.toThrow();
  } finally {await recorder.close();await rm(dir,{recursive:true,force:true});}
});
it('stop during an asynchronous sample prevents a late diagnostic write', async () => {
  const dir=await mkdtemp(join(tmpdir(),'mote-diagnostics-'));const recorder=new DiagnosticsRecorder(dir);let release!:()=>void;
  try {
    const configuring=recorder.configure({enabled:true,intervalMs:60000},async()=>{await new Promise<void>(r=>release=r);return{queueBytes:0,modelBytes:0};});
    while(!release)await new Promise(r=>setTimeout(r,1));const closing=recorder.close();release();await configuring;await closing;
    expect(recorder.status().sampleCount).toBe(0);await expect(readFile(join(dir,'diagnostics.json'))).rejects.toThrow();
  } finally {await recorder.close();await rm(dir,{recursive:true,force:true});}
});


it('repeated rename failures clean their owned temporary and recover without growing storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mote-diagnostics-'));
  const recorder = new DiagnosticsRecorder(dir);
  try {
    // A damaged target path permits writing a temporary but prevents replacing the log.
    await mkdir(join(dir, 'diagnostics.json'));
    await recorder.configure({ enabled:true, intervalMs:60000, maxSamples:1 }, async () => ({ queueBytes:0, modelBytes:0 }));
    for (let i=0; i<4; i++) await recorder.sample();
    expect(recorder.status().error).toContain('写入失败');
    expect(recorder.status().sampleCount).toBe(1);
    expect(await readdir(dir)).toEqual(['diagnostics.json']);
    await rm(join(dir, 'diagnostics.json'), { recursive:true });
    await recorder.sample();
    expect(recorder.status().error).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, 'diagnostics.json'), 'utf8')).samples).toHaveLength(1);
    expect(await readdir(dir)).toEqual(['diagnostics.json']);
  } finally { await recorder.close(); await rm(dir, { recursive:true, force:true }); }
});

it('startup removes only precisely named dead-process writes and preserves live owners and unrelated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mote-diagnostics-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore' });
  const recorders: DiagnosticsRecorder[] = [];
  try {
    await once(child, 'spawn');
    const childWrite = `diagnostics.json.${child.pid}.${randomUUID()}.tmp`;
    const ownWrite = `diagnostics.json.${process.pid}.${randomUUID()}.tmp`;
    const unrelated = `notes.json.${child.pid}.${randomUUID()}.tmp`;
    const legacyUnknownOwner = `diagnostics.json.${randomUUID()}.tmp`;
    const namedDirectory = `diagnostics.json.${child.pid}.${randomUUID()}.tmp`;
    const kept = [ownWrite, unrelated, legacyUnknownOwner, namedDirectory];
    for (const file of [childWrite, ownWrite, unrelated, legacyUnknownOwner]) await writeFile(join(dir, file), 'synthetic fixture');
    await mkdir(join(dir, namedDirectory));
    const start = async () => {
      const recorder = new DiagnosticsRecorder(dir); recorders.push(recorder);
      await recorder.configure({ enabled:false, intervalMs:60000 }, async () => { throw new Error('disabled recorder must not sample'); });
    };
    await start();
    expect((await readdir(dir)).sort()).toEqual([childWrite, ...kept].sort());
    const exited = once(child, 'exit'); child.kill(); await exited;
    await start();
    expect((await readdir(dir)).sort()).toEqual(kept.sort());
    await expect(readFile(join(dir, 'diagnostics.json'))).rejects.toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    for (const recorder of recorders) await recorder.close();
    await rm(dir, { recursive:true, force:true });
  }
});
