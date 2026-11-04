import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../../server/src/app.js';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {
  capabilityPublisherCapability,capabilityPublisherChannels,collectorStatusView,
  createCapabilityPublisherPlugin,publishCalendarCapability,sourceCapability,sourceStatusView,
} from '../src/plugins/capability-publisher.js';
import type {BuiltinPluginContext} from '../src/plugins/index';
import type {LocalSource,SourceStatus} from '../src/contracts/sources';
import type {SyncStatus} from '../src/contracts';

const makeRouter = () => {
  const handlers = new Map<string,(view: IpcCallerView,args: readonly unknown[]) => unknown>();
  const router: IpcRouter = {
    handle: (channel,listener) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel,listener); },
    removeHandler: channel => { handlers.delete(channel); },
  };
  return {
    router,
    invoke: (channel: string,view: IpcCallerView,args: readonly unknown[] = []) =>
      handlers.get(channel)?.(view,args) as Promise<IpcInvokeResult> | undefined,
  };
};
const pageUrl = 'file:///generated/index.html';
const view = (senderId: number): IpcCallerView => ({senderId,frameIsMain:true,windowRole:'main',frameUrl:pageUrl});
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};

const directories: string[] = [];
afterEach(async() => { await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true}))); });

async function centralFixture() {
  const directory = await mkdtemp(join(tmpdir(),'mote-capability-publisher-'));
  directories.push(directory);
  const owner = 'generated-capability-owner';
  const node = await buildApp({
    dataDir: join(directory,'data'), token: owner, tokenPath: 'generated', host: '127.0.0.1', port: 0,
    maxStorageBytes: 20_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0,
    allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
    embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw Error('No model in generated capability fixture'); }, close: async () => {}},
  });
  const ownerHeaders = {authorization:'Bearer ' + owner};
  const invitation = await node.app.inject({method:'POST',url:'/api/connections/collector-invitations',headers:ownerHeaders,
    payload:{serverUrl:'https://generated.invalid',label:'Generated Mac',deviceId:'generated-mac'}});
  expect(invitation.statusCode).toBe(200);
  const paired = await node.app.inject({method:'POST',url:'/api/connections/redeem',
    payload:{code:invitation.json().invitation.code,deviceId:'generated-mac',deviceName:'Generated Mac',platform:'macos'}});
  expect(paired.statusCode).toBe(200);
  const origin = await node.app.listen({host:'127.0.0.1',port:0});
  const send = async (path: string,body?: unknown,token = paired.json().token as string) => {
    const response = await fetch(origin + path,{method:body ? 'POST' : 'GET',
      headers:{authorization:'Bearer ' + token,'content-type':'application/json'},body:body ? JSON.stringify(body) : undefined});
    expect(response.status).toBe(200,path);
    return response.json();
  };
  return {node,owner,origin,request:(path: string,body?: unknown) => send(path,body)};
}

it('publishes real calendar declarations that Central accepts and turns permission loss into blocked facts', async() => {
  const central = await centralFixture();
  try {
    const granted = await publishCalendarCapability('generated-mac',{
      permission:'granted',
      calendars:[{id:'generated-calendar',title:'Generated calendar',writable:true},{id:'read-only',title:'Read only',writable:false}],
    },central.request);
    expect(granted).toMatchObject({state:'available'});
    expect(granted!.declaration).toMatchObject({permission:'granted',calendars:[{id:'generated-calendar'}]});
    expect(granted!.projection).toMatchObject({grant:'granted',available:true,authorized:false});

    const revoked = await publishCalendarCapability('generated-mac',{permission:'required',calendars:[]},central.request);
    expect(revoked).toMatchObject({state:'blocked'});
    expect(revoked!.declaration).toMatchObject({permission:'required',calendars:[]});
    expect(revoked!.projection).toMatchObject({grant:'required',available:false,authorized:false});

    const inventory = await fetch(central.origin + '/api/action-capabilities',{headers:{authorization:'Bearer ' + central.owner}}).then(response => response.json()) as {
      deviceCapabilities: {id:string;version:number;grant:string;available:boolean;authorized:boolean}[];
    };
    expect(inventory.deviceCapabilities.find(value => value.id === 'calendar.manage' && value.version === 1))
      .toMatchObject({grant:'required',available:false,authorized:false});
  } finally { await central.node.app.close(); }
});

