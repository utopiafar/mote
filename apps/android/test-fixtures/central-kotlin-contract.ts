import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {defaultConfig as desktopConfig} from '../../desktop/src/config.js';
import {AssistantNoticePresenter,AssistantNotificationReader,type AssistantNoticeCursor} from '../../desktop/src/assistant-notification.js';

// Real Central routes feed the production Kotlin upload use case. Only the
// unavailable Android transport runtime is replaced by JDK HTTP in the JVM test.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const all = process.argv.slice(2);
assert.ok(all.length === 0 || all.length === 1 && all[0] === '--all-unit-tests', 'Expected only --all-unit-tests or no arguments');
const directory = await mkdtemp(join(tmpdir(), 'mote-kotlin-contract-'));
const token = randomBytes(32).toString('hex');
const config: Config = {dataDir: directory, token, tokenPath: 'generated-only', host: '127.0.0.1', port: 0,
  maxStorageBytes: 50_000_000, maxExportBytes: 10_000_000, retentionDays: 0, insightIntervalHours: 0,
  allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
  embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent'};
let central: Awaited<ReturnType<typeof buildApp>> | undefined;
let child: ChildProcess | undefined;
let interrupted = false;
let failure: unknown;
const terminate = () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};
const interrupt = () => { interrupted = true; terminate(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  central = await buildApp(config, {backgroundWorker: false, agent: {configured: false,
    query: async () => { throw Error('No model belongs in the Kotlin upload contract'); }, close: async () => {}}});
  const historyEvidence=randomUUID();
  await central.store.ingest({id:historyEvidence,deviceId:'generated-kotlin-phone',deviceName:'Generated phone',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated saved source body'});
  central.store.heartbeat({deviceId:'generated-contact-contract',deviceName:'Generated contact device',platform:'android',status:'capturing',queueDepth:0,
    sync:{mode:'interval',state:'waiting',intervalMinutes:40,batchSize:20,pendingRecords:0}});
  central.store.db.prepare("UPDATE devices SET json=json_set(json,'$.lastSeenAt',?) WHERE id=?")
    .run(new Date(Date.now()-3*60*60_000).toISOString(),'generated-contact-contract');
  const history=central.conversations.append(undefined,{question:'Generated saved question',evidenceIds:[historyEvidence]},
    {answer:'Generated saved answer',citations:[{id:historyEvidence,appName:'Generated source',capturedAt:'2026-10-01T00:00:00Z',excerpt:'Generated saved excerpt'}],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[historyEvidence]}});
  const origin = await central.app.listen({host: '127.0.0.1', port: 0});
  // Card store -> real HTTP -> both notification consumers. The only mocked boundary
  // is OS presentation; the card, revision, settings and scope are real.
  const notificationEvidence=randomUUID(),notificationId=randomUUID(),plainId=randomUUID();
  await central.store.ingest({id:notificationEvidence,deviceId:'generated-notification-device',deviceName:'Generated notification device',platform:'import',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:'Generated notification evidence'});
  const publish=(id:string,version:string,remind:boolean,revision?:number)=>central!.featureServices.assistantCards.publish({id,version,kind:'suggestion',matterId:null,state:'open',title:'Generated notification '+version,body:'Generated current notification result '+version,
    ...(remind?{reminderReason:'Generated useful reminder'}:{}),evidence:[{id:notificationEvidence,quote:'Generated notification evidence'}],evidenceDependencies:{version:1,complete:true,ids:[notificationEvidence]}},revision,{kind:'all'},()=>{});
  publish(plainId,'plain',false);let notificationCard=publish(notificationId,'v1',true);
  const desktopSettings={...desktopConfig(),serverUrl:origin,token,deviceName:'Generated desktop'};
  const desktopReader=new AssistantNotificationReader(()=>desktopSettings,()=>0);
  let presentationCursor:AssistantNoticeCursor|undefined,shows=0,cancels=0;
  const desktopPresenter=new AssistantNoticePresenter({cursor:()=>presentationCursor,save:value=>{presentationCursor=value;},show:(_event,shown)=>{shows++;shown();return {close:()=>{cancels++;}};}});
  desktopPresenter.update(origin,await desktopReader.snapshot(origin),true);
  desktopPresenter.update(origin,await desktopReader.snapshot(origin),true);assert.equal(shows,1);
  notificationCard=publish(notificationId,'v2',true,notificationCard.revision);
  desktopPresenter.update(origin,await desktopReader.snapshot(origin),true);assert.equal(shows,1);assert.equal(cancels,1,'A new version retires the old OS summary');
  assert.equal((await desktopReader.card(origin,notificationId)).body,'Generated current notification result v2');
  assert.ok((await desktopReader.page(origin)).items.some(card=>card.id===plainId),'No reminder is required to keep a card in the inbox');
  const invitation = await central.app.inject({method: 'POST', url: '/api/connections/collector-invitations',
    headers: {authorization: 'Bearer ' + token}, payload: {serverUrl: origin, label: 'Generated Kotlin contract', deviceId: 'generated-kotlin-phone'}});
  assert.equal(invitation.statusCode, 200, 'Generated collector invitation failed');
  assert.deepEqual(invitation.json().invitation.platforms, ['android', 'macos', 'ios', 'windows', 'linux'], 'Central must declare the client platforms it accepts');
  const granted = await central.app.inject({method: 'POST', url: '/api/connections/redeem', payload: {
    code: invitation.json().invitation.code, deviceId: 'generated-kotlin-phone', deviceName: 'Generated phone', platform: 'android'}});
  assert.equal(granted.statusCode, 200, 'Generated collector redemption failed');
  assert.equal(granted.json().scope, 'collector');
  const iosInvitation = await central.app.inject({method: 'POST', url: '/api/connections/collector-invitations',
    headers: {authorization: 'Bearer ' + token}, payload: {serverUrl: origin, label: 'Generated iOS contract', deviceId: 'generated-iphone'}});
  assert.equal(iosInvitation.statusCode, 200, 'Generated iOS invitation failed');
  const iosGranted = await central.app.inject({method: 'POST', url: '/api/connections/redeem', payload: {
    code: iosInvitation.json().invitation.code, deviceId: 'generated-iphone', deviceName: 'Generated iPhone', platform: 'ios'}});
  assert.equal(iosGranted.statusCode, 200, 'Central must accept an iOS collector platform');
  const iosHeaders = {authorization: 'Bearer ' + iosGranted.json().token, 'x-mote-ingress-version': '2'};
  const iosNotification = {id: randomUUID(), deviceId: 'generated-iphone', deviceName: 'Generated iPhone', platform: 'ios',
    capturedAt: '2026-10-01T00:00:00Z', durationMs: 0, source: 'notification', appId: 'generated.messages',
    appName: 'Generated Messages', privacy: {collection: 'content', mode: 'none'},
    metadata: {version: 1, observedAt: '2026-10-01T00:00:00Z', collector: {method: 'shortcuts'},
      observation: {sessionId: randomUUID(), elapsedRealtimeMs: 0},
      notification: {action: 'posted', notificationKey: 'ef'.repeat(32), postedAt: '2026-10-01T00:00:00Z',
        ongoing: false, groupSummary: false, title: 'Generated delivery', text: 'Generated package arrived'}}};
  const acceptedNotification = await central.app.inject({method: 'POST', url: '/api/captures', headers: iosHeaders, payload: iosNotification});
  assert.equal(acceptedNotification.statusCode, 201, 'Central must accept an iOS Shortcuts notification');
  const replayNotification = await central.app.inject({method: 'POST', url: '/api/captures', headers: iosHeaders,
    payload: {...iosNotification, id: randomUUID(), capturedAt: '2026-10-01T00:01:00Z'}});
  assert.equal(replayNotification.statusCode, 200, 'Repeated iOS notification content must be acknowledged');
  assert.equal(replayNotification.json().duplicate, true);
  if (interrupted) throw Error('Kotlin contract interrupted before Gradle started');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    ...(all.length ? [] : ['--tests', 'dev.mote.collector.CentralProducerContractTest'])];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_KOTLIN_CONTRACT_ORIGIN: origin, MOTE_KOTLIN_CONTRACT_TOKEN: token,
      MOTE_KOTLIN_CONTRACT_COLLECTOR: granted.json().token,MOTE_KOTLIN_CONTRACT_CONVERSATION:history.conversationId,MOTE_KOTLIN_CONTRACT_HISTORY_EVIDENCE:historyEvidence,
      MOTE_KOTLIN_CONTRACT_NOTIFICATION:notificationId,MOTE_KOTLIN_CONTRACT_NOTIFICATION_EVIDENCE:notificationEvidence,MOTE_KOTLIN_CONTRACT_PLAIN_CARD:plainId}});
  await new Promise<void>((done, reject) => {
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      failure = Error('Kotlin contract Gradle process exceeded 15 minutes');
      terminate();
      force = setTimeout(() => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = new AggregateError([failure, error], 'Gradle timeout and termination failed'); }
        }
      }, 5000);
    }, 15 * 60 * 1000);
    child!.once('error', error => { failure = error; });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      if (failure) reject(failure);
      else if (code !== 0 || interrupted) reject(Error(`Kotlin contract Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = await readFile(resolve(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.CentralProducerContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 6, 'The real Kotlin contract cases must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Kotlin contract ${attribute}`);
  assert.deepEqual(await desktopReader.snapshot(origin),{items:[]},'The Android read/withdrawal is reflected on Desktop');
  await assert.rejects(desktopReader.card(origin,notificationId),'A stale notification click cannot disclose the withdrawn result');
  console.log('Real Fastify → Kotlin upload contract passed (generated SQLite/HTTP; no device or model).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  for (const cleanup of [async () => { terminate(); }, async () => { await central?.app.close(); }, async () => { await rm(directory, {recursive: true, force: true}); }]) {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Kotlin contract failed; cleanup also failed') : error; }
  }
}
if (failure) throw failure;
