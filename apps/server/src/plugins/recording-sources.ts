import type {ConnectorManifest} from '../connectors/registry.js';
import type {MemoryStrategies} from '../memory-strategies.js';
import {recordingManifest,type RecordingProvider} from '../connectors/recordings.js';
import {createFeishuRecordings} from '../connectors/lark-recordings.js';
import {createDingtalkRecordings} from '../connectors/dingtalk-recordings.js';
import {installRecordingMemory} from '../connectors/recording-memory.js';

export {recordingManifest,RecordingConnector} from '../connectors/recordings.js';
export type {RecordingProvider,RecordingAccount,RecordingMetadata} from '../connectors/recordings.js';

/** C15's Feishu and DingTalk recording sources. This module owns
 * connectors/recordings.ts, lark-recordings.ts, dingtalk-recordings.ts,
 * recording-staging.ts, recording-state.ts and recording-memory.ts: the shared
 * synchronization runtime, provider adapters, staged downloads, durable
 * receipts/cursors and the recording Memory recipe live and die with the
 * instance. Each provider runs as one instance under the connector host
 * adapter, which supplies binding grants, owner routes and per-instance
 * stop/restart; the Memory recipe is installed once per host, never per
 * poll or activation. */
export function recordingSourceManifests(testing?:readonly RecordingProvider[]):ConnectorManifest[] {
  return [
    recordingManifest('feishu',ctx=>testing?.find(provider=>provider.id==='feishu')??createFeishuRecordings(ctx.config.connectors!.directory)),
    recordingManifest('dingtalk',ctx=>testing?.find(provider=>provider.id==='dingtalk')??createDingtalkRecordings(ctx.config.connectors!.directory)),
  ];
}
/** The recording recipe belongs to the host, not a provider instance: install
 * once and reuse it across connector disable/re-enable and poll restarts. */
export function installRecordingSources(strategies?:MemoryStrategies){
  return strategies?installRecordingMemory(strategies):undefined;
}
