import {z} from 'zod';
import type {ConnectorManifest,OwnerRoute} from '../connectors/registry.js';
import {LarkConnector} from '../connectors/lark.js';
import type {LarkRunner} from '../connectors/lark-cli.js';
import {larkContext} from '../connectors/lark-context.js';

export type {LarkRunner};

/** C14's Lark connector. This module owns connectors/lark.ts, lark-cli.ts,
 * lark-context.ts, lark-documents.ts and lark-state.ts: the producer, its
 * private lark-cli profile, document/calendar selection and per-scope sync
 * ledgers live and die with the instance. It runs as one instance under the
 * connector host adapter, which supplies the install scope, owner routes,
 * host-bound state and per-instance stop/restart. */
export function larkManifest(runner?:LarkRunner):ConnectorManifest {
  return {apiVersion:1,id:'lark',sourceKinds:['lark-docs','lark-calendar'],create:ctx=>{
    const lark=new LarkConnector(larkContext(ctx),runner);
    return {
      init:()=>lark.init(),configureSyncInterval:interval=>lark.configureSyncInterval(interval),
      configure:host=>{
        const route=(method:'GET'|'POST'|'PUT'|'DELETE',path:`/api/connectors/${string}`,handler:OwnerRoute['handler'])=>host.ownerRoute({method,path,bodyLimit:16384,handler});
        route('GET','/api/connectors/lark',()=>lark.status());
        route('POST','/api/connectors/lark/check',()=>lark.refresh());
        route('POST','/api/connectors/lark/install',()=>lark.startInstall());
        route('POST','/api/connectors/lark/setup',()=>lark.startSetup());
        route('POST','/api/connectors/lark/configure',req=>lark.configure(req.body));
        route('POST','/api/connectors/lark/login',req=>lark.login(z.object({calendar:z.boolean().optional()}).strict().parse(req.body??{}).calendar??false));
        route('POST','/api/connectors/lark/write/start',()=>lark.startWriteAuthorization());
        route('POST','/api/connectors/lark/write/disconnect',()=>lark.disconnectWriteAuthorization());
        route('POST','/api/connectors/lark/cancel',()=>lark.cancel());
        route('GET','/api/connectors/lark/calendars',()=>lark.calendars());
        route('PUT','/api/connectors/lark/selection',req=>lark.select(req.body));
        route('POST','/api/connectors/lark/preview',()=>lark.startPreview());
        route('POST','/api/connectors/lark/sync',req=>lark.startSync(z.object({document:z.string().trim().min(1).max(4000).optional()}).strict().parse(req.body??{}).document));
        route('DELETE','/api/connectors/lark',()=>lark.disconnect());
      },
      close:()=>lark.close(),
    };
  }};
}
