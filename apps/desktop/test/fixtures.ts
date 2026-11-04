import type { CaptureEvent } from '../src/contracts';

// Generated JPEG envelope fixture; capture tests operate on generated pixel buffers.
// It is intentionally not an actual personal screenshot or a decode/vision test image.
export const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4d, 0x54, 0xff, 0xd9]);
export const captureAck=(id:string,duplicate=false)=>({id,duplicate,receipt:{version:2 as const,id,kind:'capture' as const,state:'received' as const,duplicate}});
export const sourceAck=(sourceId:string,item:{externalId:string;revision:string},kind:'source-item'|'file-revision'='source-item',duplicate=false)=>{
  const id='b67c1b84-f2cd-4e59-bf67-215545a882dc';
  return {id,sourceId,externalId:item.externalId,revision:item.revision,duplicate,receipt:{version:2 as const,id,kind,state:'received' as const,duplicate,sourceId,externalId:item.externalId,revision:item.revision}};
};
/** Serialized GET /api/agent-runtime-settings receipt in the shared EXT06 shape. */
export function runtimeStatusReceipt() {
  const settings={provider:'generated-provider',protocol:'generated-protocol',baseUrl:'https://fixture.invalid/v1',model:'generated-model',reasoningEffort:'auto',maxTokens:4096,modelRequestTimeoutMs:120000,agentTimeoutMs:120000,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false};
  return {
    revision:3,
    saved:{version:1,revision:3,source:'file',settings,
      profiles:[{id:'env:deployment',name:'部署配置',settings,readOnly:true,source:'file'}],
      defaults:{chat:'env:deployment',memory:'env:deployment',insight:'env:deployment',import:'env:deployment',file:'env:deployment'},
      defaultModels:{}},
    features:{chat:{profileId:'env:deployment',provider:'generated-provider',model:'generated-model',configured:true}},
    runtime:{closed:false,configured:true,generation:2,activeRuns:0,retiringGenerations:0,releasedGenerations:0,preparedGenerations:0,closeErrors:0,preparedAgents:1,pendingPreparations:0,pendingCleanupFailures:0,shuttingDown:false},
    configuration:{version:1,revision:3,configFile:'/private/tmp/mote-fixture/mote.yaml',
      domains:[{id:'models',saved:{},effective:{},fields:[],status:'applied'}],lastError:null,
      domain:{id:'models',saved:{},effective:{},fields:[],status:'applied'}},
  };
}
export function event(id = 'f50650f0-fb31-4215-90cd-c96dc62d5e92'): CaptureEvent {
  return {
    id, deviceId: 'fbbc0079-765d-45c6-85cb-7b13e7c7f8b1', deviceName: 'Generated fixture Mac', platform: 'macos',
    capturedAt: '2026-09-13T00:00:00.000Z', durationMs: 15000, appId: 'dev.mote.fixture', appName: 'Generated Fixture',
    imageMime: 'image/jpeg', ocrText: 'GENERATED FIXTURE', source: 'screen',
    privacy: { excluded: false, redacted: true, mode: 'local', reason: 'fixture mask' },
  };
}
