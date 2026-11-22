import {moteText} from './i18n.js';

/** Only authored protocol codes may select recovery advice. Response text is
 * untrusted and may contain provider details, credentials or proxy HTML. */
export function responseFailureCode(value:unknown):string|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return;
  const body=value as Record<string,unknown>;
  const error=body.error&&typeof body.error==='object'?(body.error as Record<string,unknown>).code:body.error;
  return [body.reason,body.code,error].find((code):code is string=>typeof code==='string'&&/^[a-z][a-z0-9_.-]{0,99}$/.test(code));
}

export function commonFailureMessage(code:string,status?:number):string|undefined {
  switch(code){
    case 'origin_denied': return moteText('网页地址未获中央允许。检查公开地址和反向代理。');
    case 'unauthorized': case 'connection_revoked':
      return moteText('访问凭据已失效。重新连接。');
    case 'forbidden': case 'connection_scope_denied': return moteText('当前连接无此权限。检查权限。');
    case 'login_expired': return moteText('登录已过期或失效。重新发起登录。');
    case 'invitation_invalid_or_expired': return moteText('邀请无效、已使用或已过期。在中央重新生成。');
    case 'invitation_device_mismatch':
      return moteText('邀请失效、已使用或不匹配。重新生成。');
    case 'login_pending': return moteText('登录待确认。在浏览器授权。');
    case 'google_not_connected': return moteText('Google 账号未连接。到来源设置授权。');
    case 'incompatible_protocol': return moteText('网页或客户端与中央的协议版本不匹配。');
    case 'invalid_request': case 'json_required': return moteText('输入格式无效，请检查必填项和取值范围。');
    case 'invalid_response': return moteText('中央响应格式无效。刷新后重试。');
    case 'invalid_data': return status===413?httpStatusMessage(status):moteText('请求无效。核对输入和操作状态。');
    case 'config_invalid': return moteText('配置无效。检查必填项和取值。');
    case 'config_conflict': case 'model_settings_conflict': return moteText('配置或操作状态已变。刷新后确认。');
    case 'invalid_cursor': return moteText('分页已变化或游标失效。返回第一页。');
    case 'not_found': case 'connection_not_found': case 'task_not_found': case 'connector_not_found':
      return moteText('请求的资源不存在或已删除。');
    case 'scope_unavailable': return status===403?httpStatusMessage(status):moteText('所需服务暂不可用。');
    case 'config_unavailable': case 'authentication_closed': case 'processing_closed': case 'actions_settings_unavailable':
      return moteText('所需服务暂不可用。');
  }
}

export function httpStatusMessage(status:number):string {
  switch(status){
    case 401: return moteText('中央未接受当前登录身份（401）。登录信息可能已失效。');
    case 403: return moteText('访问被拒绝（403）。检查连接权限与访问设置。');
    case 404: return moteText('接口或资源不存在。核对中央地址和操作。');
    case 408: case 504: return moteText('请求超时（{0}）。核对中央和网络。',status);
    case 409: return moteText('操作状态已变。刷新后确认。');
    case 410: return moteText('操作或资源已失效。刷新后确认。');
    case 413: return moteText('请求内容超过中央或公网入口的大小限制（413）。');
    case 426: return moteText('网页或客户端与中央的协议版本不匹配。');
    case 429: return moteText('请求频繁。稍后再试。');
    case 502: return moteText('入口无法连接中央（502）。检查中央和转发配置。');
    case 503: return moteText('中央服务暂不可用（503）。查看中央状态。');
    case 524: return moteText('入口响应超时（524）。查看节点诊断。');
    default: return moteText('请求未完成（{0}）',status);
  }
}

export function httpFailureMessage(status:number,code?:string):string {
  return code&&/^[a-z][a-z0-9_.-]{0,99}$/.test(code)?(commonFailureMessage(code,status)??moteText('请求未完成（{0}）。错误码：{1}',status,code)):httpStatusMessage(status);
}
