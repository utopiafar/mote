import {afterEach,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {connect,type Socket} from 'node:net';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DesktopPluginHost} from '../src/plugin-host/desktop-host.js';
import {NativeProviderRegistry} from '../src/plugin-host/native-registry.js';
import type {IpcCallerView,IpcInvokeResult,IpcRouter} from '../src/plugin-host/ipc-registry.js';
import {createChromePlugin,chromeChannels,chromeManageCapability,chromeReadCapability} from '../src/plugins/chrome';
import {CHROME_EXTENSION_ID,CHROME_NATIVE_HOST} from '../src/chrome-constants';
import {chromeNativeHostManifestPath} from '../src/chrome-registration';
import type {BuiltinPluginContext} from '../src/plugins/index';

const makeRouter = () => {
  const handlers = new Map<string, (view: IpcCallerView, args: readonly unknown[]) => unknown>();
  const router: IpcRouter = {
    handle: (channel, listener) => { if (handlers.has(channel)) throw new Error('duplicate'); handlers.set(channel, listener); },
    removeHandler: channel => { handlers.delete(channel); },
  };
  return {
    router,
    invoke: (channel: string, view: IpcCallerView, args: readonly unknown[] = []) =>
      handlers.get(channel)?.(view, args) as Promise<IpcInvokeResult> | undefined,
    has: (channel: string) => handlers.has(channel),
  };
};

const pageUrl = 'file:///generated/index.html';
const view = (senderId: number): IpcCallerView => ({senderId, frameIsMain: true, windowRole: 'main', frameUrl: pageUrl});
const okValue = async (result: ReturnType<ReturnType<typeof makeRouter>['invoke']>) => {
  expect(result).toBeDefined();
  const envelope = await result!;
  expect(envelope.ok).toBe(true);
  return envelope.ok ? envelope.value : undefined;
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const directories: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async()=>{
  for(const child of children.splice(0)) if(child.exitCode===null) child.kill('SIGTERM');
  for(const path of directories.splice(0)) await rm(path,{recursive:true,force:true});
});

