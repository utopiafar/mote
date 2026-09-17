import { moteText } from '@mote/shared/i18n';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { InferenceChild } from './inference-process';

/** Bounded JSONL IPC; model/image data stays in anonymous pipes and helper memory. */
export function nativeInferenceChild(executable: string): InferenceChild {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
  const events = new EventEmitter();
  let buffered = '', ended = false;
  const exit = (code = 1) => { if (!ended) { ended = true; events.emit('exit', code); } };
  child.on('error', () => exit());
  child.on('exit', code => exit(code ?? 1));
  child.stdin.on('error', () => { child.kill('SIGKILL'); exit(); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > 65536) { child.kill('SIGKILL'); exit(); return; }
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
      try { events.emit('message', JSON.parse(line)); }
      catch { child.kill('SIGKILL'); exit(); return; }
    }
  });
  return {
    on(event, listener) { events.on(event, listener); return this; },
    postMessage: value => {
      if (ended) throw new Error(moteText("本地视觉进程已退出"));
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > 12_500_000) throw new Error(moteText("本地视觉请求过大"));
      child.stdin.write(encoded + '\n');
    },
    kill: () => child.kill('SIGKILL'),
  };
}
