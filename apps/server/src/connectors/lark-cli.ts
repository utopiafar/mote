import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {ConnectorError} from './types.js';

export const LARK_VERSION='1.0.57';
export type LarkCommand =
  | {kind:'version'|'status'|'install'|'setup'}
  | {kind:'configure';appId:string;secret:string;brand:'feishu'|'lark'}
  | {kind:'login';scopes:string[]}
  | {kind:'complete';deviceCode:string}
  | {kind:'calendars';pageToken?:string}
  | {kind:'events';calendarId:string;start:number;end:number}
  | {kind:'document';document:string};
export type LarkRunner=(command:LarkCommand,options?:{signal?:AbortSignal;onOutput?:(chunk:string)=>void})=>Promise<string>;

/** Only fixed operations are executable. Neither the browser nor an agent supplies argv. */
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
    case 'document':return ['docs','+fetch','--api-version','v2','--as','user','--doc',command.document,'--doc-format','markdown','--format','json'];
    case 'install':throw new ConnectorError('lark_command_invalid');
  }
}
export function authorizationUrl(value:string):string|undefined{
  try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password&&u.port===''&&['feishu.cn','larksuite.com','larkoffice.com'].some(d=>u.hostname===d||u.hostname.endsWith(`.${d}`)))return value;}catch{}
}
export function larkJson(raw:string):any{
  try{const value=JSON.parse(raw);if(value?.ok===false||(typeof value?.code==='number'&&value.code!==0))throw Error();return value;}catch{throw new ConnectorError('lark_response_invalid',502);}
}
export function createLarkRunner(directory:string):LarkRunner{
  const root=resolve(directory,'lark-runtime'),configDir=join(root,'config'),runtime=join(root,'package');
  return async(command,options={})=>{
    await mkdir(configDir,{recursive:true,mode:0o700});await chmod(root,0o700);await chmod(configDir,0o700);
    // Do not inherit another agent's identity, credential, profile or policy overrides.
    const env:NodeJS.ProcessEnv={};
    for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TMPDIR','TMP','TEMP','LANG','LC_ALL','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'])if(process.env[key])env[key]=process.env[key];
    Object.assign(env,{LARKSUITE_CLI_CONFIG_DIR:configDir,LARKSUITE_CLI_DATA_DIR:join(root,'credentials'),LARKSUITE_CLI_LOG_DIR:join(root,'logs'),CI:'1',NO_COLOR:'1'});
    const local=join(runtime,'node_modules','@larksuite','cli','scripts','run.js');
    const installing=command.kind==='install';
    const executable=installing?'npm':existsSync(local)?process.execPath:'lark-cli';
    const args=installing?['install','--prefix',runtime,`@larksuite/cli@${LARK_VERSION}`,'--registry=https://registry.npmjs.org','--no-audit','--no-fund']:existsSync(local)?[local,...larkArguments(command)]:larkArguments(command);
    const timeout=['setup','complete'].includes(command.kind)?610000:installing?180000:60000;
    return new Promise<string>((ok,fail)=>{
      let stdout='',stderr='',size=0,settled=false;
      const child=spawn(executable,args,{cwd:root,env,shell:false,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
      const stop=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
      const finish=(error?:ConnectorError)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);error?fail(error):ok(stdout);};
      const abort=()=>{stop();finish(new ConnectorError('lark_operation_cancelled',409));};
      const timer=setTimeout(()=>{stop();finish(new ConnectorError('lark_operation_timeout',504));},timeout);
      options.signal?.addEventListener('abort',abort,{once:true});
      if(options.signal?.aborted)abort();
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      const read=(chunk:string,isError:boolean)=>{size+=Buffer.byteLength(chunk);if(size>8*1024*1024){stop();finish(new ConnectorError('lark_output_too_large',413));return;}const text=chunk;if(isError)stderr+=text;else stdout+=text;options.onOutput?.(text);};
      child.stdout.on('data',chunk=>read(chunk,false));child.stderr.on('data',chunk=>read(chunk,true));
      child.on('error',error=>finish(new ConnectorError((error as NodeJS.ErrnoException).code==='ENOENT'?'lark_cli_missing':'lark_process_failed',503)));
      child.on('close',code=>{
        if(code===0)return finish();
        // Error text may contain credentials or personal content. Return fixed codes only.
        let problem:{type?:string;subtype?:string;code?:number}={};for(const text of [stderr,stdout])try{problem=JSON.parse(text).error??{};break;}catch{}
        const error=problem.type==='authorization'?'lark_permission_required':problem.type==='authentication'?'lark_not_connected':problem.subtype==='not_configured'?'lark_not_configured':problem.code===193104?'lark_event_limit':'lark_command_failed';
        finish(new ConnectorError(error,502));
      });
      child.stdin.on('error',()=>{});child.stdin.end(command.kind==='configure'?command.secret:undefined);
    });
  };
}
