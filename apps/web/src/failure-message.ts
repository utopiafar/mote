import {moteText} from '@mote/shared/i18n';
/** Display follows protocol codes, never provider text or semantic matching. The
 * server's allowedActions remains the authority for recovery controls. */
const messages:Record<string,string>={
 ocr_worker_unavailable:'本地 OCR 服务正在准备，恢复后将自动继续。',
 model_profile_missing:'所选模型配置不存在，请重新选择。',
 model_profile_read_only:'部署配置为只读，请复制为新预设后编辑。',
 model_profile_in_use:'该配置仍是某项功能的默认模型，请先修改功能默认值。',
 model_settings_invalid:'模型配置无效，请检查填写的参数。',
 model_settings_conflict:'模型设置已发生变化，请刷新后重试。',
 model_settings_credential_reuse:'服务商、协议或地址已改变，请确认复用已有凭据，或替换、清除已有凭据。',
 model_settings_unavailable:'模型设置暂不可用，请检查服务状态后重试。',
 model_settings_prepare_failed:'无法准备新的模型配置，原配置保持使用。',
 model_settings_save_failed:'模型设置未能保存，原配置保持使用。',
 model_settings_commit_uncertain:'模型设置保存结果需要重新确认，请刷新设置后重试。',
 validation:'输入格式无效，请检查必填项和取值范围。',conflict:'资料状态已变化或当前配置不支持此操作，请刷新后重试。',deleted:'该条目已删除，排队重试不能恢复它。',too_large:'内容超过大小限制，请分批处理。',unavailable:'服务暂不可用，请检查节点状态与模型配置。',storage_full:'存储容量已满，请清理空间或调整容量限制。',internal:'请求未完成，请使用请求编号查看诊断记录。',model_not_configured:'Agent 未配置，请在中央节点配置模型后重试。',

 actions_disabled:'日程分析未开启，请检查发现设置。',actions_closed:'日程分析服务已停止，请检查节点状态。',action_settings_changed:'日程分析设置已变化，请重新分析。',action_analysis_failed:'日程分析未完成，请查看批次状态后重试。',invalid_action_output:'模型返回的日程建议未通过校验，请重试分析。',
 provider_failed:'模型服务未完成请求，请查看任务状态。',model_failed:'模型服务未完成请求，请查看任务状态。',agent_response:'模型返回的结果未通过校验。',
 timeout:'请求等待超时，请查看任务状态。',provider_timeout:'请求等待超时，请查看任务状态。',network:'连接暂时中断，请检查网络。',provider_network:'连接暂时中断，请检查网络。',rate_limited:'模型服务暂时限流，请等待任务更新。',
 provider_unavailable:'模型服务暂时不可用，请检查服务配置。',provider_quota:'模型服务额度不足，请补充额度后继续。',
 model_token_budget:'当前 token 预算不足，请检查预算设置。',model_cost_budget:'当前金额预算不足，请检查预算设置。',daily_budget:'本日处理预算不足，请检查预算设置。',
 budget_price_required:'请先设置与预算币种一致的模型价格。',budget_unbounded_runtime:'当前模型运行方式无法保证硬预算，请调整预算或模型配置。',model_budget_unavailable:'暂时无法读取模型预算，请查看任务状态。',
 configuration_changed:'模型配置已变化，请在任务中心确认后继续；已完成的步骤会保留。',model_unconfigured:'请先完成模型配置。',
 provider_authentication:'模型服务认证失败，请检查凭据。',provider_endpoint:'模型服务地址不正确，请检查配置。',provider_redirect:'模型服务重定向未获允许，请检查地址配置。',
 worker_offline:'处理服务离线，请检查服务状态。',worker_interrupted:'处理曾中断，请查看任务中心的恢复状态。',interrupted:'运行已中断，请查看历史结果后重新发起。',
 recovery_window_exhausted:'自动恢复期限已结束，请在任务中心手动重试。',awaiting_confirmation:'等待你确认后继续。',evidence_changed:'原始资料已变化，此结果不能发布，请重新处理。',
 cancelled:'已停止',cancelled_by_user:'已停止',unauthorized:'访问凭据已失效，请重新连接。',forbidden:'当前连接没有访问权限。',not_found:'资料不存在或已删除。',
};
export function failureMessage(failure?:{code?:string;message?:string;safeMessage?:string}|string|null):string{
 const code=typeof failure==='string'?failure:failure?.code;
 if(code&&Object.hasOwn(messages,code))return moteText(messages[code]);
 return code&&/^[a-z][a-z0-9_.-]{0,99}$/.test(code)?moteText('操作未完成。错误码：{0}',code):moteText('请求未完成，请稍后重试。');
}
