import {captureStatus,type CaptureStatusMacIcon} from '@mote/shared/native-status';
import type {Status} from './contracts';

export type TrayIconStatus={
  running:boolean;
  state:Status['state'];
  screenPermission:string;
  lastCaptureAt?:string;
  sync:Pick<Status['sync'],'state'|'pendingRecords'>;
  config:Pick<Status['config'],'serverUrl'|'tokenConfigured'|'syncPaused'|'authSignedOut'>;
  facts?:Status['facts'];
};

const trayIconNames:Readonly<Record<CaptureStatusMacIcon,string>>={
  normal:'moteNormalTemplate.png',
  paused:'motePausedTemplate.png',
  alert:'moteAlertTemplate.png',
};

export function trayIconName(status:TrayIconStatus):string{
  const state=captureStatus({
    connection:status.config.authSignedOut?'reconnect':status.config.serverUrl&&status.config.tokenConfigured?'connected':'unconfigured',
    captureEnabled:status.running,
    captureLive:status.running&&(status.state==='capturing'||status.state==='paused'),
    screenPausedAt:status.state==='paused'?(status.lastCaptureAt??'paused'):null,
    permission:status.state==='permission_required'||(status.screenPermission!=='granted'&&status.screenPermission!=='unsupported')?'missing':null,
    interrupted:status.state==='error',
    syncState:status.config.syncPaused?'paused':status.facts?.sync.state??(status.sync.state==='manual'?'waiting':status.sync.state),
    pending:status.sync.pendingRecords,
  }).macIcon??'normal';
  return trayIconNames[state];
}
