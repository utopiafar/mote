import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serializeConfigDocument} from '@mote/shared/config-file';
import {buildApp} from '../../server/src/app.js';
import {configFromFile} from '../../server/src/config.js';

const root=fileURLToPath(new URL('../../../',import.meta.url)),directory=await mkdtemp(join(tmpdir(),'mote-native-file-transfer-')),token=randomBytes(32).toString('hex'),path=join(directory,'mote.yaml');
let node:Awaited<ReturnType<typeof buildApp>>|undefined,child:ReturnType<typeof spawn>|undefined;
const stop=()=>{if(child?.pid&&child.exitCode===null&&child.signalCode===null)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGTERM');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
const interrupt=()=>stop();process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
 await writeFile(path,serializeConfigDocument({version:1,revision:0,server:{profile:'test',token},storage:{dataDir:join(directory,'data')},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
 node=await buildApp(configFromFile(path),{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in native file transfer fixture');},async close(){}}});
 let partZero=0;node.app.addHook('onRequest',async request=>{if(request.method==='PUT'&&request.url.endsWith('/parts/0'))partZero++;});const origin=await node.app.listen({host:'127.0.0.1',port:0}),output=join(directory,'native-output.json');
 child=spawn(join(root,'apps/android/gradlew'),['-p','apps/android','--no-daemon',':app:testDebugUnitTest','--rerun','--tests','dev.mote.collector.FileTransferCentralContractTest','--tests','dev.mote.collector.FileTransferTest','--tests','dev.mote.collector.LocalSourcesTest','--tests','dev.mote.collector.FileArchiveQueueTest','--tests','dev.mote.collector.RecordAttachmentIdentityTest','--tests','dev.mote.collector.meeting.MeetingRecordingTest'],{cwd:root,stdio:'inherit',detached:process.platform!=='win32',env:{...process.env,MOTE_FILE_TRANSFER_ORIGIN:origin,MOTE_FILE_TRANSFER_TOKEN:token,MOTE_FILE_TRANSFER_OUTPUT:output}});
 await new Promise<void>((done,failed)=>{let timeout:NodeJS.Timeout|undefined;const timer=setTimeout(()=>{stop();timeout=setTimeout(()=>{if(child?.pid)try{process.kill(process.platform==='win32'?child.pid:-child.pid,'SIGKILL');}catch{}},5000);},15*60_000);child!.once('error',failed);child!.once('close',code=>{clearTimeout(timer);clearTimeout(timeout);if(code===0)done();else failed(Error('Native transfer Gradle failed: '+code));});});
 const report=await readFile(join(root,'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.FileTransferCentralContractTest.xml'),'utf8');assert.match(report,/<testcase name="realCentralPartReceiptsResumeTheProductionNativeUploaderWithoutResendingAcknowledgedBytes"/);for(const attribute of ['skipped','failures','errors'])assert.match(report,new RegExp('\\b'+attribute+'="0"'));
 const result=JSON.parse(await readFile(output,'utf8')),response=await fetch(origin+'/api/files/'+result.id+'/content',{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);const hash=createHash('sha256');let size=0;for await(const part of response.body!){size+=part.length;hash.update(part);}assert.equal(size,result.size);assert.equal(hash.digest('hex'),result.sha256);assert.equal(partZero,1);
 console.log('Real Central -> production Kotlin receipt/resume -> original stream passed (4 MiB + 17 bytes); generated input, no device/model.');
}finally{stop();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);await node?.app.close();await rm(directory,{recursive:true,force:true});}
