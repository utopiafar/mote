import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { moteText } from '@mote/shared/i18n';
import type { MeetingAudioBackend, MeetingAudioHandle, MeetingCaptureResult } from './meeting-recording';

interface HelperMessage { status?: string; file?: string; durationMs?: number; microphone?: boolean; systemAudio?: boolean; warnings?: unknown; error?: unknown }

/** The private helper owns CoreAudio/ScreenCaptureKit. Node only supplies the
 * session directory and a stop file; it never receives microphone samples. */
export class NativeMeetingAudioBackend implements MeetingAudioBackend {
  constructor(private readonly helperPath: string) {}

  async start(input: { id: string; directory: string; outputFile: string; stopFile: string; maxDurationMs: number }): Promise<MeetingAudioHandle> {
    const child = spawn(this.helperPath, ['meeting-audio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    const messages: HelperMessage[] = [];
    const waiters: { predicate: (message: HelperMessage) => boolean; resolve: (message: HelperMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
    const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
    let exited = false; let failure: Error | undefined;
    child.once('error', error => { failure = error; lines.close(); });
    child.stderr.resume();
    lines.on('line', line => {
      let message: HelperMessage;
      try { message = JSON.parse(line) as HelperMessage; } catch { return; }
      messages.push(message);
      for (const waiter of [...waiters]) if (waiter.predicate(message)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
      if (message.status === 'failed') {
        const error = new Error(typeof message.error === 'string' && message.error ? message.error : moteText('本机会议录音助手启动失败。'));
        for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
      }
    });
    const waitFor = (predicate: (message: HelperMessage) => boolean, timeoutMs: number, timeoutMessage: string): Promise<HelperMessage> => new Promise((resolve, reject) => {
      const existing = messages.find(predicate); if (existing) { resolve(existing); return; }
      const failed = messages.find(message => message.status === 'failed');
      if (failed) { reject(new Error(typeof failed.error === 'string' && failed.error ? failed.error : timeoutMessage)); return; }
      const waiter = { predicate, resolve, reject, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(timeoutMessage)); }, timeoutMs) };
      waiters.push(waiter);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify({ ...input }) + '\n');
    let ready: HelperMessage;
    try { ready = await waitFor(message => message.status === 'recording', 20000, moteText('本机会议录音助手没有开始录音。')); }
    catch (error) {
      child.kill();
      await closed.catch(() => undefined);
      throw error;
    }
    let stopped = false;
    return {
      stop: async (): Promise<MeetingCaptureResult> => {
        if (stopped) throw new Error(moteText('这场会议录音已经结束。'));
        stopped = true;
        await writeFile(input.stopFile, 'stop\n');
        let code: number | null;
        try { code = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(moteText('本机会议录音助手没有及时结束。'))), 120000))]); }
        catch (error) { child.kill(); await closed.catch(() => undefined); throw error; }
        if (failure) throw failure;
        const final = [...messages].reverse().find(message => message.status === 'recorded' || message.status === 'failed');
        if (final?.status === 'failed') throw new Error(typeof final.error === 'string' && final.error ? final.error : moteText('本机会议录音助手未能完成录音。'));
        if (!final || final.status !== 'recorded' || typeof final.file !== 'string' || !final.file) throw new Error(code === 0 ? moteText('本机会议录音助手没有返回音频。') : moteText('本机会议录音助手异常退出。'));
        return {
          filePath: final.file,
          durationMs: typeof final.durationMs === 'number' && Number.isFinite(final.durationMs) && final.durationMs >= 0 ? final.durationMs : 0,
          microphone: final.microphone !== false || ready.microphone !== false,
          systemAudio: final.systemAudio === true && ready.systemAudio !== false,
          warnings: Array.isArray(final.warnings) ? final.warnings.filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
        };
      },
    };
  }
}

export function meetingRecordingPermissions(): import('./meeting-recording').MeetingRecordingPermissions {
  // Electron is imported lazily so pure manager tests never need a browser process.
  const { systemPreferences } = require('electron') as typeof import('electron');
  const media = (value: string): import('./meeting-recording').MeetingPermissionValue => value === 'granted' ? 'granted' : value === 'denied' ? 'denied' : value === 'not-determined' ? 'not-determined' : 'unsupported';
  return { microphone: media(systemPreferences.getMediaAccessStatus('microphone')), systemAudio: media(systemPreferences.getMediaAccessStatus('screen')) };
}

export async function requestMeetingMicrophone(): Promise<boolean> {
  const { systemPreferences } = require('electron') as typeof import('electron');
  if (process.platform !== 'darwin') return false;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
  return systemPreferences.askForMediaAccess('microphone');
}
