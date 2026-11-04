import {moteText} from '../i18n.js';
import type {ConnectorManifest} from '../connectors/registry.js';
import {GoogleCalendarConnector,type GoogleDependencies} from '../connectors/google.js';
import {googleCalendarContext} from '../connectors/google-context.js';

export type {GoogleDependencies};

/** C13A's Google Calendar connector. This module owns connectors/google.ts and
 * google-context.ts: the producer, its private credentials file, calendar
 * selection and page checkpoints live and die with the instance. It runs as one
 * instance under the connector host adapter, which supplies the install scope,
 * owner routes, OAuth callbacks, host-bound state and per-instance stop/restart. */
export function googleCalendarManifest(dependencies?:GoogleDependencies):ConnectorManifest {
  return {apiVersion:1,id:'google-calendar',sourceKinds:['google-calendar'],statusKey:'google',create:ctx=>{
    const google=new GoogleCalendarConnector(googleCalendarContext(ctx),dependencies);
    return {
      init:()=>google.init(),status:()=>google.status(),configureSyncInterval:interval=>google.configureSyncInterval(interval),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/google/start',handler:()=>google.start()});
        host.ownerRoute({method:'GET',path:'/api/connectors/google/calendars',handler:()=>google.calendars()});
        host.ownerRoute({method:'PUT',path:'/api/connectors/google/calendars',handler:req=>google.select(req.body)});
        host.ownerRoute({method:'POST',path:'/api/connectors/google/sync',handler:()=>google.sync()});
        host.ownerRoute({method:'DELETE',path:'/api/connectors/google',handler:()=>google.disconnect()});
        host.oauthCallback({path:'/oauth/google/callback',complete:(state,code)=>google.callback(state,code),successMessage:moteText('Google 日历已连接。请返回 Mote 选择需要同步的日历。'),failureMessage:moteText('授权未完成或已过期。请返回 Mote 重新连接 Google 日历。')});
      },
      close:()=>google.close(),
    };
  }};
}