it('unregisters the native messaging host and rejects extension messages when the plugin stops', async()=>{
  const directory = await mkdtemp(join(tmpdir(),'mote-plugin-chrome-'));
  directories.push(directory);
  const home = join(directory,'home');
  const origins = ['https://fixture.example'];
  const helper = join(directory,'helper');
  await writeFile(helper,`#!${process.execPath}\nprocess.stdout.write('{}');\n`,{mode:0o700});
  const plugin = createChromePlugin({
    profileDirectory: directory,
    helperPath: helper,
    extensionDirectory: resolve('chrome-extension'),
    electronExecutable: process.execPath,
    nativeHostScript: resolve('src/chrome-native-host.ts'),
    homeDirectory: home,
    platform: 'darwin',
    settings: () => origins,
    openPath: async () => '',
    openExtensions: async () => undefined,
  });
  await plugin.initialize();
  expect(plugin.provider).toBeDefined();

  const fake = makeRouter();
  const host = new DesktopPluginHost({router: fake.router, native: new NativeProviderRegistry('mac')});
  host.registerWindow(7, 'main', [chromeReadCapability, chromeManageCapability]);
  await plugin.register({
    host, pageUrl, ipcMain: {} as never, appVersion: 'generated', mainWindow: {} as never,
    mainSenderId: 7, trustedMain: () => undefined,
  } as BuiltinPluginContext);

  const receipt = await okValue(fake.invoke(chromeChannels.setup, view(7))) as {
    extensionId: string; extensionDirectory: string; manifestPath: string;
  };
  expect(receipt.extensionId).toBe(CHROME_EXTENSION_ID);
  expect(existsSync(receipt.manifestPath)).toBe(true);
  const manifest = JSON.parse(await readFile(receipt.manifestPath, 'utf8'));
  expect(manifest.allowed_origins).toEqual([`chrome-extension://${CHROME_EXTENSION_ID}/`]);

  // A connected extension peer receives the exact permission request.
  const descriptor = JSON.parse(await readFile(join(directory,'chrome-bridge.json'), 'utf8')) as {socket: string; capability: string};
  const peer: Socket = connect(descriptor.socket);
  let received = '';
  const messages: {id: string; type: string; origins: string[]}[] = [];
  peer.on('data', chunk => {
    received += chunk.toString('utf8');
    for (let end = received.indexOf('\n'); end >= 0; end = received.indexOf('\n')) {
      const line = received.slice(0, end);
      received = received.slice(end + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  await new Promise<void>((resolve, reject) => { peer.once('connect', resolve); peer.once('error', reject); });
  peer.write(JSON.stringify({type: 'hello', capability: descriptor.capability}) + '\n');
  for (let index = 0; index < 100 && ![...(plugin.provider as any).peers].some((candidate: any) => candidate.ready); index++) await sleep(10);
  expect([...(plugin.provider as any).peers].some((candidate: any) => candidate.ready)).toBe(true);

  const checking = okValue(fake.invoke(chromeChannels.permissions, view(7), [randomUUID()]));
  for (let index = 0; !messages.length && index < 100; index++) await sleep(10);
  expect(messages).toHaveLength(1);
  expect(messages[0]!.type).toBe('permission-status');
  expect(messages[0]!.origins).toEqual(origins);
  peer.write(JSON.stringify({
    type: 'permission-status', id: messages[0]!.id, status: 'ok',
    origins: origins.map(origin => ({origin, allowed: true})),
  }) + '\n');
  await expect(checking).resolves.toMatchObject({state: 'checked', origins: [{origin: origins[0], allowed: true}]});

  const closed = new Promise<void>((resolve, reject) => {
    if (peer.destroyed) return resolve();
    const timer = setTimeout(() => reject(Error('Extension relay stayed open')), 3000);
    peer.once('close', () => { clearTimeout(timer); resolve(); });
  });
  expect(host.stopScope('mote.chrome')).toEqual([]);
  // Stopping the scope unregisters synchronously; the relay then finishes closing.
  expect(existsSync(receipt.manifestPath)).toBe(false);
  expect(fake.has(chromeChannels.setup)).toBe(false);
  await plugin.close();
  await closed;

  expect(existsSync(join(directory,'chrome-bridge.json'))).toBe(false);
  expect(plugin.provider).toBeUndefined();

  const relay = spawn(process.execPath, [
    '--import', 'tsx', resolve('src/chrome-native-host.ts'), `chrome-extension://${CHROME_EXTENSION_ID}/`,
  ], {env: {...process.env, MOTE_CHROME_BRIDGE_DESCRIPTOR: join(directory,'chrome-bridge.json')}, stdio: ['pipe','pipe','pipe']});
  children.push(relay);
  let output = '';
  relay.stdout.on('data', chunk => { output += chunk; });
  const message = Buffer.from(JSON.stringify({type: 'permission-status', origins}));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(message.length);
  relay.stdin.write(Buffer.concat([header, message]));
  const code = await new Promise<number | null>(resolve => relay.once('close', resolve));
  expect(code).not.toBe(0);
  expect(output).toBe('');
}, 15000);

it('leaves a Chrome registration owned by another profile untouched', async()=>{
  const directory = await mkdtemp(join(tmpdir(),'mote-plugin-chrome-foreign-'));
  directories.push(directory);
  const home = join(directory,'home');
  const manifestPath = chromeNativeHostManifestPath(home);
  await mkdir(dirname(manifestPath),{recursive:true,mode:0o700});
  await writeFile(manifestPath,JSON.stringify({
    name:CHROME_NATIVE_HOST,
    description:'Generated foreign registration',
    path:join(directory,'other-profile','chrome-native-host.sh'),
    type:'stdio',
    allowed_origins:[`chrome-extension://${CHROME_EXTENSION_ID}/`],
  }));
  const plugin = createChromePlugin({
    profileDirectory: join(directory,'this-profile'),
    helperPath: join(directory,'helper'),
    extensionDirectory: resolve('chrome-extension'),
    electronExecutable: process.execPath,
    homeDirectory: home,
    platform: 'darwin',
    settings: () => [],
    openPath: async () => '',
    openExtensions: async () => undefined,
  });
  await plugin.close();
  expect(existsSync(manifestPath)).toBe(true);
});
