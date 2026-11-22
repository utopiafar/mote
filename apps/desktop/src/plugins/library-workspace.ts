/** Mac library workspace plugin: owns local and Central content reading, the
 * capture browser and Memory topics. The renderer receives only the declared
 * owner services. Reads stay bounded; explicit cleanup and native file saves
 * require the separate write grant. */
import {createHash} from 'node:crypto';
import {moteText} from '@mote/shared/i18n';
import type {Config} from '../contracts';
import {centralContentPage, centralSourceContentPage, localContentDetail, localContentPage} from '../content-library';
import {browseCaptures, captureDetail, captureImage, type BrowseRequest, type CaptureLocation} from '../capture-browser';
import {centralMemoryTopicDetail, centralMemoryTopicEvidence, centralMemoryTopicPage, centralMemoryTopics, type TopicQuery} from '../memory-topics';
import {readCentralContent,readArchivedFile} from '../sync-content';
import {saveOriginal} from '../save-original';
import {validateServerUrl} from '../config';
import {connectionToken} from '../login-session';
import type {MeetingRecordingManager} from '../meeting-recording';
import type {ContentItem,ContentDetail} from '../contracts/content';
import type {DurableQueue} from '../queue';
import type {LocalSourceManager} from '../source-manager';
import type {SyncHistory} from '../sync-history';
import {libraryWorkspaceChannels} from '../desktop-ipc-channels';
import type {BuiltinDesktopPlugin, BuiltinPluginContext} from './index';

/** Owner services split by evidence domain and local mutation authority. */
export const libraryReadCapability = 'library.read';
export const libraryWriteCapability='library.write';
export const memoryReadCapability = 'memory.read';

export {libraryWorkspaceChannels};

export interface LibraryWorkspaceOptions {
  readonly settings: () => Config;
  readonly queue: DurableQueue;
  readonly meetings?:MeetingRecordingManager;
  readonly generation?:()=>number|string;
  readonly selectOriginalDestination?:(name:string)=>Promise<string|undefined>;
  readonly sources: () => LocalSourceManager;
  readonly syncHistory: Pick<SyncHistory, 'receivedCapture'>;
  readonly changed?:()=>void;
  readonly guard?: () => void;
}

