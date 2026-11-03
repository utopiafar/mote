import {moteText} from '@mote/shared/i18n';
import type { OperationDetail, WorkActivity } from '@mote/shared';
import type { Api } from '../../api';
import { errorMessage } from '../../api';
import { failureMessage } from '../../failure-message';
import { useResource } from '../../useResource';
import { modelSetupHref } from '../../ModelStartGuide';
const hints: Record<string, {
    text: string;
    category?: 'providers' | 'model' | 'images' | 'file-processing';
}> = {
    model_unconfigured: { text: '此步骤需要的模型连接尚未配置。', category: 'providers' },
    model_not_configured: { text: '此步骤需要的模型连接尚未配置。', category: 'providers' },
    provider_not_configured: { text: '此步骤需要的模型服务尚未配置。', category: 'providers' },
    processor_not_configured: { text: '此步骤的处理插件或服务尚未配置。', category: 'file-processing' },
    processing_disabled: { text: '处理队列当前已停用。', category: 'file-processing' },
    awaiting_confirmation: { text: '此步骤在等待你确认。请查看下方已有问题或相关资料。' },
    dependency_failed: { text: '依赖步骤未完成，请先核对上游处理状态。' },
    processor_version_unavailable: { text: '所需处理器版本当前不可用，请核对当前插件与来源处理。' },
};
export function WorkIssueNotice({ api, work, hideUnknownCode=false }: {
    api: Api;
    work: WorkActivity;
    hideUnknownCode?: boolean;
}) {
    const operationId = work.technical.operationIds[0];
    const selected = ['needs_input', 'failed', 'stale'].includes(work.state);
    const read = useResource<OperationDetail>(api, selected && operationId ? '/api/operations/' + encodeURIComponent(operationId) + '?limit=100' : null, 3000);
    if (!selected)
        return null;
    const step = read.data?.steps.find(item => item.current && !item.notScheduled && ['blocked', 'failed', 'stale', 'waiting'].includes(item.state) && item.reason);
    const code = step?.reason;
    const known = code ? hints[code] : undefined;
    const modelDependency = code && ['model_unconfigured', 'model_not_configured', 'provider_not_configured'].includes(code);
    const localMissing = code && ['model_missing', 'not_installed'].includes(code);
    const localCategory = localMissing && step ? ['images.ocr', 'perception.ocr'].includes(step.kind) ? 'images' : ['files.pipeline', 'file-step'].includes(step.kind) ? 'file-processing' : undefined : undefined;
    const category = known?.category ?? localCategory;
    const currentWork = '#/activity?work=' + encodeURIComponent(work.id);
    const failure=code?failureMessage(code):undefined;
    // Only the formatter's explicit opaque-code fallback is collapsed. Known
    // explanations and recovery links keep their existing protocol mapping.
    const explanation=hideUnknownCode&&code&&failure===moteText('操作未完成。错误码：{0}',code)?moteText("目前还没有明确的处理原因。"):failure;
    const title = read.loading && !read.data ? moteText("正在读取等待原因…") : code ? (known ? moteText(known.text) : explanation) : read.error ? moteText("具体原因暂时无法读取。") : moteText("目前还没有明确的处理原因。");
    return <section className="discovery-work-issue" aria-label={moteText("工作需要处理的原因")}><h2>{work.state === 'failed' ? moteText("未完成的原因") : moteText("当前需要处理的原因")}</h2><p role="status">{title}</p>{work.technical.operationIds.length > 1 && <p className="fine-print">{moteText("这里仅核对首个关联执行记录；还有 {0} 个关联记录，可在技术详情继续查看。已有补充问题单独显示在下方。",work.technical.operationIds.length-1)}</p>}{code && <p className="fine-print">{moteText("原件归档、正文处理、索引与记忆状态分别核对。")}</p>}
  {modelDependency && <><p>{moteText("先保存或检查已有模型连接，再检查这项任务对应的模块；回到原任务，按它当前提供的操作继续。")}</p><div className="source-toolbar"><a className="button" href={modelSetupHref('providers', currentWork)}>{moteText("检查模型连接")}</a><a className="text-button" href={modelSetupHref('model', currentWork)}>{moteText("检查 / 分配对应模块 →")}</a></div></>}
  {!modelDependency && category && <a className="button" href={'#/system/models?category=' + category + '&returnTo=' + encodeURIComponent(currentWork)}>{moteText("查看{0}",category === 'images' ? moteText("图片处理设置") : category === 'file-processing' ? moteText("文件与语音设置") : moteText("模型连接设置"))}</a>}
  {!code && (!read.loading || read.data !== undefined) && <p className="fine-print">{moteText("可继续查看下方补充问题或相关资料。具体步骤与未读取部分在「技术详情」中核对。")}</p>}
  {code && <details><summary>{moteText("查看原因代码与步骤标识")}</summary><code>{code}</code><p className="discovery-technical-id">{step?.kind} · {step?.id}</p>{read.data?.nextCursor != null && <p>{moteText("仍有后续步骤，技术执行记录中可继续翻页。")}</p>}</details>}
  {read.error !== undefined && <details><summary>{moteText("读取状态")}</summary><p>{errorMessage(read.error)}</p><button className="text-button" onClick={read.refresh}>{moteText("重新读取原因")}</button></details>}
 </section>;
}
