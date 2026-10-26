import type {RecordingStatus,SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';

/** recordingManifest declares <provider>.recordings kinds and <provider>-recordings status keys. */
export function recordingSourceStatus(source:SourceConnection,catalog:Record<string,unknown>|null){
 const match=/^([a-z][a-z0-9-]{0,63})\.recordings$/.exec(source.kind);
 if(!match)return undefined;
 const provider=match[1],candidate=catalog?.[provider+'-recordings'] as RecordingStatus|undefined;
 return {provider,status:candidate?.category==='recordings'&&candidate.provider===provider?candidate:undefined};
}

export function recordingBindingText(status?:RecordingStatus){
 if(!status)return moteText('正在读取…');
 return status.connected?moteText('已保存账号绑定'):moteText('尚未绑定账号');
}

/** Project saved settings and known failures only; reading status never probes provider credentials. */
export function recordingSyncText(status?:RecordingStatus,source?:SourceConnection):string{
 if(source&&!source.enabled)return moteText('来源接入已暂停');
 if(!status)return moteText('录音同步状态暂不可用');
 if(source&&status.sourceId!==source.id)return moteText('此来源未绑定当前录音账号');
 if(!status.connected)return moteText('尚未绑定账号');
 const setting=!status.selection.enabled?moteText('录音同步未启用'):status.selection.autoSync?moteText('自动同步已启用'):moteText('仅手动同步');
 const environment=status.authorization?.environment;
 if(environment&&(!environment.installed||!environment.configured||environment.error))return setting+' · '+moteText('运行环境需要处理');
 if(status.authorization?.task?.state==='failed')return setting+' · '+moteText('授权需要处理');
 if(status.error||status.counts.failed)return setting+' · '+moteText('同步需要处理');
 if(!status.selection.enabled)return setting;
 if(status.steps.some(step=>step.state==='running'))return moteText('同步中');
 if(status.counts.pending)return moteText('有同步步骤待处理');
 return setting;
}
