import {spawn} from 'node:child_process';
import {cliReleases,managedCliBinary} from './cli-runtime.mjs';
import {mkdir,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ConnectorError} from './types.js';

export const LARK_VERSION=cliReleases.lark.version;
export type LarkCommand =
  | {kind:'version'|'status'|'install'|'setup'}
  | {kind:'configure';appId:string;secret:string;brand:'feishu'|'lark'}
  | {kind:'login';scopes:string[]}
  | {kind:'complete';deviceCode:string}
  | {kind:'calendars';pageToken?:string}
  | {kind:'events';calendarId:string;start:number;end:number}
  | {kind:'calendar-event-create';calendarId:string;data:Record<string,unknown>}
  | {kind:'calendar-event-update';calendarId:string;eventId:string;data:Record<string,unknown>}
  | {kind:'calendar-event-delete';calendarId:string;eventId:string}
  | {kind:'document';document:string}
  | {kind:'documents-search';action:'created'|'edited'|'opened';start:string;end:string;pageToken?:string}
  | {kind:'folder-list';folder:string;pageToken?:string}
  | {kind:'wiki-node';node:string}
  | {kind:'wiki-list';spaceId:string;parent:string;pageToken?:string}
  | {kind:'minutes-search';start:string;end:string;pageToken?:string}
  | {kind:'minutes-metadata';id:string}
  | {kind:'minutes-transcript';id:string}
  | {kind:'minutes-media';id:string;output:string}
  | {kind:'im-chats';pageToken?:string;pageSize?:number}
  | {kind:'im-messages';chatId:string;startTime?:string;endTime?:string;pageToken?:string;pageSize?:number}
  | {kind:'im-send';chatId:string;text:string;uuid?:string};
export type LarkRunner=(command:LarkCommand,options?:{signal?:AbortSignal;onOutput?:(chunk:string)=>void})=>Promise<string>;

