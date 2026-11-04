import {moteText} from '../i18n.js';
import type {ConnectorManifest} from '../connectors/registry.js';
import {GmailConnector} from '../connectors/gmail.js';
import {gmailContext} from '../connectors/gmail-context.js';
import type {GoogleDependencies} from '../connectors/google.js';

export type {GoogleDependencies};

/** C13B's Gmail connector. This module owns connectors/gmail.ts, gmail-context.ts
 * and gmail-state.ts: the producer, its private credentials file, full-sync
 * membership and page checkpoints live and die with the instance. It runs as one
 * instance under the connector host adapter, which supplies the install scope,
 * owner routes, OAuth callbacks, host-bound state and per-instance stop/restart. */
export function gmailManifest(dependencies?:GoogleDependencies):ConnectorManifest {
  return {apiVersion:1,id:'gmail',sourceKinds:['gmail'],statusKey:'gmail',create:ctx=>{
    const gmail=new GmailConnector(gmailContext(ctx),dependencies);
    return {
      init:()=>gmail.init(),status:()=>gmail.status(),configureSyncInterval:interval=>gmail.configureSyncInterval(interval),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/gmail/start',bodyLimit:16384,handler:()=>gmail.start()});
        host.ownerRoute({method:'POST',path:'/api/connectors/gmail/sync',bodyLimit:16384,handler:()=>gmail.sync()});
        host.ownerRoute({method:'DELETE',path:'/api/connectors/gmail',bodyLimit:16384,handler:()=>gmail.disconnect()});
        host.oauthCallback({path:'/oauth/google/callback',statePrefix:'gmail.',complete:(state,code)=>gmail.callback(state,code),successMessage:moteText('Gmail 已连接。请返回 Mote 同步邮件。'),failureMessage:moteText('授权未完成或已过期。请返回 Mote 重新连接 Google 日历。')});
      },
      close:()=>gmail.close(),
    };
  }};
}
