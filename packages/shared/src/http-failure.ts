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
    case 'invalid_login': return moteText('用户名或密码不正确，请重新登录。');
    case 'origin_denied': return moteText('当前网页地址未获中央节点允许，请检查公开地址与反向代理配置。');
    case 'csrf_required': return moteText('登录校验已失效，请刷新页面并重新登录。');
    case 'session_changed': return moteText('登录会话已改变，请重新登录。');
    case 'identity_required': case 'unauthorized': case 'connection_revoked': case 'session_binding_required':
      return moteText('访问凭据已失效，请重新连接。');
    case 'invalid_identity': return status===403?moteText('当前登录没有执行此操作的权限，请确认账号和连接权限。'):moteText('访问凭据已失效，请重新连接。');
    case 'forbidden': case 'connection_scope_denied': return moteText('当前登录没有执行此操作的权限，请确认账号和连接权限。');
    case 'login_throttled': return moteText('登录尝试过于频繁，请稍后再试。');
    case 'login_busy': case 'login_capacity': return moteText('中央节点正在处理其他登录请求，请稍后再试。');
    case 'login_expired': return moteText('登录请求已失效或过期，请重新发起登录。');
    case 'invitation_invalid_or_expired': return moteText('邀请无效、已使用或已过期，请在中央重新生成');
    case 'invitation_subject_mismatch': case 'invitation_device_mismatch': case 'invitation_claim_changed':
      return moteText('邀请已失效、已使用或不匹配，请重新生成。');
    case 'login_owner_changed': return moteText('此登录请求已由其他账号确认，请重新发起登录。');
    case 'login_pending': return moteText('登录请求尚未获确认，请先在浏览器中完成授权。');
    case 'google_not_connected': return moteText('尚未连接 Google 账号，请在对应来源设置中完成授权。');
    case 'incompatible_protocol': return moteText('网页或客户端与中央节点的协议版本不匹配，请使用匹配版本。');
    case 'invalid_request': case 'json_required': return moteText('输入格式无效，请检查必填项和取值范围。');
    case 'invalid_response': return moteText('中央响应格式无效，请刷新后重试。');
    case 'invalid_data': return status===413?httpStatusMessage(status):moteText('请求内容无效，请检查输入和当前操作状态。');
    case 'config_invalid': return moteText('配置内容无效，请检查必填项和取值范围。');
    case 'config_conflict': case 'model_settings_conflict': return moteText('配置或相关操作状态已变化，请重新读取后再确认。');
    case 'invalid_cursor': return moteText('分页内容已变化或游标无效，请返回第一页重新读取。');
    case 'username_unavailable': return moteText('此用户名已被使用，请选择其他用户名。');
    case 'last_administrator': return moteText('不能停用最后一个启用的管理员账号。');
    case 'not_found': case 'account_not_found': case 'credential_not_found': case 'task_not_found': case 'connector_not_found':
      return moteText('请求的资源不存在或已删除。');
    case 'scope_unavailable': return status===403?httpStatusMessage(status):moteText('所需服务暂不可用，请检查中央节点状态后重试。');
    case 'config_unavailable': case 'authentication_closed': case 'processing_closed': case 'actions_settings_unavailable':
      return moteText('所需服务暂不可用，请检查中央节点状态后重试。');
  }
}

export function httpStatusMessage(status:number):string {
  switch(status){
    case 401: return moteText('中央节点未接受当前登录身份（401），请检查登录信息后重试。');
    case 403: return moteText('请求被拒绝（403），请检查账号权限和入口访问配置。');
    case 404: return moteText('请求的接口或资源不存在，请检查节点地址和当前操作。');
    case 408: case 504: return moteText('请求等待超时（{0}），请检查节点和网络状态后重试。',status);
    case 409: return moteText('操作状态已变化，请重新读取后再确认。');
    case 410: return moteText('请求的操作或资源已失效，请重新读取后再确认。');
    case 413: return moteText('请求内容超过中央节点或公网入口的大小限制（413），请减少本次提交内容后重试。');
    case 426: return moteText('网页或客户端与中央节点的协议版本不匹配，请使用匹配版本。');
    case 429: return moteText('请求过于频繁，请稍后再试。');
    case 502: return moteText('入口暂时无法连接中央服务（502），请检查节点运行状态和入口转发配置。');
    case 503: return moteText('中央服务暂不可用（503），请检查节点状态后重试。');
    case 524: return moteText('入口等待服务响应超时（524）。请检查节点运行诊断；较慢的模型请求可能超过代理等待上限。');
    default: return moteText('请求未完成（{0}）',status);
  }
}

export function httpFailureMessage(status:number,code?:string):string {
  return code?(commonFailureMessage(code,status)??moteText('请求未完成（{0}）。错误码：{1}',status,code)):httpStatusMessage(status);
}