export function createLibraryWorkspacePlugin(options: LibraryWorkspaceOptions): BuiltinDesktopPlugin {
  let scopeSignal:AbortSignal|undefined;
  const active=()=>{options.guard?.();if(scopeSignal?.aborted)throw Error('Library authorization ended');};
  // A read that started against an older connection is never projected as the
  // current node's evidence. Callers re-read after the change.
  const withConnection = async <T>(operation: (config: Config,authorize:()=>void) => Promise<T>): Promise<T> => {
    active();
    const requested=options.settings(),generation=options.generation?.(),token=connectionToken(requested);
    const authorize=()=>{active();if(options.settings()!==requested||options.generation?.()!==generation||connectionToken(options.settings())!==token)throw Error(moteText('连接已改变，刷新采集记录'));};
    authorize();const result=await operation({...requested},authorize);authorize();
    return result;
  };
  function originalOrigin(origin:string|undefined,config:Config){
    if(!origin||!config.serverUrl)throw Error(moteText('本机原件不在此设备，连接原中央后可按当前权限读取。'));
    if(validateServerUrl(config.serverUrl)!==origin)throw Error(moteText('原中央与当前连接不一致，未发送读取请求。'));
  }
  function meetingItems():ContentItem[]{return options.meetings?.contentRecords().map(record=>({key:'meeting:'+record.id,source:'file',title:moteText('本机会议录音'),observedAt:record.startedAt,preview:'',sourceName:moteText('本机会议录音'),error:record.error,localContentRelease:record.localContentRelease,...(record.state==='uploaded'&&record.uploadedAt&&record.uploadOrigin?{archiveAcknowledgment:{at:record.uploadedAt,origin:record.uploadOrigin}}:{})}))??[];}
  function meetingDetail(id:string):ContentDetail{
    const record=options.meetings?.record(id);if(!record)throw Error('Recording unavailable');const proof=options.meetings?.archiveReceipt(id);
    return {text:'',sourceName:moteText('本机会议录音'),metadata:JSON.stringify({id:record.id,startedAt:record.startedAt,endedAt:record.endedAt,captureId:record.captureId,uploadedAt:record.uploadedAt,uploadOrigin:record.uploadOrigin},null,2),localContentRelease:record.localContentRelease,retainsOriginal:!record.localContentRelease&&Boolean(record.audioFile),canRelease:Boolean(proof&&(!record.localContentRelease||record.localContentRelease.pending)),canSaveOriginal:Boolean((record.state!=='uploaded'||proof)&&((record.audioFile&&!record.localContentRelease)||proof&&record.localContentRelease))};
  }
  const sources = () => options.sources();
  const local = <T>(operation: () => T): T => {
    active();
    return operation();
  };
  return {
    id: 'mote.library-workspace',
    async register({host, pageUrl}: BuiltinPluginContext): Promise<void> {
      const scope = host.createScope({
        instanceId: 'mote.library-workspace',
        capabilities: [libraryReadCapability,libraryWriteCapability, memoryReadCapability],
      });
      scopeSignal=scope.signal;
      const outcome = await host.startPlugin(scope, plugin => {
        const roleFrameUrls = {main: [pageUrl]};
        const register = (channel: string, capability: string, handler: (args: readonly unknown[]) => unknown) =>
          plugin.registerIpc({channel, capability, windowRoles: ['main'], callerCapability: capability, roleFrameUrls}, (_view, args) => handler(args));

        register(libraryWorkspaceChannels.contentCentral, libraryReadCapability, args =>
          withConnection(config => centralContentPage(config, args[0] as string | undefined, args[1] as string | undefined)));
        register(libraryWorkspaceChannels.contentCentralDetail, libraryReadCapability, args =>
          withConnection((config,authorize) => {
            const [id, offset, image] = args;
            if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)
              || offset !== undefined && (!Number.isSafeInteger(offset) || Number(offset) < 0)) throw Error('Invalid content reference');
            return readCentralContent(config, {
              key: id, captureId: id, source: 'file', title: '', observedAt: '', outcome: 'received', firstReceipt: false,
            }, Number(offset ?? 0), image === true,authorize);
          }));
        register(libraryWorkspaceChannels.contentLocal, libraryReadCapability, args => local(() =>
          localContentPage(options.queue,sources(),args[0] as number|undefined,args[1] as string|undefined,undefined,args[2] as boolean|undefined,meetingItems())));
        register(libraryWorkspaceChannels.contentLocalDetail, libraryReadCapability, args =>
          withConnection(async(config,authorize) => {
            const key = args[0], image = args[1];
            if(typeof key!=='string'||key.length>160||image!==undefined&&typeof image!=='boolean')throw Error('Invalid content reference');
            if(key.startsWith('meeting:'))return meetingDetail(key.slice(8));
            const record=key.startsWith('queue:')?options.queue.recordForHistory(key.slice(6)):undefined;
            if(record?.localContentRelease){
              if(record.localContentRelease.pending)return localContentDetail(options.queue,sources(),key,image as boolean|undefined);
              originalOrigin(record.archiveAcknowledgment?.origin,config);const marker=record.localContentRelease.at;
              const current=()=>{authorize();if(options.queue.recordForHistory(record.event.id)?.localContentRelease?.at!==marker)throw Error('Local record changed');};
              return {...await readCentralContent(config,{key,captureId:record.event.id,source:record.event.source,title:'',observedAt:record.event.capturedAt,outcome:'received',firstReceipt:false},0,image===true,current),localContentRelease:record.localContentRelease};
            }
            return localContentDetail(options.queue,sources(),key,image as boolean|undefined).then(value=>{authorize();if(record&&options.queue.recordForHistory(record.event.id)?.localContentRelease)throw Error('Local record changed');return value;}).catch(async error => {
              if (record||typeof key !== 'string') throw error;
              const parts = key.split(':');
              const receiptKey = parts[0] === 'queue' ? parts[1]
                : parts[0] === 'source' ? createHash('sha256').update(`${parts[1]}\0${parts[2]}`).digest('hex') : undefined;
              const id = receiptKey ? options.syncHistory.receivedCapture(config, receiptKey) : undefined;
              if (!id) throw error;
              return readCentralContent(config, {
                key: receiptKey!, captureId: id, source: 'file', title: '', observedAt: '', outcome: 'received', firstReceipt: false,
                ...(parts[0] === 'source' ? {sourceId: parts[1]} : {}),
              }, 0, image === true,authorize);
            });
          }));

        register(libraryWorkspaceChannels.contentRelease,libraryWriteCapability,args=>withConnection(async(_config,authorize)=>{
          const key=args[0];if(typeof key!=='string'||key.length>160)throw Error('Invalid content reference');
          try{if(key.startsWith('queue:'))await options.queue.releaseContent(key.slice(6),authorize);
          else if(key.startsWith('meeting:')&&options.meetings)await options.meetings.releaseContent(key.slice(8),authorize);
          else throw Error('This is not a saved local capture');}finally{options.changed?.();}
        }));
        register(libraryWorkspaceChannels.contentSaveOriginal,libraryWriteCapability,args=>withConnection(async(config,authorize)=>{
          const key=args[0];if(typeof key!=='string'||!key.startsWith('meeting:')||key.length>160||!options.meetings)throw Error('Invalid recording identity');
          const id=key.slice(8),record=options.meetings.record(id);if(!record)throw Error('Recording unavailable');
          const proof=options.meetings.archiveReceipt(id);
          if((record.state==='uploaded'||record.localContentRelease)&&!proof)throw Error(moteText('本机副本已变化；尚无可读取的中央接收凭据。'));
          const marker=record.localContentRelease?.at,current=()=>{authorize();if(options.meetings!.record(id)?.localContentRelease?.at!==marker)throw Error('Local recording changed');};
          const destination=await options.selectOriginalDestination?.(id+(record.mimeType==='audio/wav'?'.wav':'.m4a'));current();if(!destination)return;
          const input=record.localContentRelease?await (async()=>{originalOrigin(record.uploadOrigin,config);return readArchivedFile(config,{captureId:record.captureId!,deviceId:record.deviceId!,...proof!},current);})():await options.meetings.readOriginal(id,current);
          await saveOriginal(destination,input,current);
        }));

        register(libraryWorkspaceChannels.capturesBrowse, libraryReadCapability, args =>
          withConnection(config => browseCaptures(options.queue, config, args[0] as BrowseRequest)));
        register(libraryWorkspaceChannels.capturesDetail, libraryReadCapability, args =>
          withConnection((config,authorize) => captureDetail(options.queue, config, args[0] as CaptureLocation, args[1] as string,authorize)));
        register(libraryWorkspaceChannels.capturesImage, libraryReadCapability, args =>
          withConnection((config,authorize) => captureImage(options.queue, config, args[0] as CaptureLocation, args[1] as string, args[2] as boolean,authorize)));

        register(libraryWorkspaceChannels.sourceArchivedContent, libraryReadCapability, args =>
          withConnection(config => {
            const [id, cursor] = args, source = sources().status().find(row => row.source.id === id)?.source;
            if (!source || typeof id !== 'string') throw Error('Invalid source');
            return centralSourceContentPage(config, source, cursor as string | undefined);
          }));
        register(libraryWorkspaceChannels.sourcePendingContent, libraryReadCapability, args =>
          local(() => {
            const id = args[0];
            if (typeof id !== 'string' || !sources().status().some(row => row.source.id === id)) throw Error('Invalid source');
            return localContentPage(options.queue, sources(), 0, undefined, id);
          }));

        register(libraryWorkspaceChannels.memoryTopics, memoryReadCapability, () => withConnection(config => centralMemoryTopics(config)));
        register(libraryWorkspaceChannels.memoryTopicPage, memoryReadCapability, args =>
          withConnection(config => centralMemoryTopicPage(config, args[0] as TopicQuery)));
        register(libraryWorkspaceChannels.memoryTopicDetail, memoryReadCapability, args =>
          withConnection(config => centralMemoryTopicDetail(config, args[0] as string)));
        register(libraryWorkspaceChannels.memoryTopicEvidence, memoryReadCapability, args =>
          withConnection((config,authorize) => centralMemoryTopicEvidence(config,args[0] as string,args[1] as string,authorize)));
      });
      if (!outcome.started) throw outcome.error;
    },
  };
}