it('permission loss blocks the source projection without claiming archive or processing work', () => {
  const source = {
    id:'local-generated',name:'Generated calendar',kind:'local-calendar',deviceId:'generated-mac',
    platform:'macos',retention:'snapshot',enabled:true,intervalSeconds:300,trackDeletions:false,
    extensions:['.md'],excludedPaths:[],redactLiterals:[],
  } satisfies LocalSource;
  const row: SourceStatus = {
    source,state:'permission_required',message:'Generated permission loss',pending:2,items:4,skipped:1,
    blocked:0,scanComplete:true,
  };
  expect(sourceCapability(source)).toMatchObject({lifecycle:'continuous',listening:'polling',readOriginal:'none'});
  const blocked = sourceStatusView(row,true);
  expect(blocked.sync).toMatchObject({state:'blocked',errorCode:'permission_required'});
  expect(blocked.archive.state).toBe('local');
  expect(blocked.processing).toMatchObject({state:'unknown'});
  expect(blocked.coverage).toMatchObject({state:'scanned',knownItems:4,skipped:1});

  const missing = sourceStatusView({...row,source:{...source,kind:'generated.missing'}},true);
  expect(missing.sync).toMatchObject({state:'blocked',errorCode:'source_unavailable'});

  const sync: SyncStatus = {state:'uploading',mode:'realtime',message:'Generated',pendingRecords:3};
  expect(collectorStatusView(sync).sync.state).toBe('uploading');
  expect(collectorStatusView(sync,0,false).sync).toMatchObject({state:'blocked',errorCode:'local_state_unavailable'});
});

it('owns calendar publication and its connection IPC inside the plugin scope', async() => {
  const calls: string[] = [];
  const settings = {deviceId:'generated-mac',serverUrl:'https://generated.invalid',token:'generated-token',syncPaused:false,syncMode:'realtime' as const};
  const plugin = createCapabilityPublisherPlugin({
    settings: () => settings,
    calendar: () => ({
      connectAndDeliver: async syncPaused => { calls.push('connect:' + syncPaused()); return {deviceId:'generated-mac'}; },
      deliver: async () => { calls.push('deliver'); },
    }),
    intervalMs: 60_000,
    platform: 'darwin',
  });
  const fake = makeRouter();
  const host = new DesktopPluginHost({router:fake.router,native:new NativeProviderRegistry('mac')});
  host.registerWindow(7,'main',[capabilityPublisherCapability]);
  await plugin.register({
    host,pageUrl,ipcMain:{} as never,appVersion:'generated',mainWindow:{} as never,
    mainSenderId:7,trustedMain:() => undefined,
  } as BuiltinPluginContext);

  await expect(okValue(fake.invoke(capabilityPublisherChannels.calendarConnect,view(7)))).resolves.toEqual({deviceId:'generated-mac'});
  expect(calls).toEqual(['connect:false']);

  await plugin.deliver();
  expect(calls.filter(call => call === 'deliver')).toHaveLength(1);
  settings.syncPaused = true;
  await plugin.deliver();
  expect(calls.filter(call => call === 'deliver')).toHaveLength(1);
  settings.syncPaused = false;

  expect(host.stopScope('mote.capability-publisher')).toEqual([]);
  expect(fake.invoke(capabilityPublisherChannels.calendarConnect,view(7))).toBeUndefined();
  await expect(plugin.deliver()).rejects.toThrow('Capability publisher is stopped');
});

it('does not claim an unbound owner session as a device declaration', async() => {
  const paths: string[] = [];
  const published = await publishCalendarCapability('generated-mac',{permission:'granted',calendars:[]},async path => {
    paths.push(path);
    return {credential:{id:'owner',scope:'owner'}};
  });
  expect(published).toBeUndefined();
  expect(paths).toEqual(['/api/connections/self']);
});

it('rejects a capability declaration for another device before writing', async() => {
  let writes = 0;
  await expect(publishCalendarCapability('generated-mac',{permission:'granted',calendars:[]},async path => {
    if (path === '/api/connections/self') return {credential:{deviceId:'another-device'}};
    writes++;
    return {};
  })).rejects.toThrow('Calendar capability belongs to another device');
  expect(writes).toBe(0);
});