/** Only fixed operations are executable. Neither the browser nor an agent supplies argv. */
const imId=(value:string)=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)?value:(()=>{throw new ConnectorError('lark_command_invalid');})();
export function larkArguments(command:LarkCommand):string[]{
  switch(command.kind){
    case 'version':return ['--version'];
    case 'status':return ['auth','status','--json'];
    case 'setup':return ['config','init','--new'];
    case 'configure':return ['config','init','--app-id',command.appId,'--app-secret-stdin','--brand',command.brand];
    case 'login':return ['auth','login','--scope',command.scopes.join(' '),'--no-wait','--json'];
    case 'complete':return ['auth','login','--device-code',command.deviceCode,'--json'];
    case 'calendars':return ['calendar','calendars','list','--as','user','--format','json','--params',JSON.stringify({page_size:100,...(command.pageToken?{page_token:command.pageToken}:{})})];
    case 'events':return ['calendar','events','instance_view','--as','user','--format','json','--params',JSON.stringify({calendar_id:command.calendarId,start_time:String(command.start),end_time:String(command.end)})];
    // Event writes use one fixed path per operation. Callers never supply a
    // method, API root or arbitrary path; the host action dispatcher owns them.
    case 'calendar-event-create':return ['api','POST',`/open-apis/calendar/v4/calendars/${encodeURIComponent(command.calendarId)}/events`,'--data',JSON.stringify(command.data),'--as','user','--format','json'];
    case 'calendar-event-update':return ['api','PATCH',`/open-apis/calendar/v4/calendars/${encodeURIComponent(command.calendarId)}/events/${encodeURIComponent(command.eventId)}`,'--data',JSON.stringify(command.data),'--as','user','--format','json'];
    case 'calendar-event-delete':return ['api','DELETE',`/open-apis/calendar/v4/calendars/${encodeURIComponent(command.calendarId)}/events/${encodeURIComponent(command.eventId)}`,'--as','user','--format','json'];
    case 'document':return ['docs','+fetch','--api-version','v2','--as','user','--doc',command.document,'--doc-format','markdown','--format','json'];
    case 'documents-search':return ['drive','+search','--query','','--doc-types','docx,wiki','--page-size','20',...(command.action==='created'?['--created-by-me']:[]),`--${command.action}-since`,command.start,`--${command.action}-until`,command.end,...(command.pageToken?['--page-token',command.pageToken]:[]),'--as','user','--format','json'];
    case 'folder-list':return ['drive','files','list','--params',JSON.stringify({folder_token:command.folder,page_size:200,...(command.pageToken?{page_token:command.pageToken}:{})}),'--as','user','--format','json'];
    case 'wiki-node':return ['wiki','spaces','get_node','--params',JSON.stringify({token:command.node}),'--as','user','--format','json'];
    case 'wiki-list':return ['wiki','nodes','list','--params',JSON.stringify({space_id:command.spaceId,parent_node_token:command.parent,page_size:50,...(command.pageToken?{page_token:command.pageToken}:{})}),'--as','user','--format','json'];
    case 'minutes-search':return ['minutes','+search','--owner-ids','me','--start',command.start,'--end',command.end,'--page-size','30',...(command.pageToken?['--page-token',command.pageToken]:[]),'--as','user','--format','json'];
    case 'minutes-metadata':return ['minutes','minutes','get','--params',JSON.stringify({minute_token:command.id}),'--as','user','--format','json'];
    // +detail flattens per-minute API errors into prose in a batch envelope.
    // The same read endpoint preserves typed errors and the original text.
    case 'minutes-transcript':return ['api','GET',`/open-apis/minutes/v1/minutes/${encodeURIComponent(command.id)}/artifacts`,'--as','user','--format','json'];
    case 'minutes-media':return ['minutes','+download','--minute-tokens',command.id,'--output',command.output,'--as','user','--format','json'];
    // IM reads and one send path stay on raw API commands with fixed query and
    // body shapes. No caller supplies a path, method or arbitrary argument.
    case 'im-chats':return ['api','GET','/open-apis/im/v1/chats','--params',JSON.stringify({user_id_type:'open_id',sort_type:'ByActiveTimeDesc',page_size:command.pageSize??100,types:'group,p2p',...(command.pageToken?{page_token:command.pageToken}:{})}),'--as','user','--format','json'];
    case 'im-messages':return ['api','GET','/open-apis/im/v1/messages','--params',JSON.stringify({container_id_type:'chat',container_id:imId(command.chatId),...(command.startTime?{start_time:command.startTime}:{}),...(command.endTime?{end_time:command.endTime}:{}),sort_type:'ByCreateTimeAsc',page_size:command.pageSize??50,...(command.pageToken?{page_token:command.pageToken}:{})}),'--as','user','--format','json'];
    case 'im-send':return ['api','POST','/open-apis/im/v1/messages','--params',JSON.stringify({receive_id_type:'chat_id'}),'--data',JSON.stringify({receive_id:imId(command.chatId),msg_type:'text',content:JSON.stringify({text:command.text}),...(command.uuid?{uuid:command.uuid}:{})}),'--as','user','--format','json'];
    case 'install':throw new ConnectorError('lark_command_invalid');
  }
}
export function authorizationUrl(value:string):string|undefined{
  try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password&&u.port===''&&['feishu.cn','larksuite.com','larkoffice.com'].some(d=>u.hostname===d||u.hostname.endsWith(`.${d}`)))return value;}catch{}
}
export function larkJson(raw:string):any{
  try{const value=JSON.parse(raw);if(value?.ok===false||(typeof value?.code==='number'&&value.code!==0))throw Error();return value;}catch{throw new ConnectorError('lark_response_invalid',502);}
}
export function createLarkRunner(directory:string,optionsConfig:{localProfile?:boolean;binary?:string}={}):LarkRunner{
  const root=resolve(directory,'lark-runtime'),configDir=join(root,'config');
  const execute:LarkRunner=async(command,options={})=>{
    await mkdir(configDir,{recursive:true,mode:0o700});await chmod(root,0o700);await chmod(configDir,0o700);
    // Do not inherit another agent's identity, credential, profile or policy overrides.
    const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TMPDIR','TMP','TEMP','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[key])env[key]=process.env[key];
    Object.assign(env,{CI:'1',NO_COLOR:'1',LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'});
    if(!optionsConfig.localProfile)Object.assign(env,{LARKSUITE_CLI_CONFIG_DIR:configDir,LARKSUITE_CLI_DATA_DIR:join(root,'credentials'),LARKSUITE_CLI_LOG_DIR:join(root,'logs')});
    if(command.kind==='install')throw new ConnectorError('lark_cli_deployment_required',503);
    let executable:string;try{executable=optionsConfig.binary??managedCliBinary('lark');}catch{throw new ConnectorError('lark_cli_platform_unsupported',503);}
    const args=larkArguments(command);
    const timeout=['setup','complete'].includes(command.kind)?610000:command.kind==='minutes-media'?300000:60000;
    // JSON escaping and the other artifact fields must not shrink the existing
    // 16 MiB decoded transcript limit, which the adapter enforces separately.
    const maxOutputBytes=(command.kind==='minutes-transcript'?128:8)*1024*1024;
    return new Promise<string>((ok,fail)=>{
      let stdout='',stderr='',size=0,settled=false,terminal:ConnectorError|undefined;
      const child=spawn(executable,args,{cwd:root,env,shell:false,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
      const stop=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      const finish=(error?:ConnectorError)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);error?fail(error):ok(stdout);};
      const abort=()=>{terminal??=new ConnectorError('lark_operation_cancelled',409);stop();};
      const timer=setTimeout(()=>{terminal??=new ConnectorError('lark_operation_timeout',504);stop();},timeout);
      options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      const read=(chunk:string,isError:boolean)=>{if(terminal)return;size+=Buffer.byteLength(chunk);if(size>maxOutputBytes){terminal=new ConnectorError('lark_output_too_large',413);stop();return;}const text=chunk;if(isError)stderr+=text;else stdout+=text;try{options.onOutput?.(text);}catch{terminal=new ConnectorError('lark_operation_cancelled',409);stop();}};
      child.stdout.on('data',chunk=>read(chunk,false));child.stderr.on('data',chunk=>read(chunk,true));
      child.on('error',error=>finish(new ConnectorError((error as NodeJS.ErrnoException).code==='ENOENT'?'lark_cli_missing':'lark_process_failed',503)));
      child.on('close',code=>{
        if(terminal)return finish(terminal);
        if(code===0)return finish();
        // Error text may contain credentials or personal content. Return fixed codes only.
        let problem:{type?:string;subtype?:string;code?:number}={};for(const text of [stderr,stdout])try{problem=JSON.parse(text).error??{};break;}catch{}
        const error=command.kind==='minutes-transcript'&&problem.code===2091003?'recording_transcript_not_ready':problem.type==='authorization'?'lark_permission_required':problem.type==='authentication'?'lark_not_connected':problem.subtype==='not_configured'?'lark_not_configured':problem.type==='api'&&(problem.subtype==='rate_limit'||problem.code===99991400)?'lark_rate_limited':problem.code===193104?'lark_event_limit':'lark_command_failed';
        finish(new ConnectorError(error,502));
      });
      child.stdin.on('error',()=>{});child.stdin.end(command.kind==='configure'?command.secret:undefined);
    });
  };
  let verified:Promise<void>|undefined;
  return async(command,options)=>{
    if(!['version','install'].includes(command.kind))await(verified??=execute({kind:'version'},options).then(value=>{if(value.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]!==LARK_VERSION)throw new ConnectorError('lark_cli_version_unsupported',503);}).catch(error=>{verified=undefined;throw error;}));
    return execute(command,options);
  };
}
