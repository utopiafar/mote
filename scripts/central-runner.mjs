// Private bounded stdout/stderr supervisor. The CLI records this process's unique marker.
import { spawn } from 'node:child_process';
import {dirname} from 'node:path';
import {readConfigDocument} from '../packages/shared/src/config-file.ts';
import {logRetentionFromDocument} from '../apps/server/src/log-retention-config.mjs';
import {errorDiagnostics} from '../packages/shared/src/failure-diagnostics.ts';
import {DiagnosticLogStore} from '../apps/server/src/diagnostic-log-store.mjs';

const [entry,logPath,marker]=process.argv.slice(2);
if(!entry||!logPath||!/^--mote-instance=[a-f0-9-]{36}$/.test(marker??''))throw Error('Invalid central supervisor invocation');
const loaded=process.env.MOTE_CONFIG_FILE?readConfigDocument(process.env.MOTE_CONFIG_FILE):undefined;
const store=new DiagnosticLogStore(dirname(logPath),{...logRetentionFromDocument(loaded?.document??{}),family:'supervisor'});
await store.init();
let buffered=[],logFailed=false,pending,writingCount=0,dropped=0;
const instanceId=marker.slice('--mote-instance='.length);let seq=0;
function flush(){
 if(pending||!buffered.length||logFailed)return;
 pending=(async()=>{while(buffered.length){const lines=buffered.splice(0,64);writingCount=lines.length;await store.append(lines);writingCount=0;}})().catch(()=>{logFailed=true;buffered=[];child?.kill('SIGTERM');process.exitCode=1;}).finally(()=>{pending=undefined;if(buffered.length&&!logFailed)flush();});
}
function safeWrite(line){
 if(logFailed)return;
 const value=JSON.parse(line),at=new Date().toISOString(),channel=value.event.endsWith('failed')||value.event==='process.exited'?'error':value.event==='process.output_suppressed'?'debug':'info';
 if(channel==='debug'&&!loaded?.document.diagnostics?.debug)return;
 if(buffered.length>=1024){const index=buffered.findIndex(item=>item.channel==='debug');if(channel==='debug'||index<0){dropped++;return;}buffered.splice(index,1);dropped++;}
 buffered.push({channel,at,line:JSON.stringify({...value,seq:++seq,at,instanceId,level:channel,stage:'system'})+'\n'});flush();
}
const child = spawn(process.execPath, [entry, marker], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const events = new Set(['server.listening', 'server.stopped', 'server.stop_failed', 'server.start_failed']);
const categories = new Set(['data_directory_in_use', 'port_in_use', 'permission', 'startup', 'shutdown', 'configuration']);
const fields = new Set(['MOTE_CONFIG_FILE', 'version', 'revision', 'server', 'storage', 'execution', 'diagnostics', 'models', 'connectors', 'plugins', 'updates', 'media']);
function safeLine(line, stream, byteCount = Buffer.byteLength(line)) {
  let event = { event: 'process.output_suppressed', stream, bytes: byteCount };
  try {
    const candidate = JSON.parse(line);
    if (events.has(candidate.event)) {
      event = { event: candidate.event };
      if (Number.isInteger(candidate.port) && candidate.port > 0 && candidate.port <= 65535) event.port = candidate.port;
      if (candidate.tokenConfigured === true) event.tokenConfigured = true;
      if (categories.has(candidate.category)) event.category = candidate.category;
      if (candidate.category === 'configuration' && typeof candidate.field === 'string' && fields.has(candidate.field.split('.')[0])) event.field = candidate.field;
    }
  } catch { /* Arbitrary SDK/runtime output is never a diagnostic payload. */ }
  // Only allowlisted/suppressed JSON enters this bounded buffer; raw output never does.
  safeWrite(JSON.stringify(event) + '\n');
}
for (const stream of ['stdout', 'stderr']) {
  let pending = '', discarded = 0;
  child[stream].on('data', chunk => {
    const parts = chunk.toString('utf8').split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (discarded) discarded += Buffer.byteLength(parts[i]);
      else pending += parts[i];
      if (Buffer.byteLength(pending) > 8192) { discarded = Buffer.byteLength(pending); pending = ''; }
      if (i < parts.length - 1) {
        if (discarded) safeLine('', stream, discarded); else if (pending) safeLine(pending, stream);
        pending = ''; discarded = 0;
      }
    }
    // Amortize filesystem calls within this data event without delaying diagnostics until a timer.
    flush();
  });
  child[stream].on('end', () => { if (discarded) safeLine('', stream, discarded); else if (pending) safeLine(pending, stream); flush(); });
}
child.on('error', error => { safeWrite(JSON.stringify({event:'process.spawn_failed',diagnostic:errorDiagnostics(error)})); flush(); process.exitCode = 1; });
child.on('close', async (code,signal)=>{if(code||signal)safeWrite(JSON.stringify({event:'process.exited',exitCode:code,signal,diagnostic:{source:'process',stage:'cleanup',...(code!==null?{exitCode:code}:{}),...(signal?{signal}:{})}}));flush();while(pending)await pending;if(dropped){safeWrite(JSON.stringify({event:'process.output_dropped',count:dropped}));while(pending)await pending;}process.exitCode=process.exitCode||code||(signal?1:0);});
process.on('SIGTERM', () => {child.kill('SIGTERM');});
process.on('SIGINT', () => {child.kill('SIGINT');});
